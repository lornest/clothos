import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@clothos/core';
import type { AgentRegistry, AgentRegistryEntry } from '../src/agent-registry.js';
import { createSupervisorHandler, supervisorToolDefinition } from '../src/tools/supervisor-tool.js';

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

describe('orchestrate (supervisor) tool', () => {
  it('has correct tool definition', () => {
    expect(supervisorToolDefinition.name).toBe('orchestrate');
    expect(supervisorToolDefinition.annotations?.riskLevel).toBe('yellow');
  });

  it('parallel mode dispatches to multiple agents concurrently and collects results', async () => {
    const registry = createRegistry([
      createEntry('agent-a', 'READY', 'Response A'),
      createEntry('agent-b', 'READY', 'Response B'),
      createEntry('agent-c', 'READY', 'Response C'),
    ]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [
        { agent: 'agent-a', task: 'Task A' },
        { agent: 'agent-b', task: 'Task B' },
        { agent: 'agent-c', task: 'Task C' },
      ],
      mode: 'parallel',
    }) as Record<string, unknown>;

    expect(result['mode']).toBe('parallel');
    const results = result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);

    expect(results[0]!['agent']).toBe('agent-a');
    expect(results[0]!['task']).toBe('Task A');
    expect(results[0]!['status']).toBe('fulfilled');
    expect(results[0]!['response']).toBe('Response A');
    expect(results[0]!['error']).toBeUndefined();

    expect(results[1]!['agent']).toBe('agent-b');
    expect(results[1]!['response']).toBe('Response B');

    expect(results[2]!['agent']).toBe('agent-c');
    expect(results[2]!['response']).toBe('Response C');
  });

  it('defaults to parallel mode when mode is not specified', async () => {
    const registry = createRegistry([
      createEntry('agent-a', 'READY', 'Response A'),
    ]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [{ agent: 'agent-a', task: 'Task A' }],
    }) as Record<string, unknown>;

    expect(result['mode']).toBe('parallel');
  });

  it('sequential mode dispatches one-by-one', async () => {
    const order: string[] = [];

    const makeEntry = (id: string): AgentRegistryEntry => ({
      agentId: id,
      getStatus: () => 'READY' as any,
      dispatch: async function* (msg: string): AsyncGenerator<AgentEvent> {
        order.push(id);
        yield {
          type: 'assistant_message',
          content: { text: `Done by ${id}` },
        } as AgentEvent;
      },
    });

    const registry = createRegistry([makeEntry('first'), makeEntry('second'), makeEntry('third')]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [
        { agent: 'first', task: 'Step 1' },
        { agent: 'second', task: 'Step 2' },
        { agent: 'third', task: 'Step 3' },
      ],
      mode: 'sequential',
    }) as Record<string, unknown>;

    expect(result['mode']).toBe('sequential');
    expect(order).toEqual(['first', 'second', 'third']);

    const results = result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results[0]!['status']).toBe('fulfilled');
    expect(results[0]!['response']).toBe('Done by first');
    expect(results[1]!['status']).toBe('fulfilled');
    expect(results[2]!['status']).toBe('fulfilled');
  });

  it('handles unavailable agents gracefully with rejected status', async () => {
    const registry = createRegistry([
      createEntry('good-agent', 'READY', 'All good'),
      createEntry('bad-agent', 'ERROR'),
    ]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [
        { agent: 'good-agent', task: 'Do work' },
        { agent: 'bad-agent', task: 'Try work' },
      ],
      mode: 'parallel',
    }) as Record<string, unknown>;

    const results = result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);

    expect(results[0]!['status']).toBe('fulfilled');
    expect(results[0]!['response']).toBe('All good');

    expect(results[1]!['status']).toBe('rejected');
    expect(results[1]!['error']).toContain('not available');
    expect(results[1]!['response']).toBeUndefined();
  });

  it('handles unknown agents gracefully with rejected status', async () => {
    const registry = createRegistry([]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [
        { agent: 'nonexistent', task: 'Do work' },
      ],
      mode: 'parallel',
    }) as Record<string, unknown>;

    const results = result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!['status']).toBe('rejected');
    expect(results[0]!['error']).toContain('Unknown agent');
  });

  it('returns error for empty subtasks array', async () => {
    const registry = createRegistry([]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [],
    }) as Record<string, unknown>;

    expect(result['error']).toContain('non-empty');
  });

  it('results include agent id, task, status, response, and error fields', async () => {
    const registry = createRegistry([
      createEntry('worker', 'READY', 'Done'),
    ]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [{ agent: 'worker', task: 'My task' }],
      mode: 'sequential',
    }) as Record<string, unknown>;

    const results = result['results'] as Array<Record<string, unknown>>;
    const entry = results[0]!;
    expect(entry).toHaveProperty('agent', 'worker');
    expect(entry).toHaveProperty('task', 'My task');
    expect(entry).toHaveProperty('status', 'fulfilled');
    expect(entry).toHaveProperty('response', 'Done');
    expect(entry['error']).toBeUndefined();
  });

  it('sequential mode records rejected status on error and continues', async () => {
    const registry = createRegistry([
      createEntry('ok-agent', 'READY', 'Fine'),
      createEntry('err-agent', 'SUSPENDED'),
      createEntry('ok-agent2', 'READY', 'Also fine'),
    ]);

    const handler = createSupervisorHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      subtasks: [
        { agent: 'ok-agent', task: 'A' },
        { agent: 'err-agent', task: 'B' },
        { agent: 'ok-agent2', task: 'C' },
      ],
      mode: 'sequential',
    }) as Record<string, unknown>;

    const results = result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results[0]!['status']).toBe('fulfilled');
    expect(results[1]!['status']).toBe('rejected');
    expect(results[1]!['error']).toContain('not available');
    expect(results[2]!['status']).toBe('fulfilled');
  });
});
