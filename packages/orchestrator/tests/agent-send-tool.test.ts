import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@clothos/core';
import type { AgentRegistry, AgentRegistryEntry } from '../src/agent-registry.js';
import { createAgentSendHandler, agentSendToolDefinition } from '../src/tools/agent-send-tool.js';

function createEntry(
  agentId: string,
  status: string = 'READY',
  response?: string,
): AgentRegistryEntry {
  return {
    agentId,
    getStatus: () => status as any,
    dispatch: async function* (msg: string): AsyncGenerator<AgentEvent> {
      yield {
        type: 'assistant_message',
        content: { text: response ?? `Reply to: ${msg}` },
      } as AgentEvent;
    },
  };
}

function createRegistry(entries: AgentRegistryEntry[]): AgentRegistry {
  const map = new Map(entries.map((e) => [e.agentId, e]));
  return {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    getAll: () => entries,
    getAvailable: () => entries.filter((e) => {
      const s = e.getStatus();
      return s === 'READY' || s === 'RUNNING';
    }),
  };
}

describe('agent_send tool', () => {
  it('has correct tool definition', () => {
    expect(agentSendToolDefinition.name).toBe('agent_send');
    expect(agentSendToolDefinition.annotations?.riskLevel).toBe('yellow');
  });

  it('fire-and-forget mode returns immediately', async () => {
    let dispatched = false;
    const entry: AgentRegistryEntry = {
      agentId: 'worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        dispatched = true;
        yield { type: 'assistant_message', content: { text: 'done' } } as AgentEvent;
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'sender',
    });

    const result = await handler({
      targetAgent: 'worker',
      message: 'Hello',
    }) as Record<string, unknown>;

    expect(result['sent']).toBe(true);
    expect(result['agent']).toBe('worker');

    // Give async dispatch time to execute
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched).toBe(true);
  });

  it('wait-for-reply mode returns the reply', async () => {
    const registry = createRegistry([
      createEntry('worker', 'READY', 'Here is my reply'),
    ]);

    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'sender',
    });

    const result = await handler({
      targetAgent: 'worker',
      message: 'What is 2+2?',
      waitForReply: true,
    }) as Record<string, unknown>;

    expect(result['agent']).toBe('worker');
    expect(result['reply']).toBe('Here is my reply');
  });

  it('returns error for unknown agent', async () => {
    const registry = createRegistry([]);
    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'sender',
    });

    const result = await handler({
      targetAgent: 'nonexistent',
      message: 'Hello',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Unknown agent');
  });

  it('returns error for unavailable agent', async () => {
    const registry = createRegistry([
      createEntry('worker', 'ERROR'),
    ]);
    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'sender',
    });

    const result = await handler({
      targetAgent: 'worker',
      message: 'Hello',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('not available');
  });

  it('formats message with caller prefix', async () => {
    let capturedMessage = '';
    const entry: AgentRegistryEntry = {
      agentId: 'worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (msg: string): AsyncGenerator<AgentEvent> {
        capturedMessage = msg;
        yield { type: 'assistant_message', content: { text: 'ok' } } as AgentEvent;
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'agent-a',
    });

    await handler({
      targetAgent: 'worker',
      message: 'Check this out',
      waitForReply: true,
    });

    expect(capturedMessage).toContain('[Message from agent-a]');
    expect(capturedMessage).toContain('Check this out');
  });

  it('handles dispatch errors in wait-for-reply mode', async () => {
    const entry: AgentRegistryEntry = {
      agentId: 'broken-worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        throw new Error('Dispatch failed');
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'sender',
    });

    const result = await handler({
      targetAgent: 'broken-worker',
      message: 'Hello',
      waitForReply: true,
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Dispatch failed');
  });

  it('times out in wait-for-reply mode', async () => {
    const entry: AgentRegistryEntry = {
      agentId: 'slow-worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        await new Promise((r) => setTimeout(r, 5000));
        yield { type: 'assistant_message', content: { text: 'too late' } } as AgentEvent;
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSendHandler({
      registry,
      callerAgentId: 'sender',
      defaultReplyTimeoutMs: 50,
    });

    const result = await handler({
      targetAgent: 'slow-worker',
      message: 'Hello',
      waitForReply: true,
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Timeout');
  });
});
