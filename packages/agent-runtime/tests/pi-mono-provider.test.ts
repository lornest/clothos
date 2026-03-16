import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamChunk, ToolDefinition } from '@clothos/core';
import { PiMonoProvider } from '../src/pi-mono-provider.js';
import type { PiMonoProviderOptions } from '../src/pi-mono-provider.js';

// Mock pi-ai's stream function
vi.mock('@mariozechner/pi-ai', () => {
  const events: any[] = [];
  let capturedContext: any = null;

  return {
    stream: vi.fn((model: any, context: any) => {
      capturedContext = context;
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            async next() {
              if (i < events.length) {
                return { value: events[i++], done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    }),
    getModel: vi.fn(),
    // Expose helpers for test setup
    __setEvents: (e: any[]) => {
      events.length = 0;
      events.push(...e);
    },
    __getCapturedContext: () => capturedContext,
  };
});

// Access mock helpers
async function getMockHelpers() {
  const mod = await import('@mariozechner/pi-ai') as any;
  return {
    setEvents: mod.__setEvents as (events: any[]) => void,
    getCapturedContext: mod.__getCapturedContext as () => any,
    streamFn: mod.stream as ReturnType<typeof vi.fn>,
  };
}

function createProvider(overrides?: Partial<PiMonoProviderOptions>): PiMonoProvider {
  const fakeModel = {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } as any;

  return new PiMonoProvider({
    model: fakeModel,
    id: 'test-provider',
    ...overrides,
  });
}

async function collectChunks(
  iter: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iter) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('PiMonoProvider', () => {
  let helpers: Awaited<ReturnType<typeof getMockHelpers>>;

  beforeEach(async () => {
    helpers = await getMockHelpers();
    helpers.setEvents([]);
  });

  it('has correct id and supportsPromptCaching', () => {
    const provider = createProvider();
    expect(provider.id).toBe('test-provider');
    expect(provider.supportsPromptCaching).toBe(true);
  });

  it('defaults id to pi-mono', () => {
    const fakeModel = { api: 'anthropic-messages', provider: 'anthropic', id: 'test' } as any;
    const provider = new PiMonoProvider({ model: fakeModel });
    expect(provider.id).toBe('pi-mono');
  });

  describe('message conversion', () => {
    it('extracts system message to systemPrompt', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ];

      const provider = createProvider();
      await collectChunks(provider.streamCompletion(messages, [], {}));

      const ctx = helpers.getCapturedContext();
      expect(ctx.systemPrompt).toBe('You are helpful.');
      // System message should NOT be in messages array
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.messages[0].role).toBe('user');
    });

    it('converts user messages correctly', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const messages: Message[] = [{ role: 'user', content: 'Hello world' }];
      const provider = createProvider();
      await collectChunks(provider.streamCompletion(messages, [], {}));

      const ctx = helpers.getCapturedContext();
      expect(ctx.messages[0]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
      });
      expect(ctx.messages[0].timestamp).toBeTypeOf('number');
    });

    it('converts assistant messages with text and tool calls', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Let me search for that.',
          toolCalls: [
            { id: 'tc-1', name: 'search', arguments: '{"query":"test"}' },
          ],
        },
      ];

      const provider = createProvider();
      await collectChunks(provider.streamCompletion(messages, [], {}));

      const ctx = helpers.getCapturedContext();
      const assistantMsg = ctx.messages[0];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toHaveLength(2);
      expect(assistantMsg.content[0]).toMatchObject({ type: 'text', text: 'Let me search for that.' });
      expect(assistantMsg.content[1]).toMatchObject({
        type: 'toolCall',
        id: 'tc-1',
        name: 'search',
        arguments: { query: 'test' },
      });
    });

    it('converts tool result with toolName lookup from preceding assistant', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{}' }],
        },
        {
          role: 'tool',
          content: '{"results": []}',
          toolCallId: 'tc-1',
        },
      ];

      const provider = createProvider();
      await collectChunks(provider.streamCompletion(messages, [], {}));

      const ctx = helpers.getCapturedContext();
      const toolResult = ctx.messages[1];
      expect(toolResult.role).toBe('toolResult');
      expect(toolResult.toolName).toBe('search');
      expect(toolResult.toolCallId).toBe('tc-1');
      expect(toolResult.content).toEqual([{ type: 'text', text: '{"results": []}' }]);
    });

    it('uses "unknown" toolName when no matching tool call found', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const messages: Message[] = [
        { role: 'tool', content: 'result', toolCallId: 'tc-missing' },
      ];

      const provider = createProvider();
      await collectChunks(provider.streamCompletion(messages, [], {}));

      const ctx = helpers.getCapturedContext();
      expect(ctx.messages[0].toolName).toBe('unknown');
    });
  });

  describe('stream event mapping', () => {
    it('maps text_delta events', async () => {
      helpers.setEvents([
        { type: 'text_delta', contentIndex: 0, delta: 'Hello ', partial: {} },
        { type: 'text_delta', contentIndex: 0, delta: 'world!', partial: {} },
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      expect(chunks[0]).toEqual({ type: 'text_delta', text: 'Hello ' });
      expect(chunks[1]).toEqual({ type: 'text_delta', text: 'world!' });
    });

    it('maps toolcall_end events with JSON-stringified arguments', async () => {
      helpers.setEvents([
        {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'tc-1', name: 'search', arguments: { query: 'test' } },
          partial: {},
        },
        { type: 'done', reason: 'toolUse', message: { usage: { input: 15, output: 8 } } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'search' }], [], {}),
      );

      expect(chunks[0]).toEqual({
        type: 'tool_call_delta',
        toolCall: {
          id: 'tc-1',
          name: 'search',
          arguments: '{"query":"test"}',
        },
      });
    });

    it('maps done event to usage + done chunks', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 100, output: 50 } } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      expect(chunks[1]).toEqual({
        type: 'done',
        finishReason: 'stop',
      });
    });

    it('maps stop reason "toolUse" to "tool_calls"', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'toolUse', message: { usage: { input: 10, output: 5 } } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      const doneChunk = chunks.find((c) => c.type === 'done');
      expect(doneChunk?.finishReason).toBe('tool_calls');
    });

    it('maps stop reason "length" to "length"', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'length', message: { usage: { input: 10, output: 5 } } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      const doneChunk = chunks.find((c) => c.type === 'done');
      expect(doneChunk?.finishReason).toBe('length');
    });

    it('maps error event to done with error finish reason', async () => {
      helpers.setEvents([
        { type: 'error', reason: 'error', error: { usage: { input: 0, output: 0 }, errorMessage: 'fail' } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'done', finishReason: 'error' });
    });

    it('ignores start, text_start, text_end, thinking_*, toolcall_start, toolcall_delta', async () => {
      helpers.setEvents([
        { type: 'start', partial: {} },
        { type: 'text_start', contentIndex: 0, partial: {} },
        { type: 'text_delta', contentIndex: 0, delta: 'hi', partial: {} },
        { type: 'text_end', contentIndex: 0, content: 'hi', partial: {} },
        { type: 'thinking_start', contentIndex: 0, partial: {} },
        { type: 'thinking_delta', contentIndex: 0, delta: '...', partial: {} },
        { type: 'thinking_end', contentIndex: 0, content: '...', partial: {} },
        { type: 'toolcall_start', contentIndex: 0, partial: {} },
        { type: 'toolcall_delta', contentIndex: 0, delta: '{', partial: {} },
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const provider = createProvider();
      const chunks = await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      // Should only have text_delta, usage, done
      const types = chunks.map((c) => c.type);
      expect(types).toEqual(['text_delta', 'usage', 'done']);
    });
  });

  describe('tool conversion', () => {
    it('converts tool definitions to pi-ai format', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const tools: ToolDefinition[] = [
        {
          name: 'search',
          description: 'Search for files',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ];

      const provider = createProvider();
      await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'search' }], tools, {}),
      );

      const ctx = helpers.getCapturedContext();
      expect(ctx.tools).toHaveLength(1);
      expect(ctx.tools[0]).toMatchObject({
        name: 'search',
        description: 'Search for files',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      });
    });

    it('passes undefined tools when tools array is empty', async () => {
      helpers.setEvents([
        { type: 'done', reason: 'stop', message: { usage: { input: 10, output: 5 } } },
      ]);

      const provider = createProvider();
      await collectChunks(
        provider.streamCompletion([{ role: 'user', content: 'Hi' }], [], {}),
      );

      const ctx = helpers.getCapturedContext();
      expect(ctx.tools).toBeUndefined();
    });
  });

  describe('countTokens', () => {
    it('estimates tokens as ceil(totalChars / 4)', async () => {
      const provider = createProvider();

      // "Hello world" = 11 chars → ceil(11/4) = 3
      const count = await provider.countTokens([
        { role: 'user', content: 'Hello world' },
      ]);
      expect(count).toBe(3);
    });

    it('includes tool call name and arguments in char count', async () => {
      const provider = createProvider();

      // content: "x" (1) + name: "search" (6) + args: '{"q":"t"}' (9) = 16 → ceil(16/4) = 4
      const count = await provider.countTokens([
        {
          role: 'assistant',
          content: 'x',
          toolCalls: [{ id: 'tc1', name: 'search', arguments: '{"q":"t"}' }],
        },
      ]);
      expect(count).toBe(4);
    });

    it('returns 0 for empty messages', async () => {
      const provider = createProvider();
      const count = await provider.countTokens([]);
      expect(count).toBe(0);
    });
  });
});
