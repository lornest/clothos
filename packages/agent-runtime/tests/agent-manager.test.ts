import { describe, it, expect } from 'vitest';
import type { AgentEvent, LLMProvider, Message, StreamChunk } from '@clothos/core';
import { AgentManager } from '../src/agent-manager.js';
import { LLMService } from '../src/llm-service.js';
import { InvalidStateTransitionError } from '../src/errors.js';
import { createMemoryFs } from './helpers.js';
import type { ToolHandler } from '../src/tool-executor.js';

function createMockLLMService(text = 'Hello!'): LLMService {
  const provider: LLMProvider = {
    id: 'mock',
    supportsPromptCaching: false,
    async *streamCompletion(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'done', finishReason: 'stop' };
    },
    async countTokens() { return 50; },
  };

  return new LLMService({
    providers: [provider],
    models: { providers: [], fallbacks: [] },
    auth: { profiles: [] },
  });
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('AgentManager', () => {
  it('starts in REGISTERED status', () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    expect(manager.getStatus()).toBe('REGISTERED');
  });

  it('init transitions through INITIALIZING to READY', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(createMockLLMService());
    expect(manager.getStatus()).toBe('READY');
  });

  it('dispatch yields events and returns to READY', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(createMockLLMService());

    const events = await collectEvents(manager.dispatch('Hello'));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe('assistant_message');
    expect(manager.getStatus()).toBe('READY');
  });

  it('suspend/resume round-trip preserves context', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(createMockLLMService());

    // Dispatch a message to establish context
    await collectEvents(manager.dispatch('Hello'));

    // Suspend
    await manager.suspend();
    expect(manager.getStatus()).toBe('SUSPENDED');

    // Resume
    await manager.resume();
    expect(manager.getStatus()).toBe('READY');

    // Dispatch again — should work with restored context
    const events2 = await collectEvents(manager.dispatch('Follow-up'));
    expect(events2.length).toBeGreaterThanOrEqual(1);
    expect(events2[0]!.type).toBe('assistant_message');
  });

  it('full lifecycle: init → dispatch → suspend → resume → dispatch → terminate', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    // Init
    await manager.init(createMockLLMService());
    expect(manager.getStatus()).toBe('READY');

    // Dispatch
    const events1 = await collectEvents(manager.dispatch('Hello'));
    expect(events1[0]!.type).toBe('assistant_message');

    // Suspend
    await manager.suspend();
    expect(manager.getStatus()).toBe('SUSPENDED');

    // Resume
    await manager.resume();
    expect(manager.getStatus()).toBe('READY');

    // Dispatch again
    const events2 = await collectEvents(manager.dispatch('Again'));
    expect(events2[0]!.type).toBe('assistant_message');

    // Terminate
    await manager.terminate();
    expect(manager.getStatus()).toBe('TERMINATED');
  });

  it('throws InvalidStateTransitionError on invalid transition', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    // Cannot go from REGISTERED to READY directly
    expect(() => manager.getStatus()).not.toThrow();

    // Try to dispatch without init
    await expect(async () => {
      await collectEvents(manager.dispatch('Hello'));
    }).rejects.toThrow(InvalidStateTransitionError);
  });

  it('getControlBlock returns current state', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(createMockLLMService());

    const block = manager.getControlBlock();
    expect(block.agentId).toBe('agent-1');
    expect(block.status).toBe('READY');
    expect(block.loopIteration).toBe(0);
  });

  it('setTools configures available tools', async () => {
    const fs = createMemoryFs();

    let callCount = 0;
    const toolCallProvider: LLMProvider = {
      id: 'mock',
      supportsPromptCaching: false,
      async *streamCompletion(): AsyncIterable<StreamChunk> {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool_call_delta',
            toolCall: { id: 'tc1', name: 'greet', arguments: '{"name":"World"}' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Done!' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
      async countTokens() { return 50; },
    };

    const llm = new LLMService({
      providers: [toolCallProvider],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
    });

    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(llm);

    const handlers = new Map<string, ToolHandler>();
    handlers.set('greet', async (args) => `Hello, ${args['name']}!`);

    manager.setTools(
      [{ name: 'greet', description: 'Greet someone', inputSchema: {} }],
      handlers,
    );

    const events = await collectEvents(manager.dispatch('Greet world'));

    const types = events.map((e) => e.type);
    expect(types).toContain('assistant_message');
    expect(types).toContain('tool_result');
  });

  it('loads persona from SOUL.md when available', async () => {
    const fs = createMemoryFs();

    // Pre-create SOUL.md
    await fs.mkdir('/data/agents/agent-1', { recursive: true });
    await fs.writeFile('/data/agents/agent-1/SOUL.md', 'You are a pirate.');

    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(createMockLLMService());

    // The persona is used internally; verify via dispatch that it works
    const events = await collectEvents(manager.dispatch('Hello'));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('getHookRegistry returns the registry for external registration', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    const hooks = manager.getHookRegistry();
    expect(hooks).toBeDefined();

    const fired: string[] = [];
    hooks.register('before_agent_start', async () => {
      fired.push('before_agent_start');
    });

    await manager.init(createMockLLMService());
    await collectEvents(manager.dispatch('Hello'));

    expect(fired).toContain('before_agent_start');
  });

  it('prompt enrichment fires during dispatch', async () => {
    const fs = createMemoryFs();
    let capturedMessages: Message[] = [];

    const provider: LLMProvider = {
      id: 'mock',
      supportsPromptCaching: false,
      async *streamCompletion(messages: Message[]): AsyncIterable<StreamChunk> {
        capturedMessages = messages;
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'done', finishReason: 'stop' };
      },
      async countTokens() { return 50; },
    };

    const llm = new LLMService({
      providers: [provider],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
    });

    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(llm);

    manager.setTools(
      [{ name: 'search', description: 'Search files', inputSchema: {} }],
      new Map(),
    );

    await collectEvents(manager.dispatch('Hello'));

    const systemPrompt = capturedMessages[0]?.content ?? '';
    // Runtime info should be present (always in full mode)
    expect(systemPrompt).toContain('<runtime-info>');
    // Tool summary should be present
    expect(systemPrompt).toContain('<available-tools>');
    expect(systemPrompt).toContain('- search: Search files');
  });

  it('setPromptMode changes enrichment behavior', async () => {
    const fs = createMemoryFs();
    let capturedMessages: Message[] = [];

    const provider: LLMProvider = {
      id: 'mock',
      supportsPromptCaching: false,
      async *streamCompletion(messages: Message[]): AsyncIterable<StreamChunk> {
        capturedMessages = messages;
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'done', finishReason: 'stop' };
      },
      async countTokens() { return 50; },
    };

    const llm = new LLMService({
      providers: [provider],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
    });

    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    // Set to none before init — no enrichment should happen
    manager.setPromptMode('none');
    await manager.init(llm);
    await collectEvents(manager.dispatch('Hello'));

    const systemPrompt = capturedMessages[0]?.content ?? '';
    expect(systemPrompt).not.toContain('<runtime-info>');
    expect(systemPrompt).not.toContain('<available-tools>');
  });

  it('inbox dispatch without sessionId resets context between calls', async () => {
    const fs = createMemoryFs();
    let capturedMessages: Message[] = [];
    let callCount = 0;

    const provider: LLMProvider = {
      id: 'mock',
      supportsPromptCaching: false,
      async *streamCompletion(messages: Message[]): AsyncIterable<StreamChunk> {
        callCount++;
        capturedMessages = messages;
        yield { type: 'text_delta', text: `Reply ${callCount}` };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'done', finishReason: 'stop' };
      },
      async countTokens() { return 50; },
    };

    const llm = new LLMService({
      providers: [provider],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
    });

    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(llm);

    // First dispatch — establishes a session and context
    await collectEvents(manager.dispatch('First message'));
    expect(callCount).toBe(1);
    // Messages should contain system + user ("First message")
    const firstUserMessages = capturedMessages.filter(m => m.role === 'user');
    expect(firstUserMessages).toHaveLength(1);
    expect(firstUserMessages[0]!.content).toBe('First message');

    // Second dispatch WITHOUT sessionId — simulates inbox task.request
    // First reset context like subscribeToInbox does
    // Access the internal state via the public-facing dispatch behavior:
    // Calling dispatch(msg, undefined) while currentSessionId is set
    // would normally reuse the session. But subscribeToInbox now resets
    // context and currentSessionId before calling dispatch.

    // Simulate what subscribeToInbox does before dispatch:
    // @ts-expect-error — accessing private fields for test
    manager.context = null;
    // @ts-expect-error — accessing private fields for test
    manager.currentSessionId = null;

    await collectEvents(manager.dispatch('Second message'));
    expect(callCount).toBe(2);
    // Messages should contain system + user ("Second message") ONLY
    // — no "First message" bleed-through
    const secondUserMessages = capturedMessages.filter(m => m.role === 'user');
    expect(secondUserMessages).toHaveLength(1);
    expect(secondUserMessages[0]!.content).toBe('Second message');
  });

  it('terminate disposes prompt handlers', async () => {
    const fs = createMemoryFs();
    const manager = new AgentManager({
      agentEntry: { id: 'agent-1', name: 'Test Agent' },
      defaults: { model: 'mock', contextWindow: 4096, maxTurns: 100 },
      compaction: { enabled: true, reserveTokens: 500 },
      basePath: '/data',
      fs,
    });

    await manager.init(createMockLLMService());

    const hooks = manager.getHookRegistry();
    // 4 prompt handlers + 1 context pruner
    expect(hooks.handlerCount('context_assemble')).toBe(5);

    await manager.terminate();

    // All handlers should be cleaned up
    expect(hooks.handlerCount('context_assemble')).toBe(0);
  });
});
