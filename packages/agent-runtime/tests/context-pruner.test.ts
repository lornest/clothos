import { describe, it, expect } from 'vitest';
import type { Message } from '@clothos/core';
import type { AssembledContext } from '../src/types.js';
import { createContextPrunerHandler, DEFAULT_MAX_HISTORY_SHARE } from '../src/context-pruner.js';

function makeAssembled(messages: Message[]): AssembledContext {
  return { messages, options: {} };
}

function sys(content: string): Message {
  return { role: 'system', content };
}

function user(content: string): Message {
  return { role: 'user', content };
}

function assistant(content: string, toolCalls?: Message['toolCalls']): Message {
  return { role: 'assistant', content, toolCalls };
}

function tool(toolCallId: string, content: string): Message {
  return { role: 'tool', content, toolCallId };
}

describe('createContextPrunerHandler', () => {
  it('exports DEFAULT_MAX_HISTORY_SHARE as 0.5', () => {
    expect(DEFAULT_MAX_HISTORY_SHARE).toBe(0.5);
  });

  it('returns unchanged when history fits within budget', async () => {
    const handler = createContextPrunerHandler({ contextWindow: 100_000 });
    const messages: Message[] = [
      sys('System prompt'),
      user('Hello'),
      assistant('Hi there!'),
    ];
    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    expect(result.messages).toHaveLength(3);
    expect(result.messages).toEqual(messages);
  });

  it('returns unchanged when only system message present', async () => {
    const handler = createContextPrunerHandler({ contextWindow: 1000 });
    const messages: Message[] = [sys('System prompt')];
    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    expect(result.messages).toHaveLength(1);
  });

  it('drops oldest messages when history exceeds budget', async () => {
    // Use a very small context window to force pruning
    // Each message ~10 chars / 4 = ~3 tokens
    const handler = createContextPrunerHandler({
      contextWindow: 40,  // 40 tokens total, system ~4 tokens, budget = min(36, 20) = 20
      maxHistoryShare: 0.5,
    });

    const messages: Message[] = [
      sys('Sys'),                              // ~1 token
      user('Message one is here'),             // ~5 tokens
      assistant('Response one here'),          // ~5 tokens
      user('Message two is here'),             // ~5 tokens
      assistant('Response two here'),          // ~5 tokens
      user('Message three here'),              // ~5 tokens
      assistant('Response three'),             // ~4 tokens
    ];

    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    // Should have dropped some oldest messages
    expect(result.messages.length).toBeLessThan(messages.length);
    // System message preserved
    expect(result.messages[0]!.role).toBe('system');
    // Newest messages kept
    expect(result.messages[result.messages.length - 1]!.content).toBe('Response three');
  });

  it('preserves system message always', async () => {
    const handler = createContextPrunerHandler({
      contextWindow: 20,
      maxHistoryShare: 0.5,
    });

    const messages: Message[] = [
      sys('A long system prompt that takes many tokens'),
      user('Hello'),
      assistant('World'),
    ];

    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toBe('A long system prompt that takes many tokens');
  });

  it('orphan repair: drops tool results without matching assistant tool call', async () => {
    const handler = createContextPrunerHandler({
      contextWindow: 60,
      maxHistoryShare: 0.5,
    });

    // Build a conversation where old tool call/result pairs will be dropped
    // but we artificially construct the scenario
    const messages: Message[] = [
      sys('Sys'),
      // Old exchange with tool call (will be dropped)
      user('Old message with lots of padding text to fill tokens'),
      assistant('Thinking...', [{ id: 'tc-old', name: 'search', arguments: '{}' }]),
      tool('tc-old', 'Old result'),
      // Recent exchange
      user('New message'),
      assistant('Done'),
    ];

    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    // If pruning dropped the assistant with tc-old, the tool result should also be dropped
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    const assistantWithCalls = result.messages.filter(
      (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
    );

    // Every tool result must have a matching assistant tool call
    for (const tm of toolMsgs) {
      const hasMatch = assistantWithCalls.some(
        (am) => am.toolCalls!.some((tc) => tc.id === tm.toolCallId),
      );
      expect(hasMatch).toBe(true);
    }
  });

  it('orphan repair: strips toolCalls when all results dropped', async () => {
    // Use a tiny budget so only the last few messages survive.
    // The assistant message with toolCalls will survive, but its tool result
    // (earlier in the conversation) will be pruned away.
    const handler = createContextPrunerHandler({
      contextWindow: 100,
      maxHistoryShare: 0.1,  // only ~10 tokens for history
    });

    const padding = 'x'.repeat(200); // forces old messages to be dropped
    const messages: Message[] = [
      sys('S'),
      user(padding),
      assistant('Old response', [{ id: 'tc-old', name: 'fetch', arguments: '{}' }]),
      tool('tc-old', 'Old tool result'),
      user('Recent question'),
      // This assistant has toolCalls whose results (tc-new) come next
      assistant('Calling tool', [{ id: 'tc-new', name: 'search', arguments: '{}' }]),
      tool('tc-new', 'New result'),
    ];

    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    // After pruning, every surviving assistant with toolCalls must have matching results
    const assistants = result.messages.filter((m) => m.role === 'assistant');
    for (const a of assistants) {
      if (a.toolCalls && a.toolCalls.length > 0) {
        for (const tc of a.toolCalls) {
          const hasResult = result.messages.some(
            (m) => m.role === 'tool' && m.toolCallId === tc.id,
          );
          expect(hasResult).toBe(true);
        }
      }
    }

    // Verify something was actually pruned
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('respects maxHistoryShare option', async () => {
    // With a very low maxHistoryShare, even modest history should be pruned
    const handler = createContextPrunerHandler({
      contextWindow: 1000,
      maxHistoryShare: 0.01,  // only 10 tokens for history
    });

    const messages: Message[] = [
      sys('System'),
      user('A somewhat long user message that exceeds the tiny budget'),
      assistant('A somewhat long assistant response that exceeds the tiny budget'),
      user('Another message'),
      assistant('Another response'),
    ];

    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    // Should have pruned to fit within the tiny budget
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0]!.role).toBe('system');
  });

  it('handles empty history gracefully', async () => {
    const handler = createContextPrunerHandler({ contextWindow: 1000 });
    const assembled = makeAssembled([]);
    const result = (await handler(assembled)) as AssembledContext;
    expect(result.messages).toHaveLength(0);
  });

  it('handles non-system first message gracefully', async () => {
    const handler = createContextPrunerHandler({ contextWindow: 1000 });
    const messages: Message[] = [
      user('Hello'),
      assistant('Hi'),
    ];
    const assembled = makeAssembled(messages);
    const result = (await handler(assembled)) as AssembledContext;

    // No system message means no pruning — returned as-is
    expect(result.messages).toEqual(messages);
  });
});
