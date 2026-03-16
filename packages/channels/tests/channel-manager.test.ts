import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AgentMessage,
  Binding,
  BindingOverrides,
  ChannelAdaptor,
  ChannelAdaptorContext,
  ChannelAdaptorInfo,
  ChannelAdaptorStatus,
  ChannelsConfig,
  GatewayTransport,
  Logger,
} from '@clothos/core';
import { ChannelManager } from '../src/channel-manager.js';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMockGateway() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn(),
    removeResponseHandler: vi.fn(),
  } satisfies GatewayTransport;
}

function makeMockAdaptor(
  channelType: string,
  overrides: Partial<ChannelAdaptor> = {},
): ChannelAdaptor {
  let _status: ChannelAdaptorStatus = 'stopped';
  return {
    info: {
      channelType,
      displayName: channelType,
      description: `Mock ${channelType} adaptor`,
    } satisfies ChannelAdaptorInfo,
    get status() {
      return _status;
    },
    start: vi.fn(async (_ctx: ChannelAdaptorContext) => {
      _status = 'running';
    }),
    stop: vi.fn(async () => {
      _status = 'stopped';
    }),
    isHealthy: vi.fn(() => _status === 'running'),
    ...overrides,
  };
}

const bindings: Binding[] = [
  { channel: 'default', agentId: 'assistant' },
];

const channelsConfig: ChannelsConfig = {
  adaptors: {
    webchat: { enabled: true },
    telegram: { enabled: false },
  },
};

describe('ChannelManager', () => {
  let gateway: ReturnType<typeof makeMockGateway>;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = makeMockGateway();
    logger = makeLogger();
  });

  it('registers an adaptor', () => {
    const manager = new ChannelManager({ gateway, bindings, channelsConfig, logger });
    const adaptor = makeMockAdaptor('webchat');
    manager.register(adaptor);

    expect(manager.getStatuses()).toHaveLength(1);
    expect(manager.getStatuses()[0]).toEqual({
      type: 'webchat',
      status: 'stopped',
      healthy: false,
    });
  });

  it('rejects duplicate channel type registration', () => {
    const manager = new ChannelManager({ gateway, bindings, channelsConfig, logger });
    manager.register(makeMockAdaptor('webchat'));
    expect(() => manager.register(makeMockAdaptor('webchat'))).toThrow(
      'already registered',
    );
  });

  it('starts enabled adaptors and skips disabled', async () => {
    const manager = new ChannelManager({ gateway, bindings, channelsConfig, logger });
    const webchat = makeMockAdaptor('webchat');
    const telegram = makeMockAdaptor('telegram');

    manager.register(webchat);
    manager.register(telegram);

    await manager.startAll();

    expect(webchat.start).toHaveBeenCalled();
    expect(telegram.start).not.toHaveBeenCalled();
  });

  it('logs error when adaptor start fails', async () => {
    const manager = new ChannelManager({ gateway, bindings, channelsConfig, logger });
    const failing = makeMockAdaptor('webchat', {
      start: vi.fn(async () => {
        throw new Error('port in use');
      }),
    });

    manager.register(failing);
    await manager.startAll();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('port in use'),
    );
  });

  it('stops all running adaptors', async () => {
    const manager = new ChannelManager({ gateway, bindings, channelsConfig, logger });
    const adaptor = makeMockAdaptor('webchat');
    manager.register(adaptor);

    await manager.startAll();
    expect(adaptor.status).toBe('running');

    await manager.stopAll();
    expect(adaptor.stop).toHaveBeenCalled();
  });

  it('getStatuses returns correct statuses', async () => {
    const manager = new ChannelManager({ gateway, bindings, channelsConfig, logger });
    const webchat = makeMockAdaptor('webchat');
    const telegram = makeMockAdaptor('telegram');

    manager.register(webchat);
    manager.register(telegram);

    await manager.startAll();

    const statuses = manager.getStatuses();
    expect(statuses).toHaveLength(2);

    const webchatStatus = statuses.find((s) => s.type === 'webchat');
    expect(webchatStatus?.status).toBe('running');
    expect(webchatStatus?.healthy).toBe(true);

    const telegramStatus = statuses.find((s) => s.type === 'telegram');
    expect(telegramStatus?.status).toBe('stopped');
    expect(telegramStatus?.healthy).toBe(false);
  });

  describe('allowlist enforcement', () => {
    it('allows authorized peers when allowlist is configured', async () => {
      const allowlistConfig: ChannelsConfig = {
        adaptors: {
          webchat: { enabled: true, allowlist: ['alice', 'bob'] },
        },
      };
      const manager = new ChannelManager({
        gateway,
        bindings,
        channelsConfig: allowlistConfig,
        logger,
      });
      const adaptor = makeMockAdaptor('webchat');
      manager.register(adaptor);
      await manager.startAll();

      // The adaptor.start is called with a context — we capture it
      const ctx = (adaptor.start as any).mock.calls[0][0] as ChannelAdaptorContext;

      // Authorized sender should succeed
      await expect(
        ctx.sendMessage({ text: 'hello', senderId: 'alice' }),
      ).resolves.toBeDefined();
    });

    it('rejects unauthorized peers when allowlist is configured', async () => {
      const allowlistConfig: ChannelsConfig = {
        adaptors: {
          webchat: { enabled: true, allowlist: ['alice', 'bob'] },
        },
      };
      const manager = new ChannelManager({
        gateway,
        bindings,
        channelsConfig: allowlistConfig,
        logger,
      });
      const adaptor = makeMockAdaptor('webchat');
      manager.register(adaptor);
      await manager.startAll();

      const ctx = (adaptor.start as any).mock.calls[0][0] as ChannelAdaptorContext;

      // Unauthorized sender should be rejected
      await expect(
        ctx.sendMessage({ text: 'hello', senderId: 'mallory' }),
      ).rejects.toThrow('not in the allowlist');
    });

    it('allows all peers when no allowlist is set', async () => {
      const manager = new ChannelManager({
        gateway,
        bindings,
        channelsConfig,
        logger,
      });
      const adaptor = makeMockAdaptor('webchat');
      manager.register(adaptor);
      await manager.startAll();

      const ctx = (adaptor.start as any).mock.calls[0][0] as ChannelAdaptorContext;

      // Any sender should succeed
      await expect(
        ctx.sendMessage({ text: 'hello', senderId: 'anyone' }),
      ).resolves.toBeDefined();
    });
  });

  describe('binding overrides propagation', () => {
    it('includes x-binding-overrides in metadata when binding has overrides', async () => {
      const overrides: BindingOverrides = { tools: { deny: ['bash'] } };
      const bindingsWithOverrides: Binding[] = [
        { channel: 'default', agentId: 'assistant', overrides },
      ];
      const manager = new ChannelManager({
        gateway,
        bindings: bindingsWithOverrides,
        channelsConfig,
        logger,
      });
      const adaptor = makeMockAdaptor('webchat');
      manager.register(adaptor);
      await manager.startAll();

      const ctx = (adaptor.start as any).mock.calls[0][0] as ChannelAdaptorContext;
      await ctx.sendMessage({ text: 'hello', senderId: 'user1' });

      // Verify gateway.send was called with metadata containing overrides
      expect(gateway.send).toHaveBeenCalledTimes(1);
      const injectedMsg = gateway.send.mock.calls[0][0] as AgentMessage;
      expect(injectedMsg.metadata).toBeDefined();
      expect(injectedMsg.metadata!['x-binding-overrides']).toBeDefined();

      const parsed = JSON.parse(injectedMsg.metadata!['x-binding-overrides']!) as BindingOverrides;
      expect(parsed.tools?.deny).toEqual(['bash']);
    });

    it('does not include x-binding-overrides when binding has no overrides', async () => {
      const manager = new ChannelManager({
        gateway,
        bindings,
        channelsConfig,
        logger,
      });
      const adaptor = makeMockAdaptor('webchat');
      manager.register(adaptor);
      await manager.startAll();

      const ctx = (adaptor.start as any).mock.calls[0][0] as ChannelAdaptorContext;
      await ctx.sendMessage({ text: 'hello', senderId: 'user1' });

      expect(gateway.send).toHaveBeenCalledTimes(1);
      const injectedMsg = gateway.send.mock.calls[0][0] as AgentMessage;
      expect(injectedMsg.metadata!['x-binding-overrides']).toBeUndefined();
    });

    it('preserves other metadata fields when adding overrides', async () => {
      const overrides: BindingOverrides = { model: 'gpt-4' };
      const bindingsWithOverrides: Binding[] = [
        { channel: 'default', agentId: 'assistant', overrides },
      ];
      const manager = new ChannelManager({
        gateway,
        bindings: bindingsWithOverrides,
        channelsConfig,
        logger,
      });
      const adaptor = makeMockAdaptor('webchat');
      manager.register(adaptor);
      await manager.startAll();

      const ctx = (adaptor.start as any).mock.calls[0][0] as ChannelAdaptorContext;
      await ctx.sendMessage({ text: 'hello', senderId: 'user1', conversationId: 'conv-1' });

      const injectedMsg = gateway.send.mock.calls[0][0] as AgentMessage;
      // Original metadata should still be present
      expect(injectedMsg.metadata!['channelType']).toBe('webchat');
      expect(injectedMsg.metadata!['senderId']).toBe('user1');
      expect(injectedMsg.metadata!['conversationId']).toBe('conv-1');
      // Overrides should also be present
      const parsed = JSON.parse(injectedMsg.metadata!['x-binding-overrides']!) as BindingOverrides;
      expect(parsed.model).toBe('gpt-4');
    });
  });
});
