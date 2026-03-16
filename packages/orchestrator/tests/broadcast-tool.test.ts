import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@clothos/core';
import type { AgentRegistry, AgentRegistryEntry } from '../src/agent-registry.js';
import { createBroadcastHandler, broadcastToolDefinition } from '../src/tools/broadcast-tool.js';

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
        content: { text: response ?? `Reply from ${agentId}` },
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

describe('broadcast tool', () => {
  it('has correct tool definition', () => {
    expect(broadcastToolDefinition.name).toBe('broadcast');
    expect(broadcastToolDefinition.annotations?.riskLevel).toBe('yellow');
  });

  it('sends same message to all agents and collects responses', async () => {
    const registry = createRegistry([
      createEntry('agent-a', 'READY', 'Answer A'),
      createEntry('agent-b', 'READY', 'Answer B'),
      createEntry('agent-c', 'READY', 'Answer C'),
    ]);

    const handler = createBroadcastHandler({
      registry,
      callerAgentId: 'coordinator',
    });

    const result = await handler({
      agents: ['agent-a', 'agent-b', 'agent-c'],
      message: 'What do you think?',
    }) as Record<string, unknown>;

    const responses = result['responses'] as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(3);

    expect(responses[0]!['agent']).toBe('agent-a');
    expect(responses[0]!['status']).toBe('fulfilled');
    expect(responses[0]!['response']).toBe('Answer A');
    expect(responses[0]!['error']).toBeUndefined();

    expect(responses[1]!['agent']).toBe('agent-b');
    expect(responses[1]!['response']).toBe('Answer B');

    expect(responses[2]!['agent']).toBe('agent-c');
    expect(responses[2]!['response']).toBe('Answer C');
  });

  it('handles mix of successful and failed agents', async () => {
    const registry = createRegistry([
      createEntry('good-agent', 'READY', 'Success'),
      createEntry('bad-agent', 'ERROR'),
      createEntry('good-agent-2', 'READY', 'Also success'),
    ]);

    const handler = createBroadcastHandler({
      registry,
      callerAgentId: 'coordinator',
    });

    const result = await handler({
      agents: ['good-agent', 'bad-agent', 'unknown-agent', 'good-agent-2'],
      message: 'Hello everyone',
    }) as Record<string, unknown>;

    const responses = result['responses'] as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(4);

    // good-agent succeeds
    expect(responses[0]!['agent']).toBe('good-agent');
    expect(responses[0]!['status']).toBe('fulfilled');
    expect(responses[0]!['response']).toBe('Success');

    // bad-agent is unavailable
    expect(responses[1]!['agent']).toBe('bad-agent');
    expect(responses[1]!['status']).toBe('rejected');
    expect(responses[1]!['error']).toContain('not available');

    // unknown-agent does not exist
    expect(responses[2]!['agent']).toBe('unknown-agent');
    expect(responses[2]!['status']).toBe('rejected');
    expect(responses[2]!['error']).toContain('Unknown agent');

    // good-agent-2 succeeds despite earlier failures
    expect(responses[3]!['agent']).toBe('good-agent-2');
    expect(responses[3]!['status']).toBe('fulfilled');
    expect(responses[3]!['response']).toBe('Also success');
  });

  it('returns error for empty agents array', async () => {
    const registry = createRegistry([]);

    const handler = createBroadcastHandler({
      registry,
      callerAgentId: 'coordinator',
    });

    const result = await handler({
      agents: [],
      message: 'Hello',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('non-empty');
  });

  it('formats message with broadcast prefix from caller', async () => {
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
    const handler = createBroadcastHandler({
      registry,
      callerAgentId: 'boss-agent',
    });

    await handler({
      agents: ['worker'],
      message: 'Gather data',
    });

    expect(capturedMessage).toContain('[Broadcast from boss-agent]');
    expect(capturedMessage).toContain('Gather data');
  });

  it('handles dispatch errors within individual agents', async () => {
    const failEntry: AgentRegistryEntry = {
      agentId: 'fail-agent',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        throw new Error('LLM crashed');
      },
    };

    const registry = createRegistry([
      createEntry('ok-agent', 'READY', 'Fine'),
      failEntry,
    ]);

    const handler = createBroadcastHandler({
      registry,
      callerAgentId: 'coordinator',
    });

    const result = await handler({
      agents: ['ok-agent', 'fail-agent'],
      message: 'Do work',
    }) as Record<string, unknown>;

    const responses = result['responses'] as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);

    expect(responses[0]!['status']).toBe('fulfilled');
    expect(responses[0]!['response']).toBe('Fine');

    expect(responses[1]!['status']).toBe('rejected');
    expect(responses[1]!['error']).toContain('LLM crashed');
  });
});
