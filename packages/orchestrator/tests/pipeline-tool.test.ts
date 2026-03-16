import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@clothos/core';
import type { AgentRegistry, AgentRegistryEntry } from '../src/agent-registry.js';
import { createPipelineHandler, pipelineToolDefinition } from '../src/tools/pipeline-tool.js';

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

describe('pipeline_execute tool', () => {
  it('has correct tool definition', () => {
    expect(pipelineToolDefinition.name).toBe('pipeline_execute');
    expect(pipelineToolDefinition.annotations?.riskLevel).toBe('yellow');
  });

  it('chains output of one agent as input to the next', async () => {
    const capturedInputs: string[] = [];

    const makeEntry = (id: string, output: string): AgentRegistryEntry => ({
      agentId: id,
      getStatus: () => 'READY' as any,
      dispatch: async function* (msg: string): AsyncGenerator<AgentEvent> {
        capturedInputs.push(msg);
        yield {
          type: 'assistant_message',
          content: { text: output },
        } as AgentEvent;
      },
    });

    const registry = createRegistry([
      makeEntry('step-1', 'Output from step 1'),
      makeEntry('step-2', 'Output from step 2'),
      makeEntry('step-3', 'Final output'),
    ]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [
        { agent: 'step-1', instruction: 'Parse data' },
        { agent: 'step-2', instruction: 'Transform data' },
        { agent: 'step-3', instruction: 'Summarize' },
      ],
      initialInput: 'Raw data here',
    }) as Record<string, unknown>;

    // First step receives the initial input
    expect(capturedInputs[0]).toContain('Raw data here');
    // Second step receives the output from step 1
    expect(capturedInputs[1]).toContain('Output from step 1');
    // Third step receives the output from step 2
    expect(capturedInputs[2]).toContain('Output from step 2');

    expect(result['finalOutput']).toBe('Final output');
  });

  it('returns finalOutput matching last step output', async () => {
    const registry = createRegistry([
      createEntry('agent-a', 'READY', 'Intermediate'),
      createEntry('agent-b', 'READY', 'The final answer'),
    ]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [
        { agent: 'agent-a', instruction: 'Do first' },
        { agent: 'agent-b', instruction: 'Do second' },
      ],
      initialInput: 'Start',
    }) as Record<string, unknown>;

    expect(result['finalOutput']).toBe('The final answer');
    const steps = result['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!['output']).toBe('Intermediate');
    expect(steps[1]!['output']).toBe('The final answer');
  });

  it('halts pipeline on error and returns partial results', async () => {
    const failEntry: AgentRegistryEntry = {
      agentId: 'fail-agent',
      getStatus: () => 'READY' as any,
      dispatch: async function* (): AsyncGenerator<AgentEvent> {
        throw new Error('Processing failed');
      },
    };

    const registry = createRegistry([
      createEntry('ok-agent', 'READY', 'Step 1 done'),
      failEntry,
      createEntry('never-reached', 'READY', 'Should not run'),
    ]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [
        { agent: 'ok-agent', instruction: 'First' },
        { agent: 'fail-agent', instruction: 'Second' },
        { agent: 'never-reached', instruction: 'Third' },
      ],
      initialInput: 'Start',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Pipeline halted');
    expect(result['finalOutput']).toBeUndefined();

    const steps = result['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!['output']).toBe('Step 1 done');
    expect(steps[1]!['error']).toContain('Processing failed');
  });

  it('handles unknown agent in a step and halts', async () => {
    const registry = createRegistry([
      createEntry('known-agent', 'READY', 'OK'),
    ]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [
        { agent: 'known-agent', instruction: 'First' },
        { agent: 'nonexistent', instruction: 'Second' },
      ],
      initialInput: 'Start',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('unknown agent');
    const steps = result['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!['output']).toBe('OK');
    expect(steps[1]!['error']).toContain('Unknown agent');
  });

  it('works with single-step pipeline', async () => {
    const registry = createRegistry([
      createEntry('solo', 'READY', 'Solo result'),
    ]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [{ agent: 'solo', instruction: 'Do it' }],
      initialInput: 'Input data',
    }) as Record<string, unknown>;

    expect(result['finalOutput']).toBe('Solo result');
    const steps = result['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]!['agent']).toBe('solo');
    expect(steps[0]!['output']).toBe('Solo result');
  });

  it('returns error for empty steps array', async () => {
    const registry = createRegistry([]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [],
      initialInput: 'Start',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('non-empty');
  });

  it('halts pipeline on unavailable agent', async () => {
    const registry = createRegistry([
      createEntry('agent-a', 'READY', 'Step 1 done'),
      createEntry('agent-b', 'SUSPENDED'),
    ]);

    const handler = createPipelineHandler({
      registry,
      callerAgentId: 'orchestrator',
    });

    const result = await handler({
      steps: [
        { agent: 'agent-a', instruction: 'First' },
        { agent: 'agent-b', instruction: 'Second' },
      ],
      initialInput: 'Start',
    }) as Record<string, unknown>;

    expect(result['error']).toContain('Pipeline halted');
    const steps = result['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!['output']).toBe('Step 1 done');
    expect(steps[1]!['error']).toContain('not available');
  });
});
