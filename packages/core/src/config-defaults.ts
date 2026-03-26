import type { ClothosConfig } from './config.js';

/** Maps pi-ai provider names to their standard API key env var. */
export const PROVIDER_API_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  'openai-completions': 'OPENAI_API_KEY',
  'openai-codex': 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_API_KEY',
  'google-vertex': 'GOOGLE_APPLICATION_CREDENTIALS',
  'amazon-bedrock': 'AWS_ACCESS_KEY_ID',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
};

/** Providers that support OAuth login via pi-ai. */
export const OAUTH_PROVIDERS = ['openai', 'openai-codex'] as const;

/**
 * Complete default configuration.
 *
 * Every field has a sensible value so users only need to override
 * what differs from their setup. The config loader deep-merges
 * the user's sparse config onto this object.
 */
export const CONFIG_DEFAULTS: ClothosConfig = {
  gateway: {
    nats: { url: 'nats://localhost:4222' },
    redis: { url: 'redis://localhost:6379' },
    websocket: {
      port: 18789,
      allowAnonymous: true,
    },
    maxConcurrentAgents: 5,
  },

  agents: {
    defaults: {
      model: 'pi-mono',
      contextWindow: 128_000,
      maxTurns: 100,
    },
    list: [],
  },

  bindings: [],

  models: {
    providers: [
      {
        id: 'pi-mono',
        type: 'pi-mono',
        models: ['claude-sonnet-4-6'],
        profiles: ['default'],
      },
    ],
    fallbacks: [],
  },

  auth: {
    profiles: [
      {
        id: 'default',
        provider: 'anthropic',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
    ],
  },

  session: {
    compaction: {
      enabled: true,
      reserveTokens: 20_000,
    },
  },

  tools: {
    allow: ['*'],
    deny: [],
  },

  sandbox: {
    mode: 'off',
    scope: 'session',
    docker: {
      image: 'clothos-sandbox:latest',
      memoryLimit: '512m',
      cpuLimit: '1.0',
      pidsLimit: 256,
      networkMode: 'none',
      readOnlyRoot: true,
      tmpfsSize: '100m',
      timeout: 30,
    },
  },

  plugins: {
    directories: [],
    enabled: [],
    disabled: [],
  },

  memory: {
    enabled: true,
    embedding: {
      provider: 'auto',
      dimensions: 1024,
      model: 'text-embedding-3-large',
      apiKeyEnv: 'OPENAI_API_KEY',
      batchSize: 64,
    },
    search: {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      decayHalfLifeDays: 30,
      mmrLambda: 0.6,
      defaultMaxResults: 10,
    },
    chunking: {
      targetTokens: 400,
      overlapTokens: 80,
      maxChunkTokens: 600,
    },
    importanceScoring: {
      enabled: true,
      defaultImportance: 0.5,
    },
    dailyLog: {
      enabled: true,
      directory: 'memory',
    },
  },
};
