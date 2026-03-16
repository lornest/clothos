import type { AgentMessage, InboundMessage, OutboundMessage } from '@clothos/core';
import { generateId, now } from '@clothos/core';

/**
 * Build an AgentMessage from an inbound channel message.
 */
export function buildAgentMessage(
  inbound: InboundMessage,
  channelType: string,
  agentId: string,
): AgentMessage {
  const correlationId = generateId();

  return {
    id: generateId(),
    specversion: '1.0',
    type: 'task.request',
    source: `channel://${channelType}/${inbound.senderId}`,
    target: `agent://${agentId}`,
    time: now(),
    datacontenttype: 'application/json',
    data: { text: inbound.text },
    correlationId,
    metadata: {
      channelType,
      senderId: inbound.senderId,
      ...(inbound.conversationId ? { conversationId: inbound.conversationId } : {}),
    },
  };
}

/**
 * Extract an OutboundMessage from an agent response AgentMessage.
 */
export function buildOutboundMessage(response: AgentMessage): OutboundMessage {
  const data = response.data as Record<string, unknown> | undefined;

  return {
    text: typeof data?.text === 'string' ? data.text : JSON.stringify(data),
    agentId: response.source.replace(/^agent:\/\//, ''),
    correlationId: response.correlationId ?? response.id,
    data: data ?? undefined,
  };
}
