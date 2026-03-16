import type {
  AuthConfig,
  CompletionOptions,
  LLMProvider,
  LifecycleEvent,
  HookHandler,
  Message,
  ModelsConfig,
  AgentEntry,
  AgentDefaults,
} from '@clothos/core';

/** Returned by the `context_assemble` hook. */
export interface AssembledContext {
  messages: Message[];
  options: CompletionOptions;
}

/** Returned by the `tool_call` hook to allow or block a tool invocation. */
export interface ToolCallHookResult {
  blocked: boolean;
  reason?: string;
}

/** Internal registry entry for a hook handler. */
export interface HookEntry {
  event: LifecycleEvent;
  priority: number;
  handler: HookHandler;
  disposable: boolean;
}

/** First line of a session JSONL file. */
export interface SessionHeader {
  type: 'session_header';
  sessionId: string;
  agentId: string;
  channel?: string;
  createdAt: string;
}

/** Subsequent lines of a session JSONL file. */
export interface SessionEntry {
  type: 'session_entry';
  id: string;
  parentId?: string;
  role: Message['role'];
  content: string;
  toolCallId?: string;
  toolCalls?: Message['toolCalls'];
  timestamp: string;
}

/** Discriminated union of JSONL line types. */
export type SessionLine = SessionHeader | SessionEntry;

/** Options for constructing an LLMService. */
export interface LLMServiceOptions {
  providers: LLMProvider[];
  models: ModelsConfig;
  auth: AuthConfig;
}

/** Tracks which provider/profile is bound to a session. */
export interface ActiveBinding {
  providerId: string;
  profileId: string;
  sessionId?: string;
}

/** Injectable filesystem abstraction for testability. */
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
}

/** Options for constructing an AgentManager. */
export interface AgentManagerOptions {
  agentEntry: AgentEntry;
  defaults: AgentDefaults;
  compaction: { enabled: boolean; reserveTokens: number };
  basePath: string;
  fs: FileSystem;
}

/** Persisted state for agent session continuity across restarts. */
export interface AgentState {
  currentSessionId: string;
  lastActiveAt: string;
}
