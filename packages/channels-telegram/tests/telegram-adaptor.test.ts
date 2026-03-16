import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ChannelAdaptorContext,
  ChannelAdaptorConfig,
  OutboundMessage,
  Logger,
} from '@clothos/core';
import { TelegramAdaptor } from '../src/telegram-adaptor.js';

// ---- grammY mock ----

type MessageHandler = (ctx: Record<string, unknown>) => Promise<void>;

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockStop = vi.fn().mockResolvedValue(undefined);
let capturedMessageHandler: MessageHandler | null = null;

const mockStart = vi.fn().mockImplementation((opts?: { onStart?: () => void }) => {
  opts?.onStart?.();
});

vi.mock('grammy', () => {
  return {
    Bot: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.on = vi.fn().mockImplementation((event: string, handler: MessageHandler) => {
        if (event === 'message:text') {
          capturedMessageHandler = handler;
        }
      });
      this.start = mockStart;
      this.stop = mockStop;
      this.api = {
        sendMessage: mockSendMessage,
      };
    }),
  };
});

// ---- Helpers ----

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockContext(
  overrides: Partial<ChannelAdaptorContext> = {},
): ChannelAdaptorContext {
  const config: ChannelAdaptorConfig = {
    enabled: true,
    settings: { botToken: 'test-bot-token' },
  };

  return {
    sendMessage: vi.fn().mockResolvedValue('corr-123'),
    onResponse: vi.fn(),
    removeResponseListener: vi.fn(),
    resolveAgent: vi.fn().mockReturnValue('assistant'),
    logger: createMockLogger(),
    config,
    ...overrides,
  };
}

function makeTelegramMessage(text: string, fromId = 111, chatId = 222, messageId = 1) {
  return {
    message: { text, message_id: messageId },
    from: { id: fromId },
    chat: { id: chatId, type: 'private' as const },
  };
}

// ---- Tests ----

describe('TelegramAdaptor', () => {
  let adaptor: TelegramAdaptor;

  beforeEach(() => {
    adaptor = new TelegramAdaptor();
    capturedMessageHandler = null;
    vi.clearAllMocks();
  });

  // 1. info and initial status
  it('reports correct info and initial stopped status', () => {
    expect(adaptor.info.channelType).toBe('telegram');
    expect(adaptor.info.displayName).toBe('Telegram');
    expect(adaptor.status).toBe('stopped');
  });

  // 2. start fails without botToken
  it('throws when botToken is missing', async () => {
    const ctx = createMockContext({
      config: { enabled: true, settings: {} },
    });
    await expect(adaptor.start(ctx)).rejects.toThrow('botToken');
  });

  it('throws when botToken is empty string', async () => {
    const ctx = createMockContext({
      config: { enabled: true, settings: { botToken: '' } },
    });
    await expect(adaptor.start(ctx)).rejects.toThrow('botToken');
  });

  it('throws when settings is undefined', async () => {
    const ctx = createMockContext({
      config: { enabled: true },
    });
    await expect(adaptor.start(ctx)).rejects.toThrow('botToken');
  });

  // 3. start transitions to running
  it('transitions to running after start', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    expect(adaptor.status).toBe('running');
    expect(mockStart).toHaveBeenCalled();
  });

  // 4. stop transitions to stopped
  it('transitions to stopped after stop', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);
    expect(adaptor.status).toBe('running');

    await adaptor.stop();
    expect(adaptor.status).toBe('stopped');
    expect(mockStop).toHaveBeenCalled();
  });

  // 5. inbound message calls sendMessage
  it('calls sendMessage with correct InboundMessage on text message', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    expect(capturedMessageHandler).not.toBeNull();

    const telegramMsg = makeTelegramMessage('hello world', 42, 99, 7);
    await capturedMessageHandler!(telegramMsg);

    expect(ctx.sendMessage).toHaveBeenCalledWith({
      text: 'hello world',
      senderId: '42',
      conversationId: '99',
      platformData: {
        messageId: 7,
        chatType: 'private',
      },
    });
  });

  // 6. response routes back to correct chat
  it('routes outbound response to correct Telegram chat', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    // Simulate inbound message to populate correlationId → chatId mapping
    const telegramMsg = makeTelegramMessage('hi', 42, 99);
    await capturedMessageHandler!(telegramMsg);

    expect(responseHandler).not.toBeNull();

    // Simulate response
    const outbound: OutboundMessage = {
      text: 'Hello back!',
      agentId: 'assistant',
      correlationId: 'corr-123',
    };

    responseHandler!(outbound);

    // Allow microtask to resolve
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(99, 'Hello back!', {
        parse_mode: 'Markdown',
      });
    });
  });

  // 7. isHealthy reflects running state
  it('returns false when stopped, true when running', async () => {
    expect(adaptor.isHealthy()).toBe(false);

    const ctx = createMockContext();
    await adaptor.start(ctx);
    expect(adaptor.isHealthy()).toBe(true);

    await adaptor.stop();
    expect(adaptor.isHealthy()).toBe(false);
  });

  // Cleanup on task.done
  it('cleans up correlation mapping on task.done response', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    const telegramMsg = makeTelegramMessage('question', 42, 99);
    await capturedMessageHandler!(telegramMsg);

    const outbound: OutboundMessage = {
      text: 'Final answer',
      agentId: 'assistant',
      correlationId: 'corr-123',
      data: { type: 'task.done' },
    };

    responseHandler!(outbound);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(ctx.removeResponseListener).toHaveBeenCalledWith('corr-123');
  });

  // Cleanup on task.error
  it('cleans up correlation mapping on task.error response', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    const telegramMsg = makeTelegramMessage('question', 42, 99);
    await capturedMessageHandler!(telegramMsg);

    const outbound: OutboundMessage = {
      text: 'Error occurred',
      agentId: 'assistant',
      correlationId: 'corr-123',
      data: { type: 'task.error' },
    };

    responseHandler!(outbound);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(ctx.removeResponseListener).toHaveBeenCalledWith('corr-123');
  });

  // Markdown fallback
  it('falls back to plain text when Markdown send fails', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    // First call (with Markdown) rejects, second call (plain) resolves
    mockSendMessage
      .mockRejectedValueOnce(new Error('Markdown parse error'))
      .mockResolvedValueOnce({});

    await adaptor.start(ctx);

    const telegramMsg = makeTelegramMessage('hi', 42, 99);
    await capturedMessageHandler!(telegramMsg);

    const outbound: OutboundMessage = {
      text: 'bad *markdown',
      agentId: 'assistant',
      correlationId: 'corr-123',
    };

    responseHandler!(outbound);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    // First call with Markdown
    expect(mockSendMessage).toHaveBeenNthCalledWith(1, 99, 'bad *markdown', {
      parse_mode: 'Markdown',
    });
    // Fallback without parse_mode
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, 99, 'bad *markdown');
  });

  // Early response buffering (race condition: response before sendMessage returns)
  it('buffers responses that arrive before chatId mapping is set', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;
    let resolveSendMessage: ((value: string) => void) | null = null;

    const ctx = createMockContext({
      // sendMessage returns a promise that we control manually
      sendMessage: vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolveSendMessage = resolve;
        });
      }),
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    // Start processing the inbound message (don't await — sendMessage is pending)
    const telegramMsg = makeTelegramMessage('hi', 42, 99);
    const messagePromise = capturedMessageHandler!(telegramMsg);

    // Response arrives BEFORE sendMessage resolves
    const outbound: OutboundMessage = {
      text: 'Fast reply!',
      agentId: 'assistant',
      correlationId: 'corr-123',
    };
    responseHandler!(outbound);

    // At this point, chatId is NOT yet mapped — response should be buffered
    expect(mockSendMessage).not.toHaveBeenCalled();

    // Now resolve sendMessage — this triggers chatId mapping + buffer flush
    resolveSendMessage!('corr-123');
    await messagePromise;

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(99, 'Fast reply!', {
        parse_mode: 'Markdown',
      });
    });
  });

  // stop is safe when not started
  it('stop is safe when not started', async () => {
    await expect(adaptor.stop()).resolves.toBeUndefined();
    expect(adaptor.status).toBe('stopped');
  });
});
