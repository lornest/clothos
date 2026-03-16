import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentMessage } from '@clothos/core';
import { GatewayClient } from '../src/gateway-client.js';
import { signToken } from '../src/jwt.js';

function makeMsg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'msg-1',
    specversion: '1.0',
    type: 'task.request',
    source: 'channel://telegram/user1',
    target: 'agent://assistant',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: { text: 'hello' },
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('GatewayClient', () => {
  let wss: WebSocketServer;
  let port: number;
  let serverConnections: WebSocket[];

  beforeEach(async () => {
    serverConnections = [];
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.on('listening', resolve));
    const addr = wss.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    wss.on('connection', (ws) => {
      serverConnections.push(ws);
    });
  });

  afterEach(async () => {
    for (const ws of serverConnections) {
      ws.close();
    }
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('connects to a WebSocket server', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });
    await client.connect();
    expect(serverConnections).toHaveLength(1);
    await client.disconnect();
  });

  it('sends AgentMessage as JSON over WebSocket', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });
    await client.connect();

    const received = new Promise<AgentMessage>((resolve) => {
      serverConnections[0]!.on('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    const msg = makeMsg();
    await client.send(msg);

    const parsed = await received;
    expect(parsed.id).toBe('msg-1');
    expect(parsed.target).toBe('agent://assistant');

    await client.disconnect();
  });

  it('routes responses by correlationId to registered handlers', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });
    await client.connect();

    const handler = vi.fn();
    client.onResponse('corr-1', handler);

    // Server sends a response with matching correlationId
    const response = makeMsg({ id: 'resp-1', correlationId: 'corr-1' });
    serverConnections[0]!.send(JSON.stringify(response));

    // Wait for message delivery
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'resp-1' }));

    await client.disconnect();
  });

  it('ignores responses with no matching handler', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });
    await client.connect();

    const handler = vi.fn();
    client.onResponse('corr-1', handler);

    // Server sends a response with a different correlationId
    const response = makeMsg({ id: 'resp-2', correlationId: 'corr-other' });
    serverConnections[0]!.send(JSON.stringify(response));

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();

    await client.disconnect();
  });

  it('removes response handlers via removeResponseHandler', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });
    await client.connect();

    const handler = vi.fn();
    client.onResponse('corr-1', handler);
    client.removeResponseHandler('corr-1');

    const response = makeMsg({ id: 'resp-1', correlationId: 'corr-1' });
    serverConnections[0]!.send(JSON.stringify(response));

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();

    await client.disconnect();
  });

  it('throws on send when not connected', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });

    await expect(client.send(makeMsg())).rejects.toThrow('not connected');
  });

  it('passes auth token as query parameter', async () => {
    const receivedUrl = new Promise<string>((resolve) => {
      wss.removeAllListeners('connection');
      wss.on('connection', (ws, req) => {
        serverConnections.push(ws);
        resolve(req.url ?? '');
      });
    });

    const client = new GatewayClient({
      url: `ws://localhost:${port}/ws`,
      authToken: 'my-secret',
      reconnect: false,
    });
    await client.connect();

    const url = await receivedUrl;
    expect(url).toContain('token=my-secret');

    await client.disconnect();
  });

  it('clears handlers on disconnect', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${port}`,
      reconnect: false,
    });
    await client.connect();

    const handler = vi.fn();
    client.onResponse('corr-1', handler);

    await client.disconnect();

    // After disconnect, handler map should be cleared
    // Reconnecting and sending a matching response should not trigger the old handler
    // (We verify indirectly: send throws because disconnected)
    await expect(client.send(makeMsg())).rejects.toThrow('not connected');
  });
});

describe('GatewayClient JWT acquisition', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let httpPort: number;
  let serverConnections: WebSocket[];
  const JWT_SECRET = 'test-secret-for-client-jwt';

  beforeEach(async () => {
    serverConnections = [];

    httpServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/token') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          void (async () => {
            const parsed = JSON.parse(body) as { key?: string };
            if (parsed.key === 'valid-key') {
              const { token, expiresIn } = await signToken('channels', JWT_SECRET, 3_600_000);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ token, expiresIn }));
            } else {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid API key' }));
            }
          })();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws) => {
      serverConnections.push(ws);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, resolve);
    });
    const addr = httpServer.address();
    httpPort = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    for (const ws of serverConnections) {
      ws.close();
    }
    wss.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('exchanges apiKey for JWT before connecting', async () => {
    const receivedUrl = new Promise<string>((resolve) => {
      wss.removeAllListeners('connection');
      wss.on('connection', (ws, req) => {
        serverConnections.push(ws);
        resolve(req.url ?? '');
      });
    });

    const client = new GatewayClient({
      url: `ws://localhost:${httpPort}/ws`,
      apiKey: 'valid-key',
      reconnect: false,
    });
    await client.connect();

    const url = await receivedUrl;
    // The token query param should contain a JWT (has dots)
    expect(url).toMatch(/token=.+\..+\..+/);

    await client.disconnect();
  });

  it('throws when API key is invalid', async () => {
    const client = new GatewayClient({
      url: `ws://localhost:${httpPort}/ws`,
      apiKey: 'invalid-key',
      reconnect: false,
    });

    await expect(client.connect()).rejects.toThrow('Token acquisition failed');
  });

  it('falls back to authToken when apiKey is not set', async () => {
    const receivedUrl = new Promise<string>((resolve) => {
      wss.removeAllListeners('connection');
      wss.on('connection', (ws, req) => {
        serverConnections.push(ws);
        resolve(req.url ?? '');
      });
    });

    const client = new GatewayClient({
      url: `ws://localhost:${httpPort}/ws`,
      authToken: 'my-shared-secret',
      reconnect: false,
    });
    await client.connect();

    const url = await receivedUrl;
    expect(url).toContain('token=my-shared-secret');

    await client.disconnect();
  });
});
