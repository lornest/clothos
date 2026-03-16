import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FileSystem } from '@clothos/agent-runtime';
import type { AgentEntry, Logger } from '@clothos/core';

/** Create a temp directory for test data. */
export async function createTempDir(prefix = 'clothos-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Clean up a temp directory. */
export async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Create a FileSystem adapter wrapping node:fs/promises. */
export function createNodeFs(): FileSystem {
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

/** Create a silent logger for tests. */
export function createTestLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/** Write a test config file to a temp directory. */
export async function writeTestConfig(
  dir: string,
  overrides?: {
    port?: number;
    natsUrl?: string;
    redisUrl?: string;
    agents?: AgentEntry[];
    toolsDeny?: string[];
    memoryEnabled?: boolean;
  },
): Promise<string> {
  const {
    port = 0, // 0 = let OS pick a free port (will override in tests)
    natsUrl = 'nats://localhost:4222',
    redisUrl = 'redis://localhost:6379',
    agents = [
      {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'Agent for E2E tests',
        persona: 'You are a test assistant. Keep responses short.',
        tools: { allow: ['*'] },
      },
    ],
    toolsDeny = [],
    memoryEnabled = true,
  } = overrides ?? {};

  const config = `{
  gateway: {
    nats: { url: "${natsUrl}" },
    redis: { url: "${redisUrl}" },
    websocket: { port: ${port} },
    maxConcurrentAgents: 5,
  },
  agents: {
    defaults: {
      model: "mock",
      contextWindow: 128000,
      maxTurns: 10,
    },
    list: ${JSON.stringify(agents)},
  },
  bindings: [{ channel: "default", agentId: "${agents[0]?.id ?? 'test-agent'}" }],
  models: {
    providers: [{ id: "mock", type: "mock", models: ["mock"], profiles: ["default"] }],
    fallbacks: [],
  },
  auth: {
    profiles: [{ id: "default", provider: "mock", apiKeyEnv: "MOCK_KEY" }],
  },
  session: {
    idleTimeoutMs: 1800000,
    maxHistoryEntries: 1000,
    compaction: { enabled: false, reserveTokens: 20000 },
  },
  tools: {
    allow: ["*"],
    deny: ${JSON.stringify(toolsDeny)},
    mcpServers: [],
  },
  sandbox: {
    mode: "off",
    scope: "session",
    docker: {
      image: "clothos-sandbox:latest",
      memoryLimit: "512m",
      cpuLimit: "1.0",
      pidsLimit: 256,
      networkMode: "none",
      readOnlyRoot: true,
      tmpfsSize: "100m",
      timeout: 30,
    },
  },
  plugins: { directories: [], enabled: [], disabled: [] },
  skills: { directories: [], enabled: [], disabled: [] },
  memory: {
    enabled: ${memoryEnabled},
    embedding: {
      provider: "none",
      dimensions: 0,
      model: "none",
      apiKeyEnv: "NONE",
      batchSize: 64,
    },
    search: {
      vectorWeight: 0.0,
      bm25Weight: 1.0,
      decayHalfLifeDays: 30,
      mmrLambda: 0.6,
      defaultMaxResults: 10,
    },
    chunking: { targetTokens: 400, overlapTokens: 80, maxChunkTokens: 600 },
    importanceScoring: { enabled: true, defaultImportance: 0.5 },
    dailyLog: { enabled: false, directory: "memory" },
  },
}`;

  const configPath = path.join(dir, 'test-config.json5');
  await fs.writeFile(configPath, config, 'utf-8');
  return configPath;
}
