/** Agent lifecycle states. */
export enum AgentStatus {
  REGISTERED = 'REGISTERED',
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  RUNNING = 'RUNNING',
  SUSPENDED = 'SUSPENDED',
  TERMINATED = 'TERMINATED',
  ERROR = 'ERROR',
}

/** Agent Control Block — runtime state for a single agent. */
export interface AgentControlBlock {
  agentId: string;
  status: AgentStatus;
  priority: number;
  currentTaskId?: string;
  loopIteration: number;
  tokenUsage: TokenUsage;
  snapshotRef?: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

/** Serializable snapshot for suspend/resume. */
export interface AgentSnapshot {
  agentId: string;
  sessionId: string;
  messages: import('./messages.js').Message[];
  loopIteration: number;
  pendingToolCalls: import('./messages.js').ToolCall[];
  workspaceHash?: string;
  savedAt: string;
}

/** Events yielded from the agent loop. */
export type AgentEvent =
  | { type: 'assistant_message'; content: StreamResponse }
  | { type: 'tool_result'; name: string; toolCallId: string; result: unknown }
  | { type: 'tool_blocked'; name: string; reason: string }
  | { type: 'max_turns_reached'; turns: number }
  | { type: 'error'; error: unknown };

/** Options for the agent loop. */
export interface AgentLoopOptions {
  /** Hard ceiling to prevent runaway loops. Default: 100. */
  maxTurns?: number;
}

/** Response from an LLM stream completion. */
export interface StreamResponse {
  text: string;
  thinking?: string;
  toolCalls?: import('./messages.js').ToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
}
