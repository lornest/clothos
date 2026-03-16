import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseTarget, MessageRouter } from '../src/router.js';
import type { NatsClient } from '../src/nats-client.js';
import type { AgentMessage } from '@clothos/core';

function makeMsg(target: string): AgentMessage {
  return {
    id: 'msg-1',
    specversion: '1.0',
    type: 'task.request',
    source: 'agent://sender',
    target,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {},
  };
}

describe('parseTarget', () => {
  it('parses agent:// URI', () => {
    expect(parseTarget('agent://my-agent')).toEqual({
      scheme: 'agent',
      path: 'my-agent',
    });
  });

  it('parses topic:// URI', () => {
    expect(parseTarget('topic://events.user.created')).toEqual({
      scheme: 'topic',
      path: 'events.user.created',
    });
  });

  it('throws on invalid URI', () => {
    expect(() => parseTarget('bad-uri')).toThrow('Invalid target URI');
  });
});

describe('MessageRouter', () => {
  let mockNats: { publish: ReturnType<typeof vi.fn> };
  let router: MessageRouter;

  beforeEach(() => {
    mockNats = { publish: vi.fn().mockResolvedValue(undefined) };
    router = new MessageRouter(mockNats as unknown as NatsClient);
  });

  it('routes agent:// to agent.{id}.inbox', async () => {
    await router.route(makeMsg('agent://my-agent'));
    expect(mockNats.publish).toHaveBeenCalledWith(
      'agent.my-agent.inbox',
      expect.objectContaining({ id: 'msg-1' }),
    );
  });

  it('routes topic:// to events.agent.{name}', async () => {
    await router.route(makeMsg('topic://user.created'));
    expect(mockNats.publish).toHaveBeenCalledWith(
      'events.agent.user.created',
      expect.objectContaining({ id: 'msg-1' }),
    );
  });

  it('throws on unknown scheme', async () => {
    await expect(router.route(makeMsg('http://example.com'))).rejects.toThrow(
      'Unknown target scheme: http',
    );
  });
});
