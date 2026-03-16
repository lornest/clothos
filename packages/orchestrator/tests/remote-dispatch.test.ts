import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent, AgentMessage } from '@clothos/core';
import type { RemoteDispatchTransport } from '../src/remote-dispatch.js';
import { RemoteAgentRegistryEntry } from '../src/remote-dispatch.js';

/** Build a minimal AgentMessage for testing. */
function msg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'msg-1',
    specversion: '1.0',
    type: 'task.response',
    source: 'agent://remote',
    target: 'orchestrator://local',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {},
    ...overrides,
  };
}

function createMockTransport(): RemoteDispatchTransport & {
  handlers: Map<string, (msg: AgentMessage) => void>;
  published: { subject: string; msg: AgentMessage }[];
  publishedCore: { subject: string; msg: AgentMessage }[];
} {
  const handlers = new Map<string, (msg: AgentMessage) => void>();
  const published: { subject: string; msg: AgentMessage }[] = [];
  const publishedCore: { subject: string; msg: AgentMessage }[] = [];
  let inboxCounter = 0;

  return {
    handlers,
    published,
    publishedCore,
    publish: vi.fn(async (subject: string, m: AgentMessage) => {
      published.push({ subject, msg: m });
    }),
    publishCore: vi.fn((subject: string, m: AgentMessage) => {
      publishedCore.push({ subject, msg: m });
    }),
    subscribeCoreNats: vi.fn((subject: string, handler: (m: AgentMessage) => void) => {
      handlers.set(subject, handler);
      return {
        unsubscribe: vi.fn(() => {
          handlers.delete(subject);
        }),
      };
    }),
    createInbox: vi.fn(() => `_INBOX.test.${++inboxCounter}`),
  };
}

describe('RemoteAgentRegistryEntry', () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    transport = createMockTransport();
  });

  it('returns READY status optimistically', () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'remote-agent',
      transport,
    });
    expect(entry.getStatus()).toBe('READY');
  });

  it('subscribes to reply inbox before publishing', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'remote-agent',
      transport,
    });

    const callOrder: string[] = [];
    const originalSubscribe = transport.subscribeCoreNats;
    transport.subscribeCoreNats = vi.fn((...args: Parameters<typeof originalSubscribe>) => {
      callOrder.push('subscribe');
      return originalSubscribe(...args);
    });
    const originalPublish = transport.publish;
    transport.publish = vi.fn(async (...args: Parameters<typeof originalPublish>) => {
      callOrder.push('publish');
      return originalPublish(...args);
    });

    const gen = entry.dispatch('hello');

    // Simulate reply after publish
    setTimeout(() => {
      const handler = transport.handlers.get('_INBOX.test.1');
      handler?.(msg({
        type: 'task.response',
        data: { event: { type: 'assistant_message', content: { text: 'hi' } } },
      }));
      handler?.(msg({ type: 'task.done' }));
    }, 10);

    const events: AgentEvent[] = [];
    for await (const e of gen) {
      events.push(e);
    }

    expect(callOrder).toEqual(['subscribe', 'publish']);
  });

  it('yields events from reply inbox and completes on task.done', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'remote-agent',
      transport,
    });

    const gen = entry.dispatch('hello');

    // Simulate replies
    setTimeout(() => {
      const handler = transport.handlers.get('_INBOX.test.1');
      handler?.(msg({
        type: 'task.response',
        data: { event: { type: 'assistant_message', content: { text: 'response-1' } } },
      }));
      handler?.(msg({
        type: 'task.response',
        data: { event: { type: 'tool_result', name: 'search', toolCallId: 'tc-1', result: 'ok' } },
      }));
      handler?.(msg({ type: 'task.done' }));
    }, 10);

    const events: AgentEvent[] = [];
    for await (const e of gen) {
      events.push(e);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'assistant_message', content: { text: 'response-1' } });
    expect(events[1]).toEqual({ type: 'tool_result', name: 'search', toolCallId: 'tc-1', result: 'ok' });
  });

  it('publishes task.request to agent inbox with replyTo', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'worker-1',
      transport,
    });

    const gen = entry.dispatch('do something', 'session-abc');

    // Immediately complete
    setTimeout(() => {
      const handler = transport.handlers.get('_INBOX.test.1');
      handler?.(msg({ type: 'task.done' }));
    }, 10);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) { /* drain */ }

    expect(transport.published).toHaveLength(1);
    const pub = transport.published[0]!;
    expect(pub.subject).toBe('agent.worker-1.inbox');
    expect(pub.msg.type).toBe('task.request');
    expect(pub.msg.replyTo).toBe('_INBOX.test.1');
    expect(pub.msg.target).toBe('agent://worker-1');
    expect((pub.msg.data as Record<string, unknown>)['text']).toBe('do something');
    expect((pub.msg.data as Record<string, unknown>)['sessionId']).toBe('session-abc');
  });

  it('errors on task.error reply', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'remote-agent',
      transport,
    });

    const gen = entry.dispatch('hello');

    setTimeout(() => {
      const handler = transport.handlers.get('_INBOX.test.1');
      handler?.(msg({
        type: 'task.error',
        data: { error: 'Agent crashed' },
      }));
    }, 10);

    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).rejects.toThrow('Agent crashed');
  });

  it('times out when no response arrives', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'slow-agent',
      transport,
      timeoutMs: 50,
    });

    const gen = entry.dispatch('hello');

    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).rejects.toThrow(/Timeout/);
  });

  it('cleans up subscription on early return', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'remote-agent',
      transport,
    });

    const gen = entry.dispatch('hello');

    // Push one event
    setTimeout(() => {
      const handler = transport.handlers.get('_INBOX.test.1');
      handler?.(msg({
        type: 'task.response',
        data: { event: { type: 'assistant_message', content: { text: 'partial' } } },
      }));
    }, 10);

    const first = await gen.next();
    expect(first.done).toBe(false);

    // Cancel the generator
    await gen.return(undefined as unknown as AgentEvent);

    // Subscription should be cleaned up
    expect(transport.handlers.has('_INBOX.test.1')).toBe(false);
  });

  it('cleans up subscription after normal completion', async () => {
    const entry = new RemoteAgentRegistryEntry({
      agentId: 'remote-agent',
      transport,
    });

    const gen = entry.dispatch('hello');

    setTimeout(() => {
      const handler = transport.handlers.get('_INBOX.test.1');
      handler?.(msg({ type: 'task.done' }));
    }, 10);

    for await (const _ of gen) { /* drain */ }

    expect(transport.handlers.has('_INBOX.test.1')).toBe(false);
  });
});
