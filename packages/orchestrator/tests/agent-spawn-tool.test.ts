import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@clothos/core';
import type { AgentRegistry, AgentRegistryEntry } from '../src/agent-registry.js';
import { createAgentSpawnHandler, agentSpawnToolDefinition } from '../src/tools/agent-spawn-tool.js';

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
        content: { text: response ?? `Response to: ${msg}` },
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

describe('agent_spawn tool', () => {
  it('has correct tool definition', () => {
    expect(agentSpawnToolDefinition.name).toBe('agent_spawn');
    expect(agentSpawnToolDefinition.annotations?.riskLevel).toBe('yellow');
  });

  it('successfully delegates to a target agent', async () => {
    const registry = createRegistry([
      createEntry('worker', 'READY', 'Task completed successfully'),
    ]);

    const handler = createAgentSpawnHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      targetAgent: 'worker',
      task: 'Do something useful',
    }) as Record<string, unknown>;

    expect(result['agent']).toBe('worker');
    expect(result['response']).toBe('Task completed successfully');
  });

  it('includes context in delegation message', async () => {
    let capturedMessage = '';
    const entry: AgentRegistryEntry = {
      agentId: 'worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (msg: string): AsyncGenerator<AgentEvent> {
        capturedMessage = msg;
        yield { type: 'assistant_message', content: { text: 'done' } } as AgentEvent;
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSpawnHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    await handler({
      targetAgent: 'worker',
      task: 'Analyze data',
      context: 'Use the latest dataset',
    });

    expect(capturedMessage).toContain('[Delegated from supervisor]');
    expect(capturedMessage).toContain('Task: Analyze data');
    expect(capturedMessage).toContain('Context: Use the latest dataset');
  });

  it('returns error for unknown agent', async () => {
    const registry = createRegistry([]);
    const handler = createAgentSpawnHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      targetAgent: 'nonexistent',
      task: 'Do something',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Unknown agent');
  });

  it('returns error for unavailable agent', async () => {
    const registry = createRegistry([
      createEntry('worker', 'SUSPENDED'),
    ]);
    const handler = createAgentSpawnHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      targetAgent: 'worker',
      task: 'Do something',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('not available');
    expect(result['error']).toContain('SUSPENDED');
  });

  it('returns error on timeout', async () => {
    const entry: AgentRegistryEntry = {
      agentId: 'slow-worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        // Simulate a slow agent by never yielding
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield { type: 'assistant_message', content: { text: 'too late' } } as AgentEvent;
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSpawnHandler({
      registry,
      callerAgentId: 'supervisor',
      defaultTimeoutMs: 50,
    });

    const result = await handler({
      targetAgent: 'slow-worker',
      task: 'Do something',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Timeout');
  });

  it('handles dispatch errors gracefully', async () => {
    const entry: AgentRegistryEntry = {
      agentId: 'broken-worker',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        throw new Error('LLM service crashed');
      },
    };

    const registry = createRegistry([entry]);
    const handler = createAgentSpawnHandler({
      registry,
      callerAgentId: 'supervisor',
    });

    const result = await handler({
      targetAgent: 'broken-worker',
      task: 'Do something',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('LLM service crashed');
  });
});
