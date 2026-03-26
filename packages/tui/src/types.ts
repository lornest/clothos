export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export type ChatMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ToolCallDisplay {
  name: string;
  arguments: string;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  thinking?: string;
  toolCalls?: ToolCallDisplay[];
}

export interface ContextInfo {
  cwd: string;
  gitBranch: string | null;
  gitDirty: boolean;
  activeFiles: string[];
}
