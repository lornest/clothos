import { describe, it, expect } from 'vitest';
import type { AgentEvent, LLMProvider, StreamChunk } from '@clothos/core';
import { agentLoop } from '../src/agent-loop.js';
import { ConversationContext } from '../src/conversation-context.js';
import { HookRegistry } from '../src/hook-registry.js';
import { LLMService } from '../src/llm-service.js';
import type { ToolHandler } from '../src/tool-executor.js';
import { HookBlockError } from '../src/errors.js';

interface CallSpec {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

function createSequenceLLM(calls: CallSpec[]): LLMService {
  let callIndex = 0;
  const provider: LLMProvider = {
    id: 'mock',
    supportsPromptCaching: false,
    async *streamCompletion(): AsyncIterable<StreamChunk> {
      const spec = calls[callIndex++];
      if (!spec) {
        yield { type: 'text_delta', text: 'fallback' };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      if (spec.text) {
        yield { type: 'text_delta', text: spec.text };
      }
      if (spec.toolCalls) {
        for (const tc of spec.toolCalls) {
          yield {
            type: 'tool_call_delta',
            toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
          };
        }
        yield { type: 'done', finishReason: 'tool_calls' };
      } else {
        yield { type: 'done', finishReason: 'stop' };
      }
    },
    async countTokens() { return 10; },
  };

  const service = new LLMService({
    providers: [provider],
    models: { providers: [], fallbacks: [] },
    auth: { profiles: [] },
  });
  service.bindSession('test');
  return service;
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('agentLoop', () => {
  it('text only → 1 turn, yields assistant_message, terminates', async () => {
    const llm = createSequenceLLM([{ text: 'Hello!' }]);
    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Hi');

    const events = await collectEvents(
      agentLoop(llm, ctx, [], new Map(), new HookRegistry()),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('assistant_message');
    if (events[0]!.type === 'assistant_message') {
      expect(events[0]!.content.text).toBe('Hello!');
    }
  });

  it('tool call then text → 2 turns, correct event sequence', async () => {
    const llm = createSequenceLLM([
      {
        text: '',
        toolCalls: [
          { id: 'tc1', name: 'search', arguments: '{"q":"test"}' },
        ],
      },
      { text: 'Here are the results.' },
    ]);

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Search for test');

    const handlers = new Map<string, ToolHandler>();
    handlers.set('search', async (args) => `Results for ${args['q']}`);

    const tools = [{ name: 'search', description: 'Search', inputSchema: {} }];

    const events = await collectEvents(
      agentLoop(llm, ctx, tools, handlers, new HookRegistry()),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'assistant_message',
      'tool_result',
      'assistant_message',
    ]);
  });

  it('maxTurns reached → yields max_turns_reached', async () => {
    // LLM always returns tool calls
    const alwaysToolCall: CallSpec = {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'loop', arguments: '{}' }],
    };
    const llm = createSequenceLLM(
      Array.from({ length: 10 }, () => alwaysToolCall),
    );

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Go');

    const handlers = new Map<string, ToolHandler>();
    handlers.set('loop', async () => 'looping');

    const events = await collectEvents(
      agentLoop(llm, ctx, [{ name: 'loop', description: 'Loop', inputSchema: {} }], handlers, new HookRegistry(), { maxTurns: 3 }),
    );

    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.type).toBe('max_turns_reached');
    if (lastEvent.type === 'max_turns_reached') {
      expect(lastEvent.turns).toBe(3);
    }
  });

  it('tool blocked by hook → yields tool_blocked, handler NOT called', async () => {
    const llm = createSequenceLLM([
      {
        text: '',
        toolCalls: [{ id: 'tc1', name: 'danger', arguments: '{}' }],
      },
      { text: 'OK, blocked.' },
    ]);

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Do something dangerous');

    let handlerCalled = false;
    const handlers = new Map<string, ToolHandler>();
    handlers.set('danger', async () => {
      handlerCalled = true;
      return 'done';
    });

    const hooks = new HookRegistry();
    hooks.register('tool_call', async () => {
      return { blocked: true, reason: 'Too risky' };
    });

    const events = await collectEvents(
      agentLoop(
        llm,
        ctx,
        [{ name: 'danger', description: 'Danger', inputSchema: {} }],
        handlers,
        hooks,
      ),
    );

    expect(handlerCalled).toBe(false);
    const blockedEvent = events.find((e) => e.type === 'tool_blocked');
    expect(blockedEvent).toBeDefined();
    if (blockedEvent?.type === 'tool_blocked') {
      expect(blockedEvent.reason).toBe('Too risky');
    }
  });

  it('tool blocked by HookBlockError → yields tool_blocked', async () => {
    const llm = createSequenceLLM([
      {
        text: '',
        toolCalls: [{ id: 'tc1', name: 'danger', arguments: '{}' }],
      },
      { text: 'OK' },
    ]);

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Go');

    const handlers = new Map<string, ToolHandler>();
    handlers.set('danger', async () => 'done');

    const hooks = new HookRegistry();
    hooks.register('tool_call', async () => {
      throw new HookBlockError('Forbidden');
    });

    const events = await collectEvents(
      agentLoop(
        llm,
        ctx,
        [{ name: 'danger', description: 'Danger', inputSchema: {} }],
        handlers,
        hooks,
      ),
    );

    const blockedEvent = events.find((e) => e.type === 'tool_blocked');
    expect(blockedEvent).toBeDefined();
    if (blockedEvent?.type === 'tool_blocked') {
      expect(blockedEvent.reason).toBe('Forbidden');
    }
  });

  it('all lifecycle hooks fired in correct order', async () => {
    const llm = createSequenceLLM([
      {
        text: 'I will search.',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: '{}' }],
      },
      { text: 'Done!' },
    ]);

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('search');

    const handlers = new Map<string, ToolHandler>();
    handlers.set('search', async () => 'results');

    const hooks = new HookRegistry();
    const fired: string[] = [];

    const hookEvents = [
      'before_agent_start',
      'turn_start',
      'context_assemble',
      'tool_call',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'agent_end',
    ] as const;

    for (const event of hookEvents) {
      hooks.register(event, async (ctx) => {
        fired.push(event);
        return ctx;
      });
    }

    await collectEvents(
      agentLoop(
        llm,
        ctx,
        [{ name: 'search', description: 'Search', inputSchema: {} }],
        handlers,
        hooks,
      ),
    );

    expect(fired[0]).toBe('before_agent_start');
    expect(fired[1]).toBe('turn_start');
    expect(fired[2]).toBe('context_assemble');
    expect(fired).toContain('tool_call');
    expect(fired).toContain('tool_execution_start');
    expect(fired).toContain('tool_execution_end');
    expect(fired).toContain('turn_end');
    expect(fired[fired.length - 1]).toBe('agent_end');
  });

  it('LLM error → yields error event', async () => {
    const provider: LLMProvider = {
      id: 'mock',
      supportsPromptCaching: false,
      async *streamCompletion(): AsyncIterable<StreamChunk> {
        throw new Error('LLM exploded');
      },
      async countTokens() { return 10; },
    };

    const llm = new LLMService({
      providers: [provider],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
    });
    llm.bindSession('test');

    const ctx = new ConversationContext({
      agentId: 'a1',
      sessionId: 's1',
      systemPrompt: 'sys',
    });
    ctx.addUserMessage('Hi');

    const events = await collectEvents(
      agentLoop(llm, ctx, [], new Map(), new HookRegistry()),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    if (events[0]!.type === 'error') {
      expect((events[0]!.error as Error).message).toBe('LLM exploded');
    }
  });
});
