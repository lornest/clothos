import type { HookHandler, Message } from '@clothos/core';
import type { AssembledContext } from './types.js';

export interface ContextPrunerOptions {
  contextWindow: number;
  maxHistoryShare?: number;
}

export const DEFAULT_MAX_HISTORY_SHARE = 0.5;

/** Rough token estimate: ~4 chars per token (same heuristic as memory chunker). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function estimateMessageTokens(msg: Message): number {
  let chars = msg.content.length;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      chars += tc.name.length + tc.arguments.length + tc.id.length;
    }
  }
  return estimateTokens(chars);
}

/**
 * Repair orphaned tool_use / tool_result pairs after pruning.
 *
 * - Drop `tool` messages whose `toolCallId` has no matching
 *   `toolCalls[].id` in any remaining assistant message.
 * - Strip `toolCalls` from assistant messages whose tool results
 *   were all dropped.
 */
function repairOrphans(messages: Message[]): Message[] {
  // Collect all tool result IDs present in the pruned set
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      toolResultIds.add(msg.toolCallId);
    }
  }

  // Collect all tool call IDs from assistant messages
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallIds.add(tc.id);
      }
    }
  }

  // Drop orphaned tool results (no matching assistant tool call)
  const filtered = messages.filter((msg) => {
    if (msg.role === 'tool' && msg.toolCallId) {
      return toolCallIds.has(msg.toolCallId);
    }
    return true;
  });

  // Recalculate tool result IDs after filtering
  const remainingResultIds = new Set<string>();
  for (const msg of filtered) {
    if (msg.role === 'tool' && msg.toolCallId) {
      remainingResultIds.add(msg.toolCallId);
    }
  }

  // Strip toolCalls from assistant messages where ALL results were dropped
  return filtered.map((msg) => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const survivingCalls = msg.toolCalls.filter((tc) =>
        remainingResultIds.has(tc.id),
      );
      if (survivingCalls.length === 0) {
        // All tool results dropped — remove toolCalls entirely
        const { toolCalls: _, ...rest } = msg;
        return rest as Message;
      }
      if (survivingCalls.length < msg.toolCalls.length) {
        return { ...msg, toolCalls: survivingCalls };
      }
    }
    return msg;
  });
}

/**
 * Creates a `context_assemble` hook handler that prunes history to fit
 * within a token budget. Designed to run at priority 500 (after all
 * prompt enrichment handlers at 10–50).
 *
 * Algorithm:
 * 1. Separate system message (index 0) from history
 * 2. Calculate historyBudget = min(contextWindow - systemTokens, contextWindow * maxHistoryShare)
 * 3. If history fits, return unchanged
 * 4. Otherwise, keep newest messages that fit within budget (drop oldest first)
 * 5. Run orphan repair on the pruned result
 */
export function createContextPrunerHandler(
  options: ContextPrunerOptions,
): HookHandler {
  const { contextWindow, maxHistoryShare = DEFAULT_MAX_HISTORY_SHARE } = options;

  return async (ctx: unknown): Promise<unknown> => {
    const assembled = ctx as AssembledContext;
    const messages = assembled.messages;

    if (messages.length <= 1) return assembled;

    const systemMsg = messages[0];
    if (!systemMsg || systemMsg.role !== 'system') return assembled;

    const history = messages.slice(1);
    const systemTokens = estimateMessageTokens(systemMsg);
    const historyBudget = Math.min(
      contextWindow - systemTokens,
      contextWindow * maxHistoryShare,
    );

    // Calculate total history tokens
    const historyTokens = history.reduce(
      (sum, msg) => sum + estimateMessageTokens(msg),
      0,
    );

    // If it fits, no pruning needed
    if (historyTokens <= historyBudget) return assembled;

    // Keep newest messages that fit within budget (drop oldest first)
    let budget = historyBudget;
    let keepFrom = history.length;

    for (let i = history.length - 1; i >= 0; i--) {
      const tokens = estimateMessageTokens(history[i]!);
      if (budget - tokens < 0) break;
      budget -= tokens;
      keepFrom = i;
    }

    const pruned = history.slice(keepFrom);
    const repaired = repairOrphans(pruned);

    return {
      ...assembled,
      messages: [systemMsg, ...repaired],
    };
  };
}
