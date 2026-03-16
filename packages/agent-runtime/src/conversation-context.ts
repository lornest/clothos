import type { CompletionOptions, Message, ToolCall } from '@clothos/core';

export class ConversationContext {
  readonly agentId: string;
  readonly sessionId: string;
  private messages: Message[];
  private options: CompletionOptions;

  constructor(params: {
    agentId: string;
    sessionId: string;
    systemPrompt: string;
    messages?: Message[];
    options?: CompletionOptions;
  }) {
    this.agentId = params.agentId;
    this.sessionId = params.sessionId;
    this.options = params.options ?? {};

    if (params.messages && params.messages.length > 0) {
      // Ensure system prompt is first
      const first = params.messages[0];
      if (first && first.role === 'system') {
        this.messages = [...params.messages];
      } else {
        this.messages = [
          { role: 'system', content: params.systemPrompt },
          ...params.messages,
        ];
      }
    } else {
      this.messages = [{ role: 'system', content: params.systemPrompt }];
    }
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistantMessage(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({ role: 'assistant', content, toolCalls });
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', content, toolCallId });
  }

  replaceMessages(messages: Message[]): void {
    this.messages = messages;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getLastExchanges(count: number): Message[] {
    const nonSystem = this.messages.filter((m) => m.role !== 'system');
    // A pair is user + assistant. Walk backwards to find pairs.
    const pairs: Message[][] = [];
    let i = nonSystem.length - 1;
    while (i >= 0 && pairs.length < count) {
      // Collect assistant + tool results, then the user message
      const group: Message[] = [];
      // Collect trailing tool/assistant messages
      while (i >= 0) {
        const msg = nonSystem[i]!;
        if (msg.role === 'user') break;
        group.unshift(msg);
        i--;
      }
      // Collect the user message
      if (i >= 0) {
        const msg = nonSystem[i]!;
        if (msg.role === 'user') {
          group.unshift(msg);
          i--;
        }
      }
      if (group.length > 0) {
        pairs.unshift(group);
      }
    }
    return pairs.slice(-count).flat();
  }

  getHistory(): Message[] {
    return this.messages.filter((m) => m.role !== 'system');
  }

  getSystemPrompt(): string {
    const sys = this.messages.find((m) => m.role === 'system');
    return sys?.content ?? '';
  }

  getOptions(): CompletionOptions {
    return { ...this.options };
  }

  setOptions(options: CompletionOptions): void {
    this.options = { ...options };
  }
}
