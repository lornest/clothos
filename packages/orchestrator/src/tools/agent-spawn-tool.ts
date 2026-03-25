import type { ToolDefinition, ToolHandler } from '@clothos/core';
import type { AgentRegistry } from '../agent-registry.js';

/** Tool definition for agent_spawn — delegates a task to another agent. */
export const agentSpawnToolDefinition: ToolDefinition = {
  name: 'agent_spawn',
  description:
    'Delegate a task to another agent and wait for its response. ' +
    'Use this when a task is better handled by a specialized agent.',
  inputSchema: {
    type: 'object',
    properties: {
      targetAgent: {
        type: 'string',
        description: 'The ID of the agent to delegate to.',
      },
      task: {
        type: 'string',
        description: 'The task description or message to send to the target agent.',
      },
      context: {
        type: 'string',
        description: 'Optional additional context for the target agent.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds. Uses configured default if not specified.',
      },
      planMode: {
        type: 'boolean',
        description: 'If true, target agent enters plan mode and creates an implementation plan before executing the task.',
      },
      planSlug: {
        type: 'string',
        description: 'Slug for the plan file when planMode is true. Defaults to a generated name.',
      },
    },
    required: ['targetAgent', 'task'],
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    riskLevel: 'yellow',
  },
};

export interface AgentSpawnHandlerOptions {
  registry: AgentRegistry;
  callerAgentId: string;
  defaultTimeoutMs?: number;
}

/** Create a handler for the agent_spawn tool. */
export function createAgentSpawnHandler(
  options: AgentSpawnHandlerOptions,
): ToolHandler {
  const { registry, callerAgentId, defaultTimeoutMs = 120_000 } = options;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const targetAgent = args['targetAgent'] as string;
    const task = args['task'] as string;
    const context = args['context'] as string | undefined;
    const timeout = (args['timeout'] as number | undefined) ?? defaultTimeoutMs;
    const planMode = args['planMode'] as boolean | undefined;
    const planSlug = args['planSlug'] as string | undefined;

    // Look up target
    const entry = registry.get(targetAgent);
    if (!entry) {
      return { error: `Unknown agent: "${targetAgent}"` };
    }

    // Check availability
    const status = entry.getStatus();
    if (status !== 'READY' && status !== 'RUNNING') {
      return { error: `Agent "${targetAgent}" is not available (status: ${status})` };
    }

    // Enter plan mode on target if requested
    if (planMode && entry.enterPlanMode) {
      const slug = planSlug ?? `delegated-${Date.now()}`;
      try {
        await entry.enterPlanMode({ slug, goal: task });
      } catch (err) {
        return { error: `Failed to enter plan mode on "${targetAgent}": ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Build delegation message
    const delegationPrefix = `[Delegated from ${callerAgentId}]`;
    const formattedMessage = context
      ? `${delegationPrefix}\n\nTask: ${task}\n\nContext: ${context}`
      : `${delegationPrefix}\n\nTask: ${task}`;

    // Dispatch with timeout
    try {
      const result = await withTimeout(
        collectResponse(entry.dispatch(formattedMessage)),
        timeout,
      );
      return { agent: targetAgent, response: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `agent_spawn failed for "${targetAgent}": ${message}` };
    }
  };
}

/** Collect the final assistant_message text from a dispatch generator. */
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

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
