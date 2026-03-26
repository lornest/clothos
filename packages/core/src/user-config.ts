import type {
  AgentEntry,
  Binding,
  GatewayConfig,
  SessionConfig,
  ToolsConfig,
  SandboxConfig,
  PluginsConfig,
  MemoryConfig,
} from './config.js';
import type { ChannelAdaptorConfig } from './channels.js';
import type { OrchestratorConfig } from './orchestration.js';
import type { SkillsConfig } from './skills.js';
import type { DeepPartial } from './utils.js';

/** Simplified LLM configuration (replaces models + auth sections). */
export interface LlmConfig {
  /** pi-ai provider name (e.g. 'anthropic', 'openrouter', 'openai-responses'). */
  provider?: string;
  /** pi-ai model ID (e.g. 'claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'). */
  model?: string;
  /** Env var name for the API key. Auto-inferred from provider if omitted. */
  apiKeyEnv?: string;
  /** Auth mode: 'apikey' (default) or 'oauth' (Codex subscription, etc.). */
  authMode?: 'apikey' | 'oauth';
}

/**
 * User-facing configuration format.
 *
 * Everything is optional with sensible defaults. The config loader
 * merges this with CONFIG_DEFAULTS and transforms it into a full
 * ClothosConfig for internal consumption.
 */
export interface UserConfig {
  /** LLM provider configuration (replaces models + auth). */
  llm?: LlmConfig;

  /** Agent definitions — flat array, not { defaults, list }. */
  agents?: AgentEntry[];

  /** Channel-to-agent routing. Auto-generated if omitted. */
  bindings?: Binding[];

  /** Gateway (NATS, Redis, WebSocket) configuration. */
  gateway?: DeepPartial<GatewayConfig>;

  /** Session management. */
  session?: DeepPartial<SessionConfig>;

  /** Tool access control. */
  tools?: DeepPartial<ToolsConfig>;

  /** Sandbox / execution constraints. */
  sandbox?: DeepPartial<SandboxConfig>;

  /** Plugin loader configuration. */
  plugins?: DeepPartial<PluginsConfig>;

  /** Episodic memory configuration. */
  memory?: DeepPartial<MemoryConfig>;

  /** Skill discovery configuration. */
  skills?: DeepPartial<SkillsConfig>;

  /** Channel adaptors — flat (no 'adaptors' wrapper). */
  channels?: Record<string, DeepPartial<ChannelAdaptorConfig>>;

  /** Multi-agent orchestration configuration. */
  orchestrator?: DeepPartial<OrchestratorConfig>;
}
