// Types
export type {
  AssembledContext,
  ToolCallHookResult,
  HookEntry,
  SessionHeader,
  SessionEntry,
  SessionLine,
  LLMServiceOptions,
  ActiveBinding,
  FileSystem,
  AgentManagerOptions,
  AgentState,
} from './types.js';

// Errors
export {
  HookBlockError,
  InvalidStateTransitionError,
  SessionCorruptError,
  LLMProviderUnavailableError,
} from './errors.js';

// Hook registry
export { HookRegistry } from './hook-registry.js';

// LLM service
export { LLMService } from './llm-service.js';

// Tool executor
export { executeToolCall, buildToolHandlerMap } from './tool-executor.js';
// Re-export ToolHandler/ToolHandlerMap from core for backward compatibility
export type { ToolHandler, ToolHandlerMap } from '@clothos/core';

// Conversation context
export { ConversationContext } from './conversation-context.js';

// Session store
export { SessionStore } from './session-store.js';

// Context compactor
export { ContextCompactor } from './context-compactor.js';
export type { ContextCompactorOptions } from './context-compactor.js';

// Context pruner
export { createContextPrunerHandler, DEFAULT_MAX_HISTORY_SHARE } from './context-pruner.js';
export type { ContextPrunerOptions } from './context-pruner.js';

// Agent loop
export { agentLoop } from './agent-loop.js';

// Agent manager
export { AgentManager } from './agent-manager.js';

// PiMono provider
export { PiMonoProvider } from './pi-mono-provider.js';
export type { PiMonoProviderOptions } from './pi-mono-provider.js';

// Re-export pi-ai utilities needed by consumers (e.g. REPL)
export { getModel } from '@mariozechner/pi-ai';

// Prompt enrichment — types
export type {
  PromptMode,
  RuntimeInfo,
  BootstrapConfig,
  BootstrapFile,
  PromptPriorities,
  PromptAssemblerConfig,
} from './prompt-types.js';
export {
  DEFAULT_PROMPT_PRIORITIES,
  DEFAULT_BOOTSTRAP_FILES,
  DEFAULT_BOOTSTRAP_CONFIG,
} from './prompt-types.js';

// Prompt enrichment — section builder
export {
  section,
  formatToolsSummary,
  formatSkillsSummary,
  formatBootstrapFiles,
} from './prompt-section-builder.js';

// Prompt enrichment — runtime info
export { collectRuntimeInfo, formatRuntimeInfo } from './runtime-info.js';
export type { CollectRuntimeInfoParams } from './runtime-info.js';

// Prompt enrichment — bootstrap loader
export { BootstrapLoader } from './bootstrap-loader.js';

// Prompt enrichment — handlers
export {
  appendToSystemPrompt,
  createToolsHandler,
  createSkillsHandler,
  createRuntimeInfoHandler,
  createBootstrapHandler,
} from './prompt-handlers.js';

// Prompt enrichment — assembler
export { registerPromptHandlers } from './prompt-assembler.js';
export type { RegisterPromptHandlersParams } from './prompt-assembler.js';

// Plan mode
export {
  PlanModeController,
  createPlanModeToolCallHook,
  createPlanModePromptHandler,
  createPlanContextHandler,
  enterPlanModeToolDefinition,
  createEnterPlanModeHandler,
  exitPlanModeToolDefinition,
  createExitPlanModeHandler,
  writePlanToolDefinition,
  createWritePlanHandler,
  editPlanToolDefinition,
  createEditPlanHandler,
} from './plan-mode/index.js';
export type {
  PlanModeConfig,
  PlanModeState,
  PlanModeControllerOptions,
  PlanModeTools,
  ExitPlanModeResult,
} from './plan-mode/index.js';
