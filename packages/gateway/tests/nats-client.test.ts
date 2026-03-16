import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NatsClient } from '../src/nats-client.js';
import type { AgentMessage } from '@clothos/core';

function makeMsg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'msg-1',
    specversion: '1.0',
    type: 'task.request',
    source: 'agent://sender',
    target: 'agent://receiver',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: { task: 'test' },
    ...overrides,
  };
}

// Build mock infrastructure
const mockStop = vi.fn();
const mockConsume = vi.fn().mockResolvedValue({
  [Symbol.asyncIterator]: () => ({
    next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
  }),
  stop: mockStop,
});

const mockConsumersGet = vi.fn().mockResolvedValue({
  consume: mockConsume,
});

const mockConsumersAdd = vi.fn().mockResolvedValue({});
const mockConsumersDelete = vi.fn().mockResolvedValue(undefined);

const mockStreamsAdd = vi.fn().mockResolvedValue({});
const mockStreamsUpdate = vi.fn().mockResolvedValue({});
const mockStreamsInfo = vi.fn().mockRejectedValue(new Error('stream not found'));
const mockStreamsGetMessage = vi.fn().mockResolvedValue(null);
const mockStreamsPurge = vi.fn().mockResolvedValue({ purged: 0 });

const mockPublish = vi.fn().mockResolvedValue({ seq: 1 });

const mockRequest = vi.fn().mockImplementation((_subject, data) => {
  return Promise.resolve({ data });
});

const mockSubscribe = vi.fn().mockReturnValue({
  [Symbol.asyncIterator]: () => ({
    next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
  }),
  unsubscribe: vi.fn(),
});

const mockDrain = vi.fn().mockResolvedValue(undefined);

vi.mock('nats', () => ({
  connect: vi.fn().mockImplementation(() =>
    Promise.resolve({
      jetstream: () => ({
        publish: mockPublish,
        consumers: {
          get: mockConsumersGet,
        },
      }),
      jetstreamManager: () =>
        Promise.resolve({
          streams: {
            add: mockStreamsAdd,
            update: mockStreamsUpdate,
            info: mockStreamsInfo,
            getMessage: mockStreamsGetMessage,
            purge: mockStreamsPurge,
          },
          consumers: {
            add: mockConsumersAdd,
            delete: mockConsumersDelete,
          },
        }),
      request: mockRequest,
      subscribe: mockSubscribe,
      drain: mockDrain,
      isClosed: () => false,
    }),
  ),
  JSONCodec: () => ({
    encode: (v: unknown) => new TextEncoder().encode(JSON.stringify(v)),
    decode: (d: Uint8Array) => JSON.parse(new TextDecoder().decode(d)),
  }),
  StringCodec: () => ({
    encode: (v: string) => new TextEncoder().encode(v),
    decode: (d: Uint8Array) => new TextDecoder().decode(d),
  }),
  headers: () => ({
    set: vi.fn(),
    get: vi.fn(),
  }),
  AckPolicy: { Explicit: 'explicit' },
  RetentionPolicy: { Workqueue: 'workqueue', Interest: 'interest', Limits: 'limits' },
  DeliverPolicy: { All: 'all' },
}));

describe('NatsClient', () => {
  let client: NatsClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NatsClient();
  });

  it('connects and creates streams', async () => {
    await client.connect('nats://localhost:4222');
    expect(client.isConnected()).toBe(true);
    // 3 streams should be created
    expect(mockStreamsAdd).toHaveBeenCalledTimes(3);
  });

  it('handles existing streams by updating', async () => {
    // First stream exists (info succeeds), rest don't (info throws)
    mockStreamsInfo.mockResolvedValueOnce({});
    mockStreamsInfo.mockRejectedValueOnce(new Error('stream not found'));
    mockStreamsInfo.mockRejectedValueOnce(new Error('stream not found'));

    await client.connect('nats://localhost:4222');
    // 1 existing stream updated, 2 new streams created
    expect(mockStreamsUpdate).toHaveBeenCalledTimes(1);
    expect(mockStreamsAdd).toHaveBeenCalledTimes(2);
  });

  it('publishes a message with idempotency header', async () => {
    await client.connect('nats://localhost:4222');
    const msg = makeMsg({ idempotencyKey: 'idem-123' });

    await client.publish('agent.test.inbox', msg);
    expect(mockPublish).toHaveBeenCalledWith(
      'agent.test.inbox',
      expect.any(Uint8Array),
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('sends a request/reply message', async () => {
    await client.connect('nats://localhost:4222');
    const msg = makeMsg();

    const response = await client.request('agent.test.inbox', msg, 5000);
    expect(mockRequest).toHaveBeenCalledWith(
      'agent.test.inbox',
      expect.any(Uint8Array),
      { timeout: 5000 },
    );
    expect(response).toBeDefined();
  });

  it('fan-out sends to multiple subjects', async () => {
    await client.connect('nats://localhost:4222');
    const msgs = [makeMsg({ id: 'a' }), makeMsg({ id: 'b' })];

    const responses = await client.fanOut(
      ['agent.a.inbox', 'agent.b.inbox'],
      msgs,
    );
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(responses).toHaveLength(2);
  });

  it('subscribes to a subject and returns stream/consumer names', async () => {
    await client.connect('nats://localhost:4222');

    const handler = vi.fn();
    const sub = await client.subscribe('agent.test.inbox', handler);
    expect(sub.subject).toBe('agent.test.inbox');
    expect(sub.streamName).toBe('AGENT_TASKS');
    expect(sub.consumerName).toMatch(/^consumer-/);
    expect(mockConsumersAdd).toHaveBeenCalled();
  });

  it('deletes stale consumer and purges subject before creating a new one on subscribe', async () => {
    await client.connect('nats://localhost:4222');

    const handler = vi.fn();
    await client.subscribe('agent.test.inbox', handler);

    // Should attempt to delete any existing consumer first
    expect(mockConsumersDelete).toHaveBeenCalledWith(
      'AGENT_TASKS',
      expect.stringMatching(/^consumer-/),
    );
    // Should purge old messages for this subject
    expect(mockStreamsPurge).toHaveBeenCalledWith('AGENT_TASKS', {
      filter: 'agent.test.inbox',
    });
    // Delete and purge must happen before add
    const deleteOrder = mockConsumersDelete.mock.invocationCallOrder[0]!;
    const purgeOrder = mockStreamsPurge.mock.invocationCallOrder[0]!;
    const addOrder = mockConsumersAdd.mock.invocationCallOrder[0]!;
    expect(deleteOrder).toBeLessThan(purgeOrder);
    expect(purgeOrder).toBeLessThan(addOrder);
  });

  it('subscribes even when no stale consumer exists to delete', async () => {
    mockConsumersDelete.mockRejectedValueOnce(new Error('consumer not found'));
    mockStreamsPurge.mockRejectedValueOnce(new Error('nothing to purge'));
    await client.connect('nats://localhost:4222');

    const handler = vi.fn();
    const sub = await client.subscribe('agent.test.inbox', handler);
    // Should succeed despite delete and purge throwing
    expect(sub.subject).toBe('agent.test.inbox');
    expect(mockConsumersAdd).toHaveBeenCalled();
  });

  it('subscription pause stops the consumer and resume re-acquires it', async () => {
    await client.connect('nats://localhost:4222');

    const handler = vi.fn();
    const sub = await client.subscribe('agent.test.inbox', handler);

    sub.pause();
    expect(mockStop).toHaveBeenCalled();

    mockStop.mockClear();
    await sub.resume();
    // Should re-acquire consumer via consumers.get
    expect(mockConsumersGet).toHaveBeenCalled();
    expect(mockConsume).toHaveBeenCalled();
  });

  it('closes cleanly', async () => {
    await client.connect('nats://localhost:4222');
    await client.close();
    expect(mockDrain).toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('exposes stream definitions', () => {
    const defs = client.getStreamDefinitions();
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name)).toEqual([
      'AGENT_TASKS',
      'AGENT_EVENTS',
      'SYSTEM',
    ]);
  });

  it('throws when not connected', async () => {
    const msg = makeMsg();
    await expect(client.publish('test', msg)).rejects.toThrow(
      'NATS not connected',
    );
    await expect(client.request('test', msg)).rejects.toThrow(
      'NATS not connected',
    );
  });
});
