import type {
  CompletionOptions,
  LLMProvider,
  Message,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from '@clothos/core';

export interface MockResponse {
  text: string;
  toolCalls?: ToolCall[];
}

/**
 * Deterministic LLM provider for E2E tests.
 *
 * Supports two modes:
 * 1. Static responses — returns the same response for every call.
 * 2. Pattern-based — matches user message content to canned responses.
 */
export class MockLLMProvider implements LLMProvider {
  id = 'mock';
  supportsPromptCaching = false;

  private responses: MockResponse[];
  private callIndex = 0;

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async *streamCompletion(
    messages: Message[],
    _tools: ToolDefinition[],
    _options: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const response = this.responses[this.callIndex % this.responses.length]!;
    this.callIndex++;

    // Emit text
    if (response.text) {
      yield { type: 'text_delta', text: response.text };
    }

    // Emit tool calls
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield {
          type: 'tool_call_delta',
          toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
        };
      }
    }

    // Emit usage
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 50 },
    };

    // Emit done
    yield {
      type: 'done',
      finishReason: response.toolCalls?.length ? 'tool_use' : 'end_turn',
    };
  }

  async countTokens(messages: Message[]): Promise<number> {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }

  /** Reset the call counter for test isolation. */
  reset(): void {
    this.callIndex = 0;
  }

  /** Get how many times streamCompletion was called. */
  get callCount(): number {
    return this.callIndex;
  }
}
