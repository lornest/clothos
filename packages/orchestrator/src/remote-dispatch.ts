import type { AgentEvent, AgentMessage, AgentStatus } from '@clothos/core';
import { generateId, now } from '@clothos/core';
import type { AgentRegistryEntry } from './agent-registry.js';
import { AsyncEventQueue } from './async-event-queue.js';

/**
 * Transport abstraction so `@clothos/orchestrator` stays free of
 * the `nats` npm dependency. The concrete implementation (wrapping
 * NatsClient) is assembled in `@clothos/app`.
 */
export interface RemoteDispatchTransport {
  /** JetStream publish to an agent inbox (durable). */
  publish(subject: string, msg: AgentMessage): Promise<void>;
  /** Core NATS publish to a reply subject (ephemeral, non-JetStream). */
  publishCore(subject: string, msg: AgentMessage): void;
  /** Ephemeral core NATS subscription for reply inboxes. */
  subscribeCoreNats(
    subject: string,
    handler: (msg: AgentMessage) => void,
  ): { unsubscribe(): void };
  /** Generate a unique reply inbox subject. */
  createInbox(): string;
}

export interface RemoteAgentRegistryEntryOptions {
  agentId: string;
  transport: RemoteDispatchTransport;
  timeoutMs?: number;
}

const DEFAULT_REMOTE_TIMEOUT_MS = 120_000;

/**
 * Implements `AgentRegistryEntry` for an agent that may live on another
 * node. Dispatch sends a `task.request` via JetStream and listens for
 * `task.response` / `task.done` / `task.error` on a unique reply inbox
 * via core NATS.
 */
export class RemoteAgentRegistryEntry implements AgentRegistryEntry {
  readonly agentId: string;
  private readonly transport: RemoteDispatchTransport;
  private readonly timeoutMs: number;

  constructor(opts: RemoteAgentRegistryEntryOptions) {
    this.agentId = opts.agentId;
    this.transport = opts.transport;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  }

  /** Optimistic — timeout handles actual unavailability. */
  getStatus(): AgentStatus {
    return 'READY' as AgentStatus;
  }

  async *dispatch(message: string, sessionId?: string): AsyncGenerator<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const replySubject = this.transport.createInbox();

    // Subscribe to the reply inbox BEFORE publishing (prevents race).
    console.log(`[REMOTE-DISPATCH] Subscribing to reply inbox: ${replySubject}`);
    const sub = this.transport.subscribeCoreNats(replySubject, (reply: AgentMessage) => {
      console.log(`[REMOTE-DISPATCH] Reply received on ${replySubject}: type=${reply.type}`);
      if (reply.type === 'task.done') {
        queue.complete();
      } else if (reply.type === 'task.error') {
        const errorData = reply.data as Record<string, unknown> | undefined;
        const errorMsg = typeof errorData?.['error'] === 'string'
          ? errorData['error']
          : 'Remote agent error';
        console.log(`[REMOTE-DISPATCH] Error from remote: ${errorMsg}`);
        queue.error(new Error(errorMsg));
      } else if (reply.type === 'task.response') {
        const data = reply.data as Record<string, unknown> | undefined;
        if (data?.['event']) {
          const evt = data['event'] as AgentEvent;
          console.log(`[REMOTE-DISPATCH] Event: type=${evt.type}`);
          queue.push(evt);
        }
      }
    });

    // Timeout timer
    const timer = setTimeout(() => {
      queue.error(new Error(`Timeout waiting for remote agent "${this.agentId}" (${this.timeoutMs}ms)`));
    }, this.timeoutMs);

    try {
      // Publish task.request to the agent's JetStream inbox.
      const taskMsg: AgentMessage = {
        id: generateId(),
        specversion: '1.0',
        type: 'task.request',
        source: 'orchestrator://local',
        target: `agent://${this.agentId}`,
        time: now(),
        datacontenttype: 'application/json',
        data: { text: message, ...(sessionId ? { sessionId } : {}) },
        replyTo: replySubject,
      };

      console.log(`[REMOTE-DISPATCH] Publishing task.request to agent.${this.agentId}.inbox (replyTo: ${replySubject})`);
      await this.transport.publish(`agent.${this.agentId}.inbox`, taskMsg);
      console.log(`[REMOTE-DISPATCH] Published. Waiting for replies...`);

      // Yield events as they arrive from the reply inbox.
      yield* queue;
      console.log(`[REMOTE-DISPATCH] Queue drained for ${this.agentId}`);
    } finally {
      clearTimeout(timer);
      sub.unsubscribe();
    }
  }
}
