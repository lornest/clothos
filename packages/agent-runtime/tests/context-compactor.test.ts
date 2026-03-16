import { describe, it, expect } from 'vitest';
import type { LLMProvider, StreamChunk } from '@clothos/core';
import { ContextCompactor } from '../src/context-compactor.js';
import { ConversationContext } from '../src/conversation-context.js';
import { HookRegistry } from '../src/hook-registry.js';
import { LLMService } from '../src/llm-service.js';

function createMockLLMService(tokenCount: number, summaryText = 'Summary of conversation'): LLMService {
  const chunks: StreamChunk[] = [
    { type: 'text_delta', text: summaryText },
    { type: 'done', finishReason: 'stop' },
  ];
  const provider: LLMProvider = {
    id: 'mock',
    supportsPromptCaching: false,
    async *streamCompletion(): AsyncIterable<StreamChunk> {
      for (const c of chunks) yield c;
    },
    async countTokens(): Promise<number> {
      return tokenCount;
    },
  };
  const service = new LLMService({
    providers: [provider],
    models: { providers: [], fallbacks: [] },
    auth: { profiles: [] },
  });
  service.bindSession('test');
  return service;
}

describe('ContextCompactor', () => {
  it('returns true when tokens exceed threshold', async () => {
    const compactor = new ContextCompactor({
      contextWindow: 1000,
      reserveTokens: 200,
    });
    // Token count of 850 >= 1000 - 200 = 800
    const llm = createMockLLMService(850);
    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });

    expect(await compactor.needsCompaction(ctx, llm)).toBe(true);
  });

  it('returns false when tokens are below threshold', async () => {
    const compactor = new ContextCompactor({
      contextWindow: 1000,
      reserveTokens: 200,
    });
    // Token count of 500 < 800
    const llm = createMockLLMService(500);
    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });

    expect(await compactor.needsCompaction(ctx, llm)).toBe(false);
  });

  it('compact replaces messages with summary + last 3 exchanges', async () => {
    const llm = createMockLLMService(1000, 'Conversation discussed greetings.');
    const hooks = new HookRegistry();
    const compactor = new ContextCompactor({
      contextWindow: 1000,
      reserveTokens: 200,
    });

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'You are helpful.',
    });

    // Add 5 exchanges
    for (let i = 1; i <= 5; i++) {
      ctx.addUserMessage(`Q${i}`);
      ctx.addAssistantMessage(`A${i}`);
    }

    await compactor.compact(ctx, llm, hooks);

    const msgs = ctx.getMessages();
    // Should have: system + summary + last 3 exchanges (6 messages) = 8
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toBe('You are helpful.');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.content).toContain('Conversation discussed greetings.');

    // Last 3 exchanges = 6 messages
    const remaining = msgs.slice(2);
    expect(remaining).toHaveLength(6);
    expect(remaining[0]!.content).toBe('Q3');
    expect(remaining[5]!.content).toBe('A5');
  });

  it('fires memory_flush and session_compact hooks', async () => {
    const llm = createMockLLMService(1000);
    const hooks = new HookRegistry();
    const compactor = new ContextCompactor({
      contextWindow: 1000,
      reserveTokens: 200,
    });

    const fired: string[] = [];
    hooks.register('memory_flush', async () => { fired.push('memory_flush'); });
    hooks.register('session_compact', async () => { fired.push('session_compact'); });

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Q1');
    ctx.addAssistantMessage('A1');

    await compactor.compact(ctx, llm, hooks);

    expect(fired).toEqual(['memory_flush', 'session_compact']);
  });
});
