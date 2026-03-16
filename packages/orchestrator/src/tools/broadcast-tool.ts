import type { ToolDefinition, ToolHandler } from '@clothos/core';
import type { AgentRegistry } from '../agent-registry.js';

/** Tool definition for broadcast — fan-out to multiple agents. */
export const broadcastToolDefinition: ToolDefinition = {
  name: 'broadcast',
  description:
    'Send the same message to multiple agents and collect all responses. ' +
    'Useful for gathering diverse perspectives or parallel data collection.',
  inputSchema: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of agent IDs to send the message to.',
      },
      message: {
        type: 'string',
        description: 'The message to broadcast to all agents.',
      },
    },
    required: ['agents', 'message'],
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    riskLevel: 'yellow',
  },
};

export interface BroadcastHandlerOptions {
  registry: AgentRegistry;
  callerAgentId: string;
  defaultTimeoutMs?: number;
}

/** Create a handler for the broadcast tool. */
export function createBroadcastHandler(
  options: BroadcastHandlerOptions,
): ToolHandler {
  const { registry, callerAgentId, defaultTimeoutMs = 120_000 } = options;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const agents = args['agents'] as string[];
    const message = args['message'] as string;

    if (!Array.isArray(agents) || agents.length === 0) {
      return { error: 'agents must be a non-empty array' };
    }

    const formattedMessage = `[Broadcast from ${callerAgentId}]\n\n${message}`;

    const promises = agents.map(async (agentId) => {
      const entry = registry.get(agentId);
      if (!entry) {
        throw new Error(`Unknown agent: "${agentId}"`);
      }

      const status = entry.getStatus();
      if (status !== 'READY' && status !== 'RUNNING') {
        throw new Error(`Agent "${agentId}" not available (status: ${status})`);
      }

      return collectResponse(entry.dispatch(formattedMessage));
    });

    const settled = await Promise.allSettled(
      promises.map((p) => withTimeout(p, defaultTimeoutMs)),
    );

    const responses = settled.map((r, i) => ({
      agent: agents[i]!,
      status: r.status,
      response: r.status === 'fulfilled' ? r.value : undefined,
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));

    return { responses };
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
