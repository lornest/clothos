import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileSystem } from '@clothos/agent-runtime';
import type { Logger } from '@clothos/core';
import { PiMonoProvider, getModel } from '@clothos/agent-runtime';
import { bootstrap } from './bootstrap.js';

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

  // Set up LLM provider
  const provider = process.env['CLOTHOS_PROVIDER'] ?? 'anthropic';
  const modelId = process.env['CLOTHOS_MODEL'] ?? 'claude-sonnet-4-20250514';

  const model = getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
  const llmProvider = new PiMonoProvider({ model, id: 'pi-mono' });

  const app = await bootstrap({
    configPath,
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

  logger.info(`ClothOS running — WebSocket on port ${app.config.gateway.websocket.port}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
