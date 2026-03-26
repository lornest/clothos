import type { Message, ToolCall } from './messages.js';
import type { ToolDefinition } from './tools.js';

/** A single chunk from an LLM stream. */
export interface StreamChunk {
  type: 'text_delta' | 'thinking_delta' | 'tool_call_delta' | 'usage' | 'done';
  text?: string;
  thinking?: string;
  toolCall?: Partial<ToolCall>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
}

/** Options for a completion request. */
export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  topP?: number;
  /** Enable prompt caching if supported by the provider. */
  promptCaching?: boolean;
}

/**
 * Provider-agnostic LLM interface.
 * Implementations wrap specific backends (e.g. pi-mono, Anthropic, OpenAI).
 */
export interface LLMProvider {
  id: string;
  streamCompletion(
    messages: Message[],
    tools: ToolDefinition[],
    options: CompletionOptions,
  ): AsyncIterable<StreamChunk>;
  countTokens(messages: Message[]): Promise<number>;
  supportsPromptCaching: boolean;
  /** Optional availability check for fallback selection. */
  isAvailable?(): Promise<boolean>;
}
