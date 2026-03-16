import type { ToolDefinition, ToolHandler } from '@clothos/core';
import type { AgentRegistry } from '../agent-registry.js';

/** Tool definition for pipeline_execute — sequential chain of agents. */
export const pipelineToolDefinition: ToolDefinition = {
  name: 'pipeline_execute',
  description:
    'Execute a sequential pipeline where each agent\'s output feeds into the next agent\'s input. ' +
    'Useful for multi-step processing chains.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered list of pipeline steps.',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Agent ID for this step.' },
            instruction: {
              type: 'string',
              description: 'Instruction template. The previous step output is appended automatically.',
            },
          },
          required: ['agent', 'instruction'],
        },
      },
      initialInput: {
        type: 'string',
        description: 'The initial input to feed into the first step.',
      },
    },
    required: ['steps', 'initialInput'],
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    riskLevel: 'yellow',
  },
};

export interface PipelineHandlerOptions {
  registry: AgentRegistry;
  callerAgentId: string;
  defaultTimeoutMs?: number;
}

interface PipelineStep {
  agent: string;
  instruction: string;
}

/** Create a handler for the pipeline_execute tool. */
export function createPipelineHandler(
  options: PipelineHandlerOptions,
): ToolHandler {
  const { registry, callerAgentId, defaultTimeoutMs = 120_000 } = options;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const steps = args['steps'] as PipelineStep[];
    let currentInput = args['initialInput'] as string;

    if (!Array.isArray(steps) || steps.length === 0) {
      return { error: 'steps must be a non-empty array' };
    }

    const stepResults: Array<{
      agent: string;
      instruction: string;
      output?: string;
      error?: string;
    }> = [];

    for (const step of steps) {
      const entry = registry.get(step.agent);
      if (!entry) {
        stepResults.push({
          agent: step.agent,
          instruction: step.instruction,
          error: `Unknown agent: "${step.agent}"`,
        });
        return { steps: stepResults, error: `Pipeline halted: unknown agent "${step.agent}"` };
      }

      const status = entry.getStatus();
      if (status !== 'READY' && status !== 'RUNNING') {
        stepResults.push({
          agent: step.agent,
          instruction: step.instruction,
          error: `Agent "${step.agent}" not available (status: ${status})`,
        });
        return { steps: stepResults, error: `Pipeline halted: agent "${step.agent}" unavailable` };
      }

      const message =
        `[Pipeline step from ${callerAgentId}]\n\n` +
        `Instruction: ${step.instruction}\n\n` +
        `Input:\n${currentInput}`;

      try {
        const output = await withTimeout(
          collectResponse(entry.dispatch(message)),
          defaultTimeoutMs,
        );
        stepResults.push({ agent: step.agent, instruction: step.instruction, output });
        currentInput = output;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        stepResults.push({
          agent: step.agent,
          instruction: step.instruction,
          error: errMsg,
        });
        return { steps: stepResults, error: `Pipeline halted at step ${stepResults.length}: ${errMsg}` };
      }
    }

    return {
      steps: stepResults,
      finalOutput: currentInput,
    };
  };
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
