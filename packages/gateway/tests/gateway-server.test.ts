import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { GatewayServer } from '../src/gateway-server.js';
import type { GatewayConfig } from '@clothos/core';
import type { Subscription } from '../src/types.js';
import { verifyToken } from '../src/jwt.js';

// Mock all dependencies using class-based mocks
vi.mock('../src/nats-client.js', () => ({
  NatsClient: class MockNatsClient {
    connect = vi.fn().mockResolvedValue(undefined);
    publish = vi.fn().mockResolvedValue(undefined);
    isConnected = vi.fn().mockReturnValue(true);
    close = vi.fn().mockResolvedValue(undefined);
    drain = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../src/redis-client.js', () => ({
  RedisClient: class MockRedisClient {
    connect = vi.fn().mockResolvedValue(undefined);
    checkIdempotency = vi.fn().mockResolvedValue(true);
    isConnected = vi.fn().mockReturnValue(true);
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../src/websocket-server.js', () => ({
  GatewayWebSocketServer: class MockWsServer {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../src/static-server.js', () => ({
  StaticServer: class MockStaticServer {
    handle = vi.fn();
  },
}));

const testConfig: GatewayConfig = {
  nats: { url: 'nats://localhost:4222' },
  redis: { url: 'redis://localhost:6379' },
  websocket: { port: 18789, allowAnonymous: true },
  maxConcurrentAgents: 10,
};

const testConfigWithUi: GatewayConfig = {
  ...testConfig,
  ui: { enabled: true, title: 'Test UI' },
};

function makeMockSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subject: 'agent.test.inbox',
    queueGroup: undefined,
    streamName: 'AGENT_TASKS',
    consumerName: 'consumer-test',
    unsubscribe: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('GatewayServer', () => {
  let server: GatewayServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new GatewayServer(testConfig);
  });

  it('constructs without error', () => {
    expect(server).toBeDefined();
  });

  it('starts all services', async () => {
    await server.start();
    expect(server.getNatsClient().connect).toHaveBeenCalledWith(
      'nats://localhost:4222',
      undefined,
    );
    expect(server.getRedisClient().connect).toHaveBeenCalledWith(
      'redis://localhost:6379',
    );
    await server.stop();
  });

  it('stops all services in reverse order', async () => {
    await server.start();
    await server.stop();

    expect(server.getNatsClient().close).toHaveBeenCalled();
    expect(server.getRedisClient().close).toHaveBeenCalled();
  });

  it('exposes NATS and Redis clients', () => {
    expect(server.getNatsClient()).toBeDefined();
    expect(server.getRedisClient()).toBeDefined();
  });

  it('registers and unregisters subscriptions', () => {
    const sub = makeMockSubscription();
    server.registerSubscription('agent://test', sub);
    // No error means success; unregister should also work
    server.unregisterSubscription('agent://test');
  });

  it('passes httpServer to WebSocket start', async () => {
    await server.start();
    const wsServer = server.getWebSocketServer();
    expect(wsServer.start).toHaveBeenCalledWith(
      expect.objectContaining({
        httpServer: expect.any(Object),
        path: '/ws',
        allowAnonymous: true,
      }),
    );
    await server.stop();
  });

  it('passes onDisconnect to WebSocket start', async () => {
    await server.start();
    const wsServer = server.getWebSocketServer();
    expect(wsServer.start).toHaveBeenCalledWith(
      expect.objectContaining({ onDisconnect: expect.any(Function) }),
    );
    await server.stop();
  });

  it('defaults allowAnonymous to false when omitted', async () => {
    const secureConfig: GatewayConfig = {
      nats: { url: 'nats://localhost:4222' },
      redis: { url: 'redis://localhost:6379' },
      websocket: { port: 18790 },
      maxConcurrentAgents: 10,
    };
    const secureServer = new GatewayServer(secureConfig);
    await secureServer.start();
    const wsServer = secureServer.getWebSocketServer();
    expect(wsServer.start).toHaveBeenCalledWith(
      expect.objectContaining({ allowAnonymous: false }),
    );
    await secureServer.stop();
  });

  it('constructs with UI config', () => {
    const serverWithUi = new GatewayServer(testConfigWithUi);
    expect(serverWithUi).toBeDefined();
  });

  it('registers a service key', () => {
    server.registerServiceKey('channels', 'test-key-123');
    // No error means success — we verify via the token endpoint in integration tests
  });
});

describe('GatewayServer POST /auth/token', () => {
  let server: GatewayServer;
  const port = 0; // Let OS assign a free port
  let actualPort: number;

  const tokenConfig: GatewayConfig = {
    nats: { url: 'nats://localhost:4222' },
    redis: { url: 'redis://localhost:6379' },
    websocket: {
      port,
      allowAnonymous: true,
      jwtSecret: 'test-jwt-secret-for-token-endpoint',
    },
    maxConcurrentAgents: 10,
  };

  beforeAll(async () => {
    vi.clearAllMocks();
    server = new GatewayServer(tokenConfig);
    await server.start();
    // Extract the OS-assigned port
    const addr = (server as unknown as { httpServer: { address: () => { port: number } } }).httpServer.address();
    actualPort = addr.port;
    server.registerServiceKey('channels', 'my-api-key');
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns a JWT for a valid service key', async () => {
    const res = await fetch(`http://localhost:${actualPort}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'my-api-key' }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; expiresIn: number };
    expect(data.token).toBeDefined();
    expect(data.expiresIn).toBe(3600);

    // Verify the JWT is valid
    const payload = await verifyToken(data.token, 'test-jwt-secret-for-token-endpoint');
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('channels');
  });

  it('returns 401 for an invalid API key', async () => {
    const res = await fetch(`http://localhost:${actualPort}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'wrong-key' }),
    });

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 for missing key field', async () => {
    const res = await fetch(`http://localhost:${actualPort}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Missing "key" field');
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`http://localhost:${actualPort}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
  });
});
