import {
  connect as natsConnect,
  JSONCodec,
  headers as natsHeaders,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  type Subscription as NatsSub,
  StringCodec,
  AckPolicy,
  RetentionPolicy,
  DeliverPolicy,
  createInbox as natsCreateInbox,
} from 'nats';
import { generateId } from '@clothos/core';
import type { AgentMessage } from '@clothos/core';
import type { StreamDefinition, MessageHandler, Subscription } from './types.js';

const jc = JSONCodec<AgentMessage>();
const sc = StringCodec();

const STREAMS: StreamDefinition[] = [
  {
    name: 'AGENT_TASKS',
    subjects: ['agent.*.inbox'],
    retention: 'workqueue',
    maxDeliver: 3,
    ackWaitNs: 30_000_000_000,
  },
  {
    name: 'AGENT_EVENTS',
    subjects: ['events.agent.>'],
    retention: 'interest',
    maxDeliver: 3,
    ackWaitNs: 30_000_000_000,
  },
  {
    name: 'SYSTEM',
    subjects: ['system.>'],
    retention: 'limits',
    maxDeliver: 3,
    ackWaitNs: 30_000_000_000,
    maxAge: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
  },
];

function retentionToNats(
  r: StreamDefinition['retention'],
): RetentionPolicy {
  switch (r) {
    case 'workqueue':
      return RetentionPolicy.Workqueue;
    case 'interest':
      return RetentionPolicy.Interest;
    case 'limits':
      return RetentionPolicy.Limits;
  }
}

export class NatsClient {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private subscriptions: NatsSub[] = [];

  async connect(url: string, credentials?: string): Promise<void> {
    this.nc = await natsConnect({
      servers: url,
      ...(credentials ? { authenticator: undefined } : {}),
    });
    this.jsm = await this.nc.jetstreamManager();
    this.js = this.nc.jetstream();

    await this.ensureStreams();
    this.subscribeDlqAdvisory();
  }

  private async ensureStreams(): Promise<void> {
    if (!this.jsm) throw new Error('NATS not connected');
    for (const def of STREAMS) {
      const streamExists = await this.streamExists(def.name);
      if (streamExists) {
        // Stream already exists — update its config
        await this.jsm.streams.update(def.name, {
          subjects: def.subjects,
          max_age: def.maxAge,
        });
      } else {
        // Create new stream
        await this.jsm.streams.add({
          name: def.name,
          subjects: def.subjects,
          retention: retentionToNats(def.retention),
          max_age: def.maxAge,
        });
      }
    }
  }

  private async streamExists(name: string): Promise<boolean> {
    try {
      await this.jsm!.streams.info(name);
      return true;
    } catch {
      return false;
    }
  }

  async publish(subject: string, msg: AgentMessage): Promise<void> {
    if (!this.js) throw new Error('NATS not connected');
    const hdrs = natsHeaders();
    hdrs.set('Nats-Msg-Id', msg.idempotencyKey ?? msg.id);
    await this.js.publish(subject, jc.encode(msg), { headers: hdrs });
  }

  async request(
    subject: string,
    msg: AgentMessage,
    timeoutMs = 5_000,
  ): Promise<AgentMessage> {
    if (!this.nc) throw new Error('NATS not connected');
    const response = await this.nc.request(subject, jc.encode(msg), {
      timeout: timeoutMs,
    });
    return jc.decode(response.data);
  }

  async fanOut(
    subjects: string[],
    msgs: AgentMessage[],
    timeoutMs = 5_000,
  ): Promise<AgentMessage[]> {
    if (!this.nc) throw new Error('NATS not connected');
    const correlationId = generateId();

    const promises = subjects.map((subject, i) => {
      const msg = { ...msgs[i]!, correlationId };
      return this.nc!.request(subject, jc.encode(msg), {
        timeout: timeoutMs,
      });
    });

    const responses = await Promise.all(promises);
    return responses.map((r) => jc.decode(r.data));
  }

  async subscribe(
    subject: string,
    handler: MessageHandler,
    queueGroup?: string,
  ): Promise<Subscription> {
    if (!this.js || !this.jsm) throw new Error('NATS not connected');

    const consumerName = `consumer-${subject.replace(/[.*>]/g, '-')}`;

    // Determine which stream this subject belongs to
    const streamName = this.findStreamForSubject(subject);
    if (!streamName) {
      throw new Error(`No stream found for subject: ${subject}`);
    }

    // Delete any stale durable consumer from a previous run and purge
    // its old messages so we start fresh.  Old unacked messages reference
    // WebSocket sessions that no longer exist and would block delivery of
    // new messages.  Workqueue streams require DeliverPolicy.All, so we
    // must purge the subject rather than changing the deliver policy.
    try {
      await this.jsm.consumers.delete(streamName, consumerName);
    } catch {
      // Consumer didn't exist — nothing to clean up.
    }
    try {
      await this.jsm.streams.purge(streamName, { filter: subject });
    } catch {
      // Best-effort purge — stream may be empty.
    }

    const consumerOpts: Parameters<JetStreamManager['consumers']['add']>[1] = {
      durable_name: consumerName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: subject,
      ...(queueGroup ? { deliver_group: queueGroup } : {}),
    };

    await this.jsm.consumers.add(streamName, consumerOpts);
    let consumer = await this.js.consumers.get(streamName, consumerName);
    let messages = await consumer.consume();

    // Process messages in the background
    const processMessages = async () => {
      for await (const m of messages) {
        try {
          const agentMsg = jc.decode(m.data);
          await handler(agentMsg);
          m.ack();
        } catch {
          m.nak();
        }
      }
    };
    processMessages();

    const js = this.js;
    const jsm = this.jsm!;
    return {
      subject,
      queueGroup,
      streamName,
      consumerName,
      unsubscribe: () => {
        messages.stop();
      },
      pause: () => {
        messages.stop();
      },
      resume: async () => {
        consumer = await js.consumers.get(streamName, consumerName);
        messages = await consumer.consume();
        processMessages();
      },
      destroy: async () => {
        messages.stop();
        try { await jsm.consumers.delete(streamName, consumerName); } catch { /* already gone */ }
        try { await jsm.streams.purge(streamName, { filter: subject }); } catch { /* best effort */ }
      },
    };
  }

  private subscribeDlqAdvisory(): void {
    if (!this.nc || !this.js) return;

    const sub = this.nc.subscribe(
      '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.*',
    );
    this.subscriptions.push(sub);

    const processAdvisory = async () => {
      for await (const msg of sub) {
        try {
          const advisory = JSON.parse(sc.decode(msg.data)) as {
            stream: string;
            consumer: string;
            stream_seq: number;
          };
          // Fetch the original message and republish to DLQ
          const stream = await this.jsm!.streams.getMessage(
            advisory.stream,
            { seq: advisory.stream_seq },
          );
          if (stream?.data) {
            const originalMsg = jc.decode(stream.data);
            const dlqSubject = `system.dlq.${advisory.stream.toLowerCase()}`;
            const dlqMsg: AgentMessage = {
              ...originalMsg,
              id: generateId(),
              type: 'system.dlq',
              metadata: {
                ...originalMsg.metadata,
                originalStream: advisory.stream,
                originalConsumer: advisory.consumer,
                originalSequence: String(advisory.stream_seq),
              },
            };
            await this.publish(dlqSubject, dlqMsg);
          }
        } catch {
          // Best-effort DLQ
        }
      }
    };
    processAdvisory();
  }

  private findStreamForSubject(subject: string): string | null {
    for (const def of STREAMS) {
      for (const pattern of def.subjects) {
        if (this.subjectMatchesPattern(subject, pattern)) {
          return def.name;
        }
      }
    }
    return null;
  }

  private subjectMatchesPattern(subject: string, pattern: string): boolean {
    const subParts = subject.split('.');
    const patParts = pattern.split('.');

    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i] === '>') return true;
      if (patParts[i] === '*') continue;
      if (i >= subParts.length || patParts[i] !== subParts[i]) return false;
    }
    return subParts.length === patParts.length;
  }

  /**
   * Publish to core NATS (not JetStream).  Required for reply inbox
   * subjects (`_INBOX.*`) which aren't captured by any stream.
   */
  publishCore(subject: string, msg: AgentMessage): void {
    if (!this.nc) throw new Error('NATS not connected');
    this.nc.publish(subject, jc.encode(msg));
  }

  /**
   * Ephemeral core NATS subscription (not JetStream).
   * Used for listening on reply inbox subjects.
   */
  subscribeCoreNats(
    subject: string,
    handler: (msg: AgentMessage) => void,
  ): { unsubscribe(): void } {
    if (!this.nc) throw new Error('NATS not connected');
    const sub = this.nc.subscribe(subject);
    this.subscriptions.push(sub);

    const process = async () => {
      for await (const m of sub) {
        try {
          handler(jc.decode(m.data));
        } catch {
          // Best-effort — handler errors are swallowed.
        }
      }
    };
    process();

    return {
      unsubscribe: () => {
        sub.unsubscribe();
        const idx = this.subscriptions.indexOf(sub);
        if (idx !== -1) this.subscriptions.splice(idx, 1);
      },
    };
  }

  /** Generate a unique reply inbox subject. */
  createInbox(): string {
    return natsCreateInbox();
  }

  isConnected(): boolean {
    return this.nc !== null && !this.nc.isClosed();
  }

  async close(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
      this.js = null;
      this.jsm = null;
    }
  }

  getStreamDefinitions(): readonly StreamDefinition[] {
    return STREAMS;
  }
}
