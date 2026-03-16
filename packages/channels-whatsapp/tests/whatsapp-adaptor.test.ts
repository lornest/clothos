import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ChannelAdaptorContext,
  ChannelAdaptorConfig,
  OutboundMessage,
  Logger,
} from '@clothos/core';

// ---- Baileys mock ----

type EventHandler = (...args: unknown[]) => void;

const {
  mockSendMessage,
  mockEnd,
  mockEvHandlers,
  mockEv,
  mockUseMultiFileAuthState,
  mockSocketFactory,
} = vi.hoisted(() => {
  const mockSendMessage = vi.fn().mockResolvedValue({ key: { id: 'sent-1' } });
  const mockEnd = vi.fn();
  const mockEvHandlers = new Map<string, EventHandler>();

  const mockEv = {
    on: vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      mockEvHandlers.set(event, handler);
    }),
    removeAllListeners: vi.fn(),
  };

  const mockUseMultiFileAuthState = vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  });

  const mockSocketFactory = vi.fn().mockImplementation(() => ({
    ev: mockEv,
    sendMessage: mockSendMessage,
    end: mockEnd,
  }));

  return {
    mockSendMessage,
    mockEnd,
    mockEvHandlers,
    mockEv,
    mockUseMultiFileAuthState,
    mockSocketFactory,
  };
});

vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: mockSocketFactory,
    makeWASocket: mockSocketFactory,
    useMultiFileAuthState: (...args: unknown[]) =>
      mockUseMultiFileAuthState(...args),
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
    Browsers: { macOS: (name: string) => ['Mac OS', name, ''] },
    DisconnectReason: {
      connectionClosed: 428,
      connectionLost: 408,
      connectionReplaced: 440,
      timedOut: 408,
      loggedOut: 401,
      badSession: 500,
      restartRequired: 515,
      multideviceMismatch: 411,
      forbidden: 403,
      unavailableService: 503,
    },
  };
});

import { WhatsAppAdaptor } from '../src/whatsapp-adaptor.js';

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
    settings: { authDir: '/tmp/whatsapp-auth-test' },
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

function makeWhatsAppMessage(
  text: string,
  remoteJid = '5511999999999@s.whatsapp.net',
  fromMe = false,
  messageId = 'msg-1',
) {
  return {
    key: {
      remoteJid,
      fromMe,
      id: messageId,
    },
    message: {
      conversation: text,
    },
    pushName: 'Test User',
  };
}

function makeExtendedTextMessage(
  text: string,
  remoteJid = '5511999999999@s.whatsapp.net',
) {
  return {
    key: {
      remoteJid,
      fromMe: false,
      id: 'msg-ext-1',
    },
    message: {
      extendedTextMessage: { text },
    },
    pushName: 'Test User',
  };
}

// ---- Tests ----

describe('WhatsAppAdaptor', () => {
  let adaptor: WhatsAppAdaptor;

  beforeEach(() => {
    adaptor = new WhatsAppAdaptor();
    mockEvHandlers.clear();
    vi.clearAllMocks();
  });

  // 1. info and initial status
  it('reports correct info and initial stopped status', () => {
    expect(adaptor.info.channelType).toBe('whatsapp');
    expect(adaptor.info.displayName).toBe('WhatsApp');
    expect(adaptor.status).toBe('stopped');
  });

  // 2. start fails without authDir
  it('throws when authDir is missing', async () => {
    const ctx = createMockContext({
      config: { enabled: true, settings: {} },
    });
    await expect(adaptor.start(ctx)).rejects.toThrow('authDir');
  });

  it('throws when authDir is empty string', async () => {
    const ctx = createMockContext({
      config: { enabled: true, settings: { authDir: '' } },
    });
    await expect(adaptor.start(ctx)).rejects.toThrow('authDir');
  });

  it('throws when settings is undefined', async () => {
    const ctx = createMockContext({
      config: { enabled: true },
    });
    await expect(adaptor.start(ctx)).rejects.toThrow('authDir');
  });

  // 3. start transitions to running
  it('transitions to running after start', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    expect(adaptor.status).toBe('running');
    expect(mockUseMultiFileAuthState).toHaveBeenCalledWith(
      '/tmp/whatsapp-auth-test',
    );
  });

  // 4. stop transitions to stopped
  it('transitions to stopped after stop', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);
    expect(adaptor.status).toBe('running');

    await adaptor.stop();
    expect(adaptor.status).toBe('stopped');
    expect(mockEnd).toHaveBeenCalled();
  });

  // 5. inbound text message calls sendMessage
  it('calls sendMessage with correct InboundMessage on text message', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    expect(messagesHandler).toBeDefined();

    const msg = makeWhatsAppMessage('hello world');
    await messagesHandler!({
      messages: [msg],
      type: 'notify',
    });

    expect(ctx.sendMessage).toHaveBeenCalledWith({
      text: 'hello world',
      senderId: '5511999999999@s.whatsapp.net',
      conversationId: '5511999999999@s.whatsapp.net',
      platformData: {
        messageId: 'msg-1',
        pushName: 'Test User',
        isGroup: false,
      },
    });
  });

  // 6. handles extendedTextMessage
  it('extracts text from extendedTextMessage', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeExtendedTextMessage('extended hello');
    await messagesHandler!({
      messages: [msg],
      type: 'notify',
    });

    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'extended hello' }),
    );
  });

  // 7. response routes back to correct JID
  it('routes outbound response to correct WhatsApp JID', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    // Simulate inbound message to populate correlationId → JID mapping
    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('hi');
    await messagesHandler!({ messages: [msg], type: 'notify' });

    expect(responseHandler).not.toBeNull();

    // Simulate response
    const outbound: OutboundMessage = {
      text: 'Hello back!',
      agentId: 'assistant',
      correlationId: 'corr-123',
    };

    responseHandler!(outbound);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        '5511999999999@s.whatsapp.net',
        { text: 'Hello back!' },
      );
    });
  });

  // 8. isHealthy reflects running state
  it('returns false when stopped, true when running', async () => {
    expect(adaptor.isHealthy()).toBe(false);

    const ctx = createMockContext();
    await adaptor.start(ctx);
    expect(adaptor.isHealthy()).toBe(true);

    await adaptor.stop();
    expect(adaptor.isHealthy()).toBe(false);
  });

  // 9. cleans up on task.done
  it('cleans up correlation mapping on task.done response', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('question');
    await messagesHandler!({ messages: [msg], type: 'notify' });

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

  // 10. cleans up on task.error
  it('cleans up correlation mapping on task.error response', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('question');
    await messagesHandler!({ messages: [msg], type: 'notify' });

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

  // 11. early response buffering (race condition)
  it('buffers responses that arrive before JID mapping is set', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;
    let resolveSendMessage: ((value: string) => void) | null = null;

    const ctx = createMockContext({
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
    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('hi');
    const messagePromise = messagesHandler!({
      messages: [msg],
      type: 'notify',
    });

    // Response arrives BEFORE sendMessage resolves
    const outbound: OutboundMessage = {
      text: 'Fast reply!',
      agentId: 'assistant',
      correlationId: 'corr-123',
    };
    responseHandler!(outbound);

    // At this point, JID is NOT yet mapped — response should be buffered
    expect(mockSendMessage).not.toHaveBeenCalled();

    // Now resolve sendMessage — this triggers JID mapping + buffer flush
    resolveSendMessage!('corr-123');
    await messagePromise;

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        '5511999999999@s.whatsapp.net',
        { text: 'Fast reply!' },
      );
    });
  });

  // 12. ignores fromMe messages
  it('ignores messages from self (fromMe)', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('my own message', undefined, true);
    await messagesHandler!({ messages: [msg], type: 'notify' });

    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  // 13. ignores non-notify events
  it('ignores non-notify message events', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('appended message');
    await messagesHandler!({ messages: [msg], type: 'append' });

    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  // 14. ignores messages without text
  it('ignores messages without text content', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        fromMe: false,
        id: 'msg-no-text',
      },
      message: {
        imageMessage: { url: 'https://example.com/img.jpg' },
      },
      pushName: 'Test User',
    };
    await messagesHandler!({ messages: [msg], type: 'notify' });

    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  // 15. marks group messages correctly
  it('sets isGroup true for group JIDs', async () => {
    const ctx = createMockContext();
    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage(
      'group msg',
      '120363123456789012@g.us',
    );
    await messagesHandler!({ messages: [msg], type: 'notify' });

    expect(ctx.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        platformData: expect.objectContaining({ isGroup: true }),
      }),
    );
  });

  // 16. stop is safe when not started
  it('stop is safe when not started', async () => {
    await expect(adaptor.stop()).resolves.toBeUndefined();
    expect(adaptor.status).toBe('stopped');
  });

  // ---- Reconnection behaviour ----

  describe('reconnection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function fireDisconnect(statusCode: number) {
      const handler = mockEvHandlers.get('connection.update');
      handler!({
        connection: 'close',
        lastDisconnect: {
          error: { output: { statusCode } },
        },
      });
    }

    function fireOpen() {
      const handler = mockEvHandlers.get('connection.update');
      handler!({ connection: 'open' });
    }

    it.each([
      ['loggedOut', 401],
      ['forbidden', 403],
      ['methodNotAllowed', 405],
      ['multideviceMismatch', 411],
      ['connectionReplaced', 440],
      ['badSession', 500],
    ])('fatal disconnect (%s / %i) does NOT reconnect', async (_name, code) => {
      const ctx = createMockContext();
      await adaptor.start(ctx);
      const initialCallCount = mockSocketFactory.mock.calls.length;

      fireDisconnect(code);

      // Advance timers generously — no reconnection should fire
      await vi.advanceTimersByTimeAsync(120_000);

      expect(adaptor.status).toBe('error');
      expect(mockSocketFactory.mock.calls.length).toBe(initialCallCount);
    });

    it('connectionClosed (428) reconnects with backoff', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);
      const initialCallCount = mockSocketFactory.mock.calls.length;

      fireDisconnect(428);

      expect(adaptor.status).toBe('starting');

      // Advance past the backoff (max first attempt: 2s + 1s jitter = 3s)
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockSocketFactory.mock.calls.length).toBe(initialCallCount + 1);
    });

    it('restartRequired (515) reconnects immediately (0ms delay)', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);
      const initialCallCount = mockSocketFactory.mock.calls.length;

      fireDisconnect(515);

      // Even 0ms setTimeout needs a tick
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocketFactory.mock.calls.length).toBe(initialCallCount + 1);
    });

    it('max retries exceeded gives up', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);

      // Fire 11 disconnects (maxRetries = 10, so the 11th should give up)
      for (let i = 0; i < 11; i++) {
        fireDisconnect(428);
        await vi.advanceTimersByTimeAsync(120_000);
      }

      expect(adaptor.status).toBe('error');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('max retries'),
      );
    });

    it('retry counter resets on successful reconnection', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);

      // Disconnect 3 times
      for (let i = 0; i < 3; i++) {
        fireDisconnect(428);
        await vi.advanceTimersByTimeAsync(120_000);
      }

      // Simulate successful reconnection
      fireOpen();

      // Disconnect again — should still reconnect (counter was reset)
      const callCountBefore = mockSocketFactory.mock.calls.length;
      fireDisconnect(428);
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockSocketFactory.mock.calls.length).toBeGreaterThan(callCountBefore);
      expect(adaptor.status).not.toBe('error');
    });

    it('old socket listeners cleaned up on disconnect', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);

      fireDisconnect(428);

      expect(mockEv.removeAllListeners).toHaveBeenCalledWith('connection.update');
      expect(mockEv.removeAllListeners).toHaveBeenCalledWith('messages.upsert');
      expect(mockEv.removeAllListeners).toHaveBeenCalledWith('creds.update');
    });

    it('stop() during backoff prevents reconnect', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);
      const callCountAfterStart = mockSocketFactory.mock.calls.length;

      fireDisconnect(428);
      // Stop before the timer fires
      await adaptor.stop();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockSocketFactory.mock.calls.length).toBe(callCountAfterStart);
      expect(adaptor.status).toBe('stopped');
    });

    it('disconnect reason logged with name and code', async () => {
      const ctx = createMockContext();
      await adaptor.start(ctx);

      fireDisconnect(428);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('connectionClosed'),
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('428'),
      );
    });
  });

  // 17. lifecycle-only response with no text cleans up
  it('skips sending for empty lifecycle signals', async () => {
    let responseHandler: ((msg: OutboundMessage) => void) | null = null;

    const ctx = createMockContext({
      onResponse: vi.fn().mockImplementation((handler) => {
        responseHandler = handler;
      }),
    });

    await adaptor.start(ctx);

    const messagesHandler = mockEvHandlers.get('messages.upsert');
    const msg = makeWhatsAppMessage('question');
    await messagesHandler!({ messages: [msg], type: 'notify' });

    // task.done with no meaningful text
    const outbound: OutboundMessage = {
      text: '',
      agentId: 'assistant',
      correlationId: 'corr-123',
      data: { type: 'task.done' },
    };

    responseHandler!(outbound);

    // Allow microtask to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(ctx.removeResponseListener).toHaveBeenCalledWith('corr-123');
  });
});
