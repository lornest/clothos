// Messages & envelope
export type {
  AgentMessage,
  TraceContext,
  MessageRole,
  Message,
  ToolCall,
} from './messages.js';

// Agent lifecycle
export { AgentStatus } from './agent.js';
export type {
  AgentControlBlock,
  TokenUsage,
  AgentSnapshot,
  AgentEvent,
  AgentLoopOptions,
  StreamResponse,
} from './agent.js';

// Tool definitions
export type {
  JSONSchema,
  RiskLevel,
  ToolDefinition,
  ToolAnnotations,
  ToolResult,
  ToolHandler,
  ToolHandlerMap,
  ToolSource,
  ToolRegistryEntry,
  PolicyContext,
} from './tools.js';

// Plugin system
export type {
  PluginCapability,
  PluginManifest,
  Disposable,
  HookHandler,
  CommandHandler,
  Logger,
  PluginContext,
  Plugin,
  LifecycleEvent,
} from './plugins.js';

// LLM provider abstraction
export type {
  StreamChunk,
  CompletionOptions,
  LLMProvider,
} from './llm.js';

// Skills
export type {
  SkillEntry,
  SkillMetadata,
  SkillsConfig,
} from './skills.js';

// Channel adaptors
export type {
  GatewayTransport,
  ChannelAdaptorStatus,
  ChannelAdaptorInfo,
  InboundMessage,
  OutboundMessage,
  ChannelAdaptorContext,
  ChannelAdaptor,
  ChannelsConfig,
  ChannelAdaptorConfig,
  ChannelSessionPolicy,
} from './channels.js';

// Configuration
export type {
  ClothosConfig,
  GatewayConfig,
  AgentsConfig,
  AgentDefaults,
  AgentEntry,
  Binding,
  BindingOverrides,
  ResolvedBinding,
  ModelsConfig,
  ModelProvider,
  AuthConfig,
  AuthProfile,
  SessionConfig,
  ToolsConfig,
  McpServerConfig,
  SandboxConfig,
  DockerConfig,
  PluginsConfig,
  MemoryConfig,
} from './config.js';

// Orchestration
export { TaskPriority } from './orchestration.js';
export type {
  ScheduledTask,
  AgentHealthInfo,
  OrchestratorConfig,
} from './orchestration.js';

// Configuration validator
export {
  validateConfig,
  loadConfig,
} from './config-validator.js';
export type {
  ConfigValidationError,
  ConfigValidationResult,
} from './config-validator.js';

// Env var config overrides
export { applyEnvOverrides } from './config-env-overlay.js';

// Utilities
export { generateId, now, isRecord } from './utils.js';
