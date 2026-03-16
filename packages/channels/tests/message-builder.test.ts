import { describe, it, expect } from 'vitest';
import type { AgentMessage, InboundMessage } from '@clothos/core';
import { buildAgentMessage, buildOutboundMessage } from '../src/message-builder.js';

describe('buildAgentMessage', () => {
  const inbound: InboundMessage = {
    text: 'Hello agent',
    senderId: 'user-123',
    conversationId: 'conv-456',
  };

  it('creates a valid AgentMessage', () => {
    const msg = buildAgentMessage(inbound, 'webchat', 'assistant');

    expect(msg.specversion).toBe('1.0');
    expect(msg.type).toBe('task.request');
    expect(msg.source).toBe('channel://webchat/user-123');
    expect(msg.target).toBe('agent://assistant');
    expect(msg.datacontenttype).toBe('application/json');
    expect(msg.data).toEqual({ text: 'Hello agent' });
    expect(msg.correlationId).toBeDefined();
    expect(msg.id).toBeDefined();
    expect(msg.time).toBeDefined();
  });

  it('includes metadata with channel info', () => {
    const msg = buildAgentMessage(inbound, 'webchat', 'assistant');

    expect(msg.metadata?.channelType).toBe('webchat');
    expect(msg.metadata?.senderId).toBe('user-123');
    expect(msg.metadata?.conversationId).toBe('conv-456');
  });

  it('generates unique IDs per call', () => {
    const msg1 = buildAgentMessage(inbound, 'webchat', 'assistant');
    const msg2 = buildAgentMessage(inbound, 'webchat', 'assistant');

    expect(msg1.id).not.toBe(msg2.id);
    expect(msg1.correlationId).not.toBe(msg2.correlationId);
  });

  it('omits conversationId from metadata when not provided', () => {
    const simple: InboundMessage = { text: 'Hi', senderId: 'user-1' };
    const msg = buildAgentMessage(simple, 'telegram', 'bot');

    expect(msg.metadata?.conversationId).toBeUndefined();
  });
});

describe('buildOutboundMessage', () => {
  it('extracts text and agentId from response', () => {
    const response: AgentMessage = {
      id: 'resp-1',
      specversion: '1.0',
      type: 'task.response',
      source: 'agent://assistant',
      target: 'channel://webchat/user-123',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: { text: 'Hello human' },
      correlationId: 'corr-1',
    };

    const outbound = buildOutboundMessage(response);

    expect(outbound.text).toBe('Hello human');
    expect(outbound.agentId).toBe('assistant');
    expect(outbound.correlationId).toBe('corr-1');
  });

  it('falls back to JSON.stringify when data.text is not a string', () => {
    const response: AgentMessage = {
      id: 'resp-2',
      specversion: '1.0',
      type: 'task.response',
      source: 'agent://bot',
      target: 'channel://webchat/user-1',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: { result: 42 },
      correlationId: 'corr-2',
    };

    const outbound = buildOutboundMessage(response);

    expect(outbound.text).toBe(JSON.stringify({ result: 42 }));
  });

  it('uses response id as correlationId fallback', () => {
    const response: AgentMessage = {
      id: 'resp-3',
      specversion: '1.0',
      type: 'task.response',
      source: 'agent://bot',
      target: 'channel://webchat/user-1',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: { text: 'Hi' },
    };

    const outbound = buildOutboundMessage(response);

    expect(outbound.correlationId).toBe('resp-3');
  });
});
