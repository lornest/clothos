import type { ToolDefinition, ToolHandler } from '@clothos/core';
import type { AgentRegistry } from '../agent-registry.js';

/** Tool definition for agent_send — send a message to another agent. */
export const agentSendToolDefinition: ToolDefinition = {
  name: 'agent_send',
  description:
    'Send a message to another agent. Can fire-and-forget or wait for a reply.',
  inputSchema: {
    type: 'object',
    properties: {
      targetAgent: {
        type: 'string',
        description: 'The ID of the agent to send the message to.',
      },
      message: {
        type: 'string',
        description: 'The message to send.',
      },
      waitForReply: {
        type: 'boolean',
        description: 'Whether to wait for a reply. Default: false.',
      },
      maxExchanges: {
        type: 'number',
        description: 'Maximum number of back-and-forth exchanges when waiting for reply.',
      },
      planMode: {
        type: 'boolean',
        description: 'If true, target agent enters plan mode and creates an implementation plan before processing the message.',
      },
      planSlug: {
        type: 'string',
        description: 'Slug for the plan file when planMode is true. Defaults to a generated name.',
      },
    },
    required: ['targetAgent', 'message'],
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    riskLevel: 'yellow',
  },
};

export interface AgentSendHandlerOptions {
  registry: AgentRegistry;
  callerAgentId: string;
  defaultReplyTimeoutMs?: number;
  defaultMaxExchanges?: number;
}

/** Create a handler for the agent_send tool. */
export function createAgentSendHandler(
  options: AgentSendHandlerOptions,
): ToolHandler {
  const {
    registry,
    callerAgentId,
    defaultReplyTimeoutMs = 30_000,
    defaultMaxExchanges = 5,
  } = options;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const targetAgent = args['targetAgent'] as string;
    const message = args['message'] as string;
    const waitForReply = (args['waitForReply'] as boolean | undefined) ?? false;
    const maxExchanges = (args['maxExchanges'] as number | undefined) ?? defaultMaxExchanges;
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
        await entry.enterPlanMode({ slug, goal: message });
      } catch (err) {
        return { error: `Failed to enter plan mode on "${targetAgent}": ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const formattedMessage = `[Message from ${callerAgentId}]\n\n${message}`;

    if (!waitForReply) {
      // Fire-and-forget: dispatch async, don't await
      void drainGenerator(entry.dispatch(formattedMessage));
      return { sent: true, agent: targetAgent };
    }

    // Wait-for-reply mode
    try {
      const reply = await withTimeout(
        collectResponse(entry.dispatch(formattedMessage), maxExchanges),
        defaultReplyTimeoutMs,
      );
      return { agent: targetAgent, reply };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return { error: `agent_send to "${targetAgent}" failed: ${errMessage}` };
    }
  };
}

/** Collect the final assistant_message text, up to maxExchanges. */
async function collectResponse(
  generator: AsyncGenerator<{ type: string; content?: { text?: string } }>,
  _maxExchanges: number,
): Promise<string> {
  let lastText = '';
  for await (const event of generator) {
    if (event.type === 'assistant_message' && event.content?.text) {
      lastText = event.content.text;
    }
  }
  return lastText;
}

/** Drain an async generator without blocking. */
async function drainGenerator(
  generator: AsyncGenerator<unknown>,
): Promise<void> {
  try {
    for await (const _ of generator) {
      // discard events
    }
  } catch {
    // best-effort fire-and-forget
  }
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
