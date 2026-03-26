import type {
  CompletionOptions,
  LLMProvider,
  Message,
  StreamChunk,
  StreamResponse,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '@clothos/core';
import type { LLMServiceOptions, ActiveBinding } from './types.js';
import { LLMProviderUnavailableError } from './errors.js';

export class LLMService {
  private readonly options: LLMServiceOptions;
  private binding: ActiveBinding | null = null;
  private sessionTokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };

  constructor(options: LLMServiceOptions) {
    this.options = options;
  }

  bindSession(sessionId: string): void {
    if (this.options.providers.length === 0) {
      throw new LLMProviderUnavailableError();
    }
    const provider = this.options.providers[0]!;
    this.binding = {
      providerId: provider.id,
      profileId: provider.id,
      sessionId,
    };
  }

  unbindSession(): void {
    this.binding = null;
  }

  async streamCompletion(
    messages: Message[],
    tools: ToolDefinition[],
    options: CompletionOptions = {},
  ): Promise<StreamResponse> {
    const provider = this.getActiveProvider();

    try {
      return await this.runCompletion(provider, messages, tools, options);
    } catch (err) {
      // Try fallback providers
      const fallbackIds = this.options.models.fallbacks;
      let lastError = err;

      for (const fallbackId of fallbackIds) {
        const fallbackProvider = this.options.providers.find((p) => p.id === fallbackId);
        if (!fallbackProvider || fallbackProvider.id === provider.id) continue;

        try {
          return await this.runCompletion(fallbackProvider, messages, tools, options);
        } catch (fallbackErr) {
          lastError = fallbackErr;
        }
      }

      throw lastError;
    }
  }

  async *streamCompletionRaw(
    messages: Message[],
    tools: ToolDefinition[],
    options: CompletionOptions = {},
  ): AsyncIterable<StreamChunk> {
    const provider = this.getActiveProvider();
    yield* provider.streamCompletion(messages, tools, options);
  }

  async countTokens(messages: Message[]): Promise<number> {
    const provider = this.getActiveProvider();
    return provider.countTokens(messages);
  }

  getSessionTokenUsage(): TokenUsage {
    return { ...this.sessionTokenUsage };
  }

  resetSessionTokenUsage(): void {
    this.sessionTokenUsage = { input: 0, output: 0, total: 0 };
  }

  private getActiveProvider(): LLMProvider {
    if (!this.binding) {
      throw new LLMProviderUnavailableError('No session bound');
    }
    const provider = this.options.providers.find((p) => p.id === this.binding!.providerId);
    if (!provider) {
      throw new LLMProviderUnavailableError(
        `Provider ${this.binding.providerId} not found`,
      );
    }
    return provider;
  }

  private async runCompletion(
    provider: LLMProvider,
    messages: Message[],
    tools: ToolDefinition[],
    options: CompletionOptions,
  ): Promise<StreamResponse> {
    let text = '';
    let thinking = '';
    const toolCallMap = new Map<string, ToolCall>();
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;

    for await (const chunk of provider.streamCompletion(messages, tools, options)) {
      if (chunk.type === 'text_delta' && chunk.text) {
        text += chunk.text;
      } else if (chunk.type === 'thinking_delta' && chunk.thinking) {
        thinking += chunk.thinking;
      } else if (chunk.type === 'tool_call_delta' && chunk.toolCall) {
        const tc = chunk.toolCall;
        if (tc.id) {
          const existing = toolCallMap.get(tc.id);
          if (existing) {
            if (tc.name) existing.name = tc.name;
            if (tc.arguments) existing.arguments += tc.arguments;
          } else {
            toolCallMap.set(tc.id, {
              id: tc.id,
              name: tc.name ?? '',
              arguments: tc.arguments ?? '',
            });
          }
        }
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage = {
          input: chunk.usage.inputTokens,
          output: chunk.usage.outputTokens,
          total: chunk.usage.inputTokens + chunk.usage.outputTokens,
        };
        this.sessionTokenUsage.input += chunk.usage.inputTokens;
        this.sessionTokenUsage.output += chunk.usage.outputTokens;
        this.sessionTokenUsage.total +=
          chunk.usage.inputTokens + chunk.usage.outputTokens;
      } else if (chunk.type === 'done') {
        finishReason = chunk.finishReason;
      }
    }

    const toolCalls = toolCallMap.size > 0 ? [...toolCallMap.values()] : undefined;
    return { text, thinking: thinking || undefined, toolCalls, finishReason, usage };
  }
}
