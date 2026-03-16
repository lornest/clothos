import { describe, it, expect, vi } from 'vitest';
import { ResponseRouter } from '../src/response-router.js';
import type { AgentMessage } from '@clothos/core';
import { generateId, now } from '@clothos/core';

function createTestMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: generateId(),
    specversion: '1.0',
    type: 'task.request',
    source: 'client://test',
    target: 'agent://test-agent',
    time: now(),
    datacontenttype: 'application/json',
    data: { text: 'hello' },
    ...overrides,
  };
}

describe('ResponseRouter', () => {
  it('tracks and routes a response to the correct WS session', () => {
    const mockWs = {
      send: vi.fn().mockReturnValue(true),
    };
    const router = new ResponseRouter(mockWs as any);

    router.trackRequest('corr-1', 'ws-session-1');

    const response = createTestMessage({ correlationId: 'corr-1' });
    const sent = router.routeResponse('corr-1', response);

    expect(sent).toBe(true);
    expect(mockWs.send).toHaveBeenCalledWith('ws-session-1', response);
  });

  it('returns false for unknown correlationId', () => {
    const mockWs = { send: vi.fn() };
    const router = new ResponseRouter(mockWs as any);

    const response = createTestMessage();
    expect(router.routeResponse('unknown', response)).toBe(false);
  });

  it('keeps tracking after successful route for multi-message support', () => {
    const mockWs = { send: vi.fn().mockReturnValue(true) };
    const router = new ResponseRouter(mockWs as any);

    router.trackRequest('corr-2', 'ws-session-2');
    router.routeResponse('corr-2', createTestMessage());

    expect(router.pendingCount).toBe(1);
  });

  it('routes multiple responses for the same correlationId', () => {
    const mockWs = { send: vi.fn().mockReturnValue(true) };
    const router = new ResponseRouter(mockWs as any);

    router.trackRequest('corr-multi', 'ws-session-1');

    const r1 = createTestMessage({ correlationId: 'corr-multi' });
    const r2 = createTestMessage({ correlationId: 'corr-multi' });

    expect(router.routeResponse('corr-multi', r1)).toBe(true);
    expect(router.routeResponse('corr-multi', r2)).toBe(true);
    expect(mockWs.send).toHaveBeenCalledTimes(2);
  });

  it('completeRequest removes tracking', () => {
    const mockWs = { send: vi.fn().mockReturnValue(true) };
    const router = new ResponseRouter(mockWs as any);

    router.trackRequest('corr-done', 'ws-session-1');
    expect(router.pendingCount).toBe(1);

    router.completeRequest('corr-done');
    expect(router.pendingCount).toBe(0);
    expect(router.routeResponse('corr-done', createTestMessage())).toBe(false);
  });

  it('builds a response message with correct fields', () => {
    const original = createTestMessage({
      id: 'orig-id',
      correlationId: 'corr-3',
      source: 'client://user-1',
    });

    const response = ResponseRouter.buildResponseMessage(
      original,
      'agent-1',
      'Hello!',
    );

    expect(response.type).toBe('task.response');
    expect(response.source).toBe('agent://agent-1');
    expect(response.target).toBe('client://user-1');
    expect(response.correlationId).toBe('corr-3');
    expect(response.causationId).toBe('orig-id');
    expect((response.data as { text: string }).text).toBe('Hello!');
  });

  it('untrack removes the entry', () => {
    const mockWs = { send: vi.fn() };
    const router = new ResponseRouter(mockWs as any);

    router.trackRequest('corr-4', 'ws-4');
    expect(router.pendingCount).toBe(1);

    router.untrack('corr-4');
    expect(router.pendingCount).toBe(0);
  });
});

describe('MockLLMProvider', () => {
  it('returns configured responses in order', async () => {
    const { MockLLMProvider } = await import('./e2e/helpers/mock-llm.js');
    const provider = new MockLLMProvider([
      { text: 'first' },
      { text: 'second' },
    ]);

    // First call
    const chunks1: any[] = [];
    for await (const chunk of provider.streamCompletion([], [], {})) {
      chunks1.push(chunk);
    }
    expect(chunks1.find((c) => c.type === 'text_delta')?.text).toBe('first');

    // Second call
    const chunks2: any[] = [];
    for await (const chunk of provider.streamCompletion([], [], {})) {
      chunks2.push(chunk);
    }
    expect(chunks2.find((c) => c.type === 'text_delta')?.text).toBe('second');

    expect(provider.callCount).toBe(2);
  });

  it('emits tool_call_delta for tool calls', async () => {
    const { MockLLMProvider } = await import('./e2e/helpers/mock-llm.js');
    const provider = new MockLLMProvider([
      {
        text: '',
        toolCalls: [
          { id: 'tc-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        ],
      },
    ]);

    const chunks: any[] = [];
    for await (const chunk of provider.streamCompletion([], [], {})) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find((c) => c.type === 'tool_call_delta');
    expect(toolChunk).toBeDefined();
    expect(toolChunk.toolCall.name).toBe('read_file');
  });
});
