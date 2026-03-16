import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent, AgentMessage } from '@clothos/core';
import { generateId, now } from '@clothos/core';

/**
 * Tests for the reply-to routing logic in agent-wiring.ts.
 *
 * Since wireAgent has many dependencies (AgentManager, GatewayServer, etc.)
 * we test the routing logic in isolation by extracting the decision logic
 * into focused unit tests.
 */

function buildOriginalMsg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: generateId(),
    specversion: '1.0',
    type: 'task.request',
    source: 'gateway://node-a',
    target: 'agent://test-agent',
    time: now(),
    datacontenttype: 'application/json',
    data: { text: 'hello' },
    ...overrides,
  };
}

/**
 * Simulates the reply-to routing logic from agent-wiring.ts onResponse callback.
 * Extracted here for testability.
 */
function simulateOnResponse(
  event: AgentEvent,
  originalMsg: AgentMessage,
  agentId: string,
  publishCore: (subject: string, msg: AgentMessage) => void,
) {
  const correlationId = originalMsg.correlationId ?? originalMsg.id;

  if (event.type === 'assistant_message' && event.content.text) {
    if (originalMsg.replyTo) {
      try {
        const replyMsg: AgentMessage = {
          id: generateId(),
          specversion: '1.0',
          type: 'task.response',
          source: `agent://${agentId}`,
          target: originalMsg.source,
          time: now(),
          datacontenttype: 'application/json',
          data: { event },
          correlationId,
          causationId: originalMsg.id,
        };
        publishCore(originalMsg.replyTo, replyMsg);
      } catch { /* best-effort */ }
    }
  } else if (event.type === 'error') {
    if (originalMsg.replyTo) {
      try {
        const errorMsg: AgentMessage = {
          id: generateId(),
          specversion: '1.0',
          type: 'task.error',
          source: `agent://${agentId}`,
          target: originalMsg.source,
          time: now(),
          datacontenttype: 'application/json',
          data: { error: event.error },
          correlationId,
          causationId: originalMsg.id,
        };
        publishCore(originalMsg.replyTo, errorMsg);
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Simulates the reply-to routing logic from agent-wiring.ts onDone callback.
 */
function simulateOnDone(
  originalMsg: AgentMessage,
  agentId: string,
  publishCore: (subject: string, msg: AgentMessage) => void,
) {
  const correlationId = originalMsg.correlationId ?? originalMsg.id;

  if (originalMsg.replyTo) {
    try {
      const doneMsg: AgentMessage = {
        id: generateId(),
        specversion: '1.0',
        type: 'task.done',
        source: `agent://${agentId}`,
        target: originalMsg.source,
        time: now(),
        datacontenttype: 'application/json',
        data: {},
        correlationId,
        causationId: originalMsg.id,
      };
      publishCore(originalMsg.replyTo, doneMsg);
    } catch { /* best-effort */ }
  }
}

describe('reply-to routing', () => {
  describe('onResponse with replyTo', () => {
    it('publishes task.response to replyTo for assistant_message events', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg({ replyTo: '_INBOX.abc.1' });
      const event: AgentEvent = {
        type: 'assistant_message',
        content: { text: 'Hello world' },
      };

      simulateOnResponse(event, originalMsg, 'test-agent', publishCore);

      expect(publishCore).toHaveBeenCalledTimes(1);
      const [subject, msg] = publishCore.mock.calls[0]!;
      expect(subject).toBe('_INBOX.abc.1');
      expect(msg.type).toBe('task.response');
      expect(msg.source).toBe('agent://test-agent');
      expect((msg.data as any).event).toBe(event);
    });

    it('publishes task.error to replyTo for error events', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg({ replyTo: '_INBOX.abc.2' });
      const event: AgentEvent = {
        type: 'error',
        error: 'Something went wrong',
      };

      simulateOnResponse(event, originalMsg, 'test-agent', publishCore);

      expect(publishCore).toHaveBeenCalledTimes(1);
      const [subject, msg] = publishCore.mock.calls[0]!;
      expect(subject).toBe('_INBOX.abc.2');
      expect(msg.type).toBe('task.error');
      expect((msg.data as any).error).toBe('Something went wrong');
    });

    it('does not publish when replyTo is absent', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg(); // no replyTo
      const event: AgentEvent = {
        type: 'assistant_message',
        content: { text: 'Hello world' },
      };

      simulateOnResponse(event, originalMsg, 'test-agent', publishCore);

      expect(publishCore).not.toHaveBeenCalled();
    });

    it('does not publish for non-text assistant messages', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg({ replyTo: '_INBOX.abc.3' });
      const event: AgentEvent = {
        type: 'assistant_message',
        content: { text: '' },
      };

      simulateOnResponse(event, originalMsg, 'test-agent', publishCore);

      expect(publishCore).not.toHaveBeenCalled();
    });

    it('swallows publishCore errors (best-effort)', () => {
      const publishCore = vi.fn(() => { throw new Error('NATS disconnected'); });
      const originalMsg = buildOriginalMsg({ replyTo: '_INBOX.abc.4' });
      const event: AgentEvent = {
        type: 'assistant_message',
        content: { text: 'Hello' },
      };

      // Should not throw
      expect(() => {
        simulateOnResponse(event, originalMsg, 'test-agent', publishCore);
      }).not.toThrow();
    });
  });

  describe('onDone with replyTo', () => {
    it('publishes task.done to replyTo', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg({ replyTo: '_INBOX.abc.5' });

      simulateOnDone(originalMsg, 'test-agent', publishCore);

      expect(publishCore).toHaveBeenCalledTimes(1);
      const [subject, msg] = publishCore.mock.calls[0]!;
      expect(subject).toBe('_INBOX.abc.5');
      expect(msg.type).toBe('task.done');
      expect(msg.source).toBe('agent://test-agent');
    });

    it('does not publish task.done when replyTo is absent', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg(); // no replyTo

      simulateOnDone(originalMsg, 'test-agent', publishCore);

      expect(publishCore).not.toHaveBeenCalled();
    });

    it('preserves correlationId from original message', () => {
      const publishCore = vi.fn();
      const originalMsg = buildOriginalMsg({
        replyTo: '_INBOX.abc.6',
        correlationId: 'corr-123',
      });

      simulateOnDone(originalMsg, 'test-agent', publishCore);

      const [, msg] = publishCore.mock.calls[0]!;
      expect(msg.correlationId).toBe('corr-123');
      expect(msg.causationId).toBe(originalMsg.id);
    });

    it('swallows publishCore errors (best-effort)', () => {
      const publishCore = vi.fn(() => { throw new Error('NATS disconnected'); });
      const originalMsg = buildOriginalMsg({ replyTo: '_INBOX.abc.7' });

      expect(() => {
        simulateOnDone(originalMsg, 'test-agent', publishCore);
      }).not.toThrow();
    });
  });
});
