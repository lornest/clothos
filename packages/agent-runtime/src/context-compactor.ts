import type { Message } from '@clothos/core';
import type { ConversationContext } from './conversation-context.js';
import type { HookRegistry } from './hook-registry.js';
import type { LLMService } from './llm-service.js';

export interface ContextCompactorOptions {
  contextWindow: number;
  reserveTokens: number;
}

/** Max characters for a single tool result in the summary prompt. */
const MAX_TOOL_RESULT_CHARS = 500;

/** Reserve tokens for the summary system prompt + output generation. */
const SUMMARY_OVERHEAD_TOKENS = 2000;

export class ContextCompactor {
  private contextWindow: number;
  private reserveTokens: number;

  constructor(options: ContextCompactorOptions) {
    this.contextWindow = options.contextWindow;
    this.reserveTokens = options.reserveTokens;
  }

  async needsCompaction(
    context: ConversationContext,
    llm: LLMService,
  ): Promise<boolean> {
    const tokens = await llm.countTokens(context.getMessages());
    return tokens >= this.contextWindow - this.reserveTokens;
  }

  async compact(
    context: ConversationContext,
    llm: LLMService,
    hooks: HookRegistry,
  ): Promise<void> {
    // Fire memory_flush hook
    await hooks.fire('memory_flush', { context });

    // Build a summary via LLM, fitting the history within the context window
    const history = context.getHistory();
    const budgetTokens = this.contextWindow - this.reserveTokens - SUMMARY_OVERHEAD_TOKENS;
    const fittedHistory = fitHistoryToBudget(history, budgetTokens);

    const summaryPrompt = [
      { role: 'system' as const, content: 'Summarize the following conversation concisely, preserving key facts and decisions.' },
      { role: 'user' as const, content: fittedHistory.map((m) => `${m.role}: ${m.content}`).join('\n') },
    ];

    const response = await llm.streamCompletion(summaryPrompt, [], {});

    // Reconstruct context: system prompt + summary + last 3 exchanges
    const systemPrompt = context.getSystemPrompt();
    const lastExchanges = context.getLastExchanges(3);

    const newMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'assistant' as const, content: `[Conversation summary]\n${response.text}` },
      ...lastExchanges,
    ];

    context.replaceMessages(newMessages);

    // Fire session_compact hook
    await hooks.fire('session_compact', { context });
  }
}

/**
 * Fit conversation history within a token budget.
 *
 * Strategy:
 * 1. Truncate verbose tool results (often the largest messages)
 * 2. If still over budget, keep the first few and last few messages,
 *    dropping the middle with a "[...truncated...]" marker
 */
function fitHistoryToBudget(history: Message[], budgetTokens: number): Message[] {
  // Step 1: Truncate tool results
  let messages = history.map((m) => {
    if (m.role === 'tool' && m.content.length > MAX_TOOL_RESULT_CHARS) {
      return {
        ...m,
        content: m.content.slice(0, MAX_TOOL_RESULT_CHARS) + '... [truncated]',
      };
    }
    return m;
  });

  if (estimateTokens(messages) <= budgetTokens) {
    return messages;
  }

  // Step 2: Keep first 10% and last 40% of messages, drop the middle
  const keepStart = Math.max(2, Math.floor(messages.length * 0.1));
  const keepEnd = Math.max(4, Math.floor(messages.length * 0.4));

  const start = messages.slice(0, keepStart);
  const end = messages.slice(-keepEnd);
  const marker: Message = {
    role: 'assistant',
    content: '[...earlier conversation truncated for summarization...]',
  };
  messages = [...start, marker, ...end];

  if (estimateTokens(messages) <= budgetTokens) {
    return messages;
  }

  // Step 3: If still over, aggressively trim — keep only the last N messages
  // that fit within budget
  const trimmed: Message[] = [marker];
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = [messages[i]!, ...trimmed];
    if (estimateTokens(candidate) > budgetTokens) break;
    trimmed.unshift(messages[i]!);
  }

  return trimmed;
}

/** Rough token estimate: chars / 4 (matches PiMonoProvider.countTokens). */
function estimateTokens(messages: Message[]): number {
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
