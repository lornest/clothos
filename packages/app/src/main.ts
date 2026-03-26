import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileSystem } from '@clothos/agent-runtime';
import type { Logger } from '@clothos/core';
import { loadConfig, applyEnvOverrides } from '@clothos/core';
import { PiMonoProvider, getModel } from '@clothos/agent-runtime';
import { bootstrap } from './bootstrap.js';
import { getOrRefreshApiKey, getOAuthProviderForName } from './oauth-manager.js';
import { runLogin } from './cli-login.js';

function createNodeFs(): FileSystem {
  return {
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(filePath, 'utf-8');
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      await fs.writeFile(filePath, content, 'utf-8');
    },
    async appendFile(filePath: string, content: string): Promise<void> {
      await fs.appendFile(filePath, content, 'utf-8');
    },
    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(dirPath, { recursive: options?.recursive ?? false });
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async readdir(dirPath: string): Promise<string[]> {
      return fs.readdir(dirPath);
    },
  };
}

function createLogger(): Logger {
  return {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.warn(`[WARN] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
    debug: (msg: string) => console.debug(`[DEBUG] ${msg}`),
  };
}

async function main(): Promise<void> {
  const configPath = process.env['CLOTHOS_CONFIG']
    ?? path.resolve(process.cwd(), 'config/default.json5');
  const basePath = process.env['CLOTHOS_BASE']
    ?? path.join(process.env['HOME'] ?? '~', '.clothos');

  const logger = createLogger();
  const nodeFs = createNodeFs();

  // 1. Load and validate config (supports both sparse UserConfig and legacy full format)
  const result = loadConfig(configPath);
  if (!result.valid || !result.config) {
    const errorMessages = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }
  // Apply env overlays for legacy configs (UserConfig overlays are applied during loadConfig)
  const config = applyEnvOverrides(result.config);

  // 2. Handle --login flag for OAuth providers
  if (process.argv.includes('--login')) {
    const loginProvider = process.env['CLOTHOS_PROVIDER']
      ?? config.auth.profiles[0]?.provider
      ?? 'openai';
    await runLogin(loginProvider, basePath);
    process.exit(0);
  }

  // 3. Set up LLM provider from resolved config
  // CLOTHOS_PROVIDER and CLOTHOS_MODEL env vars override config for backward compatibility
  const providerName = process.env['CLOTHOS_PROVIDER']
    ?? config.auth.profiles[0]?.provider
    ?? 'anthropic';
  const modelId = process.env['CLOTHOS_MODEL']
    ?? config.models.providers[0]?.models[0]
    ?? 'claude-sonnet-4-6';
  const authMode = process.env['CLOTHOS_AUTH_MODE']
    ?? config.auth.profiles[0]?.authMode
    ?? 'apikey';

  // If using OAuth, load credentials and inject the API key into the environment
  if (authMode === 'oauth') {
    const apiKey = await getOrRefreshApiKey(providerName, basePath);
    if (!apiKey) {
      logger.error('No OAuth credentials found. Run with --login first.');
      process.exit(1);
    }
    // pi-ai reads API keys from env vars — inject the OAuth token
    if (providerName.startsWith('openai')) {
      process.env['OPENAI_API_KEY'] = apiKey;
    } else if (providerName === 'anthropic') {
      process.env['ANTHROPIC_API_KEY'] = apiKey;
    }
    logger.info(`OAuth: loaded credentials for ${providerName}`);
  }

  // For getModel(), always use the base provider name (e.g. "openai" not "openai-completions")
  const getModelProvider = providerName.startsWith('openai') ? 'openai' : providerName;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi-ai Model type is complex; provider cast is safe
  let model: any = getModel(getModelProvider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);

  // If using OAuth, force Chat Completions API (Codex tokens don't have Responses API scope)
  if (authMode === 'oauth' && providerName.startsWith('openai')) {
    model = { ...model, api: 'openai-completions' };
    logger.info('OAuth: using Chat Completions API');
  }

  const llmProvider = new PiMonoProvider({ model, id: 'pi-mono' });

  const app = await bootstrap({
    config,
    basePath,
    fs: nodeFs,
    logger,
    llmProviders: [llmProvider],
  });

  // Handle shutdown signals
  const handleShutdown = async () => {
    await app.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  logger.info(`ClothOS running — WebSocket on port ${config.gateway.websocket.port}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
