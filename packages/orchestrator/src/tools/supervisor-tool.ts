import type { ToolDefinition, ToolHandler } from '@clothos/core';
import type { AgentRegistry } from '../agent-registry.js';

/** Tool definition for orchestrate — supervisor pattern for multi-agent task decomposition. */
export const supervisorToolDefinition: ToolDefinition = {
  name: 'orchestrate',
  description:
    'Decompose a task across multiple worker agents (parallel or sequential), ' +
    'then synthesize their results into a final answer.',
  inputSchema: {
    type: 'object',
    properties: {
      subtasks: {
        type: 'array',
        description: 'List of subtasks to delegate.',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Target agent ID.' },
            task: { type: 'string', description: 'Task description for this agent.' },
          },
          required: ['agent', 'task'],
        },
      },
      mode: {
        type: 'string',
        enum: ['parallel', 'sequential'],
        description: 'Whether to run subtasks in parallel or sequentially. Default: parallel.',
      },
    },
    required: ['subtasks'],
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    riskLevel: 'yellow',
  },
};

export interface SupervisorHandlerOptions {
  registry: AgentRegistry;
  callerAgentId: string;
  defaultTimeoutMs?: number;
}

interface Subtask {
  agent: string;
  task: string;
}

/** Create a handler for the orchestrate (supervisor) tool. */
export function createSupervisorHandler(
  options: SupervisorHandlerOptions,
): ToolHandler {
  const { registry, callerAgentId, defaultTimeoutMs = 120_000 } = options;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const subtasks = args['subtasks'] as Subtask[];
    const mode = (args['mode'] as string | undefined) ?? 'parallel';

    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      return { error: 'subtasks must be a non-empty array' };
    }

    if (mode === 'parallel') {
      return runParallel(subtasks, registry, callerAgentId, defaultTimeoutMs);
    } else {
      return runSequential(subtasks, registry, callerAgentId, defaultTimeoutMs);
    }
  };
}

async function runParallel(
  subtasks: Subtask[],
  registry: AgentRegistry,
  callerAgentId: string,
  timeoutMs: number,
): Promise<unknown> {
  const promises = subtasks.map((st) =>
    dispatchSubtask(st, registry, callerAgentId, timeoutMs),
  );

  const settled = await Promise.allSettled(promises);
  const results = settled.map((r, i) => ({
    agent: subtasks[i]!.agent,
    task: subtasks[i]!.task,
    status: r.status,
    response: r.status === 'fulfilled' ? r.value : undefined,
    error: r.status === 'rejected' ? String(r.reason) : undefined,
  }));

  return { mode: 'parallel', results };
}

async function runSequential(
  subtasks: Subtask[],
  registry: AgentRegistry,
  callerAgentId: string,
  timeoutMs: number,
): Promise<unknown> {
  const results: Array<{
    agent: string;
    task: string;
    status: string;
    response?: string;
    error?: string;
  }> = [];

  for (const st of subtasks) {
    try {
      const response = await dispatchSubtask(st, registry, callerAgentId, timeoutMs);
      results.push({
        agent: st.agent,
        task: st.task,
        status: 'fulfilled',
        response,
      });
    } catch (err) {
      results.push({
        agent: st.agent,
        task: st.task,
        status: 'rejected',
        error: String(err),
      });
    }
  }

  return { mode: 'sequential', results };
}

async function dispatchSubtask(
  subtask: Subtask,
  registry: AgentRegistry,
  callerAgentId: string,
  timeoutMs: number,
): Promise<string> {
  const entry = registry.get(subtask.agent);
  if (!entry) {
    throw new Error(`Unknown agent: "${subtask.agent}"`);
  }

  const status = entry.getStatus();
  if (status !== 'READY' && status !== 'RUNNING') {
    throw new Error(`Agent "${subtask.agent}" is not available (status: ${status})`);
  }

  const message = `[Delegated from ${callerAgentId}]\n\nTask: ${subtask.task}`;
  return withTimeout(collectResponse(entry.dispatch(message)), timeoutMs);
}

async function collectResponse(
  generator: AsyncGenerator<{ type: string; content?: { text?: string } }>,
): Promise<string> {
  let lastText = '';
  for await (const event of generator) {
    if (event.type === 'assistant_message' && event.content?.text) {
      lastText = event.content.text;
    }
  }
  return lastText;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
