import type {
  CompletionOptions,
  LLMProvider,
  Message as AosMessage,
  StreamChunk,
  ToolDefinition,
} from '@clothos/core';
import { stream } from '@mariozechner/pi-ai';
import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  Model,
  Tool as PiTool,
  ToolCall as PiToolCall,
  UserMessage as PiUserMessage,
  ToolResultMessage as PiToolResultMessage,
} from '@mariozechner/pi-ai';
import type { TSchema } from '@mariozechner/pi-ai';

export interface PiMonoProviderOptions {
  model: Model<Api>;
  id?: string;
}

/**
 * LLMProvider wrapping pi-ai's `stream()` function.
 * Converts between agent-os message/event types and pi-ai types.
 */
export class PiMonoProvider implements LLMProvider {
  readonly id: string;
  readonly supportsPromptCaching = true;

  private model: Model<Api>;

  constructor(options: PiMonoProviderOptions) {
    this.model = options.model;
    this.id = options.id ?? 'pi-mono';
  }

  async *streamCompletion(
    messages: AosMessage[],
    tools: ToolDefinition[],
    options: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const context = this.buildContext(messages, tools);

    const eventStream = stream(this.model, context, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });

    for await (const event of eventStream) {
      if (event.type === 'text_delta') {
        yield { type: 'text_delta', text: event.delta };
      } else if (event.type === 'toolcall_end') {
        yield {
          type: 'tool_call_delta',
          toolCall: {
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        };
      } else if (event.type === 'done') {
        yield {
          type: 'usage',
          usage: {
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
          },
        };
        yield {
          type: 'done',
          finishReason: mapStopReason(event.reason),
        };
      } else if (event.type === 'error') {
        const raw = (event as Record<string, unknown>).error;
        console.error(`[LLM] pi-ai stream error:`, JSON.stringify(raw, null, 2));
        yield { type: 'done', finishReason: 'error' };
      }
      // Ignore: start, text_start, text_end, thinking_*, toolcall_start, toolcall_delta
    }
  }

  async countTokens(messages: AosMessage[]): Promise<number> {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          totalChars += tc.name.length + tc.arguments.length;
        }
      }
    }
    return Math.ceil(totalChars / 4);
  }

  /** Convert agent-os messages + tools into a pi-ai Context. */
  private buildContext(messages: AosMessage[], tools: ToolDefinition[]): PiContext {
    let systemPrompt: string | undefined;
    const piMessages: (PiUserMessage | PiAssistantMessage | PiToolResultMessage)[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else if (msg.role === 'user') {
        piMessages.push({
          role: 'user',
          content: [{ type: 'text', text: msg.content }],
          timestamp: Date.now(),
        });
      } else if (msg.role === 'assistant') {
        piMessages.push(this.convertAssistantMessage(msg));
      } else if (msg.role === 'tool') {
        piMessages.push(this.convertToolResultMessage(msg, piMessages));
      }
    }

    const piTools: PiTool[] | undefined =
      tools.length > 0
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as TSchema,
          }))
        : undefined;

    return { systemPrompt, messages: piMessages, tools: piTools };
  }

  /** Convert an agent-os assistant message to a pi-ai AssistantMessage. */
  private convertAssistantMessage(msg: AosMessage): PiAssistantMessage {
    const content: (
      | { type: 'text'; text: string }
      | PiToolCall
    )[] = [];

    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'toolCall',
          id: tc.id,
          name: tc.name,
          arguments: safeParseJson(tc.arguments),
        });
      }
    }

    return {
      role: 'assistant',
      content,
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
  }

  /** Convert an agent-os tool result message to a pi-ai ToolResultMessage. */
  private convertToolResultMessage(
    msg: AosMessage,
    preceding: (PiUserMessage | PiAssistantMessage | PiToolResultMessage)[],
  ): PiToolResultMessage {
    // Look up toolName from the preceding assistant message's tool calls
    let toolName = 'unknown';
    if (msg.toolCallId) {
      for (let i = preceding.length - 1; i >= 0; i--) {
        const prev = preceding[i]!;
        if (prev.role === 'assistant') {
          for (const block of prev.content) {
            if (block.type === 'toolCall' && block.id === msg.toolCallId) {
              toolName = block.name;
              break;
            }
          }
          break;
        }
      }
    }

    return {
      role: 'toolResult',
      toolCallId: msg.toolCallId ?? '',
      toolName,
      content: [{ type: 'text', text: msg.content }],
      isError: false,
      timestamp: Date.now(),
    };
  }
}

/** Map pi-ai stop reasons to agent-os finish reasons. */
function mapStopReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'toolUse':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return reason;
  }
}

/** Safely parse a JSON string into an object, returning {} on failure. */
function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return {};
  }
}
