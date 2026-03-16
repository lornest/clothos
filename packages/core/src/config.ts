import type { ChannelsConfig } from './channels.js';
import type { OrchestratorConfig } from './orchestration.js';
import type { SkillsConfig } from './skills.js';

/** Top-level configuration schema for the ClothOS. */
export interface ClothosConfig {
  gateway: GatewayConfig;
  agents: AgentsConfig;
  bindings: Binding[];
  models: ModelsConfig;
  auth: AuthConfig;
  session: SessionConfig;
  tools: ToolsConfig;
  sandbox: SandboxConfig;
  plugins: PluginsConfig;
  memory?: MemoryConfig;
  skills?: SkillsConfig;
  channels?: ChannelsConfig;
  orchestrator?: OrchestratorConfig;
}

/** Configuration for the memory subsystem. */
export interface MemoryConfig {
  enabled: boolean;
  embedding: {
    provider: 'auto' | 'openai' | 'none';
    dimensions: number;
    model: string;
    apiKeyEnv: string;
    batchSize: number;
  };
  search: {
    vectorWeight: number;
    bm25Weight: number;
    decayHalfLifeDays: number;
    mmrLambda: number;
    defaultMaxResults: number;
  };
  chunking: {
    targetTokens: number;
    overlapTokens: number;
    maxChunkTokens: number;
  };
  importanceScoring: {
    enabled: boolean;
    defaultImportance: number;
  };
  dailyLog: {
    enabled: boolean;
    directory: string;
  };
}

export interface GatewayConfig {
  nats: {
    url: string;
    credentials?: string;
  };
  redis: {
    url: string;
  };
  websocket: {
    port: number;
    host?: string;
    /** Allow unauthenticated WebSocket connections. Defaults to false. */
    allowAnonymous?: boolean;
    /** Shared secret for token auth. Clients must send this as Bearer token. */
    sharedSecret?: string;
    /** HMAC secret for signing JWT session tokens. Auto-generated if not set. */
    jwtSecret?: string;
    /** JWT lifetime in ms. Default: 1 hour (3_600_000). */
    tokenExpiryMs?: number;
    /** TTL for pending responses / listeners (ms). Defaults to 10 minutes. */
    responseTtlMs?: number;
  };
  maxConcurrentAgents: number;
  ui?: {
    enabled: boolean;
    title?: string;
    staticPath?: string;
  };
}

export interface AgentsConfig {
  defaults: AgentDefaults;
  list: AgentEntry[];
}

export interface AgentDefaults {
  model: string;
  contextWindow: number;
  maxTurns: number;
}

export interface AgentEntry {
  id: string;
  name: string;
  description?: string;
  model?: string;
  persona?: string;
  tools?: { allow?: string[]; deny?: string[] };
  skills?: string[];
  sandbox?: Partial<SandboxConfig>;
  mcpPinned?: string[];
}

export interface BindingOverrides {
  model?: string;
  sandbox?: Partial<SandboxConfig>;
  tools?: { allow?: string[]; deny?: string[] };
  workspace?: string;
}

export interface Binding {
  peer?: string;
  channel?: string;
  team?: string;
  account?: string;
  agentId: string;
  overrides?: BindingOverrides;
  priority?: number;
}

export interface ResolvedBinding {
  agentId: string;
  binding: Binding;
}

export interface ModelsConfig {
  providers: ModelProvider[];
  fallbacks: string[];
}

export interface ModelProvider {
  id: string;
  type: string;
  models: string[];
  profiles: string[];
}

export interface AuthConfig {
  profiles: AuthProfile[];
}

export interface AuthProfile {
  id: string;
  provider: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface SessionConfig {
  idleTimeoutMs: number;
  maxHistoryEntries: number;
  compaction: {
    enabled: boolean;
    reserveTokens: number;
  };
}

export interface ToolsConfig {
  allow?: string[];
  deny?: string[];
  mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http-sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface SandboxConfig {
  mode: 'off' | 'non-main' | 'all';
  scope: 'session' | 'agent' | 'shared';
  docker: DockerConfig;
}

export interface DockerConfig {
  image: string;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  networkMode: 'none' | 'bridge';
  readOnlyRoot: boolean;
  tmpfsSize: string;
  timeout: number;
}

export interface PluginsConfig {
  directories: string[];
  enabled: string[];
  disabled: string[];
}
