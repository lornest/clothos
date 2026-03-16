import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AgentMessage, GatewayConfig } from '@clothos/core';
import { NatsClient } from './nats-client.js';
import { RedisClient } from './redis-client.js';
import { LaneQueue } from './lane-queue.js';
import { MessageRouter } from './router.js';
import { GatewayWebSocketServer } from './websocket-server.js';
import { StaticServer } from './static-server.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { signToken, verifyToken } from './jwt.js';
import type { HealthStatus, LaneKey, Subscription } from './types.js';

export class GatewayServer {
  private readonly nats = new NatsClient();
  private readonly redis = new RedisClient();
  private readonly laneQueue = new LaneQueue();
  private readonly router: MessageRouter;
  private readonly ws = new GatewayWebSocketServer();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly targetSubscriptions = new Map<string, Subscription>();

  /** Maps service account id → API key. */
  private readonly serviceKeys = new Map<string, string>();
  private jwtSecret = '';

  private httpServer: Server | null = null;
  private staticServer: StaticServer | null = null;
  private startTime = Date.now();

  /** Maps correlationId → WS session ID for response routing. */
  private readonly pendingResponses = new Map<string, { sessionId: string; createdAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private readonly config: GatewayConfig) {
    this.router = new MessageRouter(this.nats);
  }

  /** Register an API key for a service account. */
  registerServiceKey(id: string, key: string): void {
    this.serviceKeys.set(id, key);
  }

  async start(): Promise<void> {
    this.startTime = Date.now();

    // Auto-generate JWT secret if not configured
    this.jwtSecret = this.config.websocket.jwtSecret ?? randomBytes(32).toString('hex');

    // Start services in dependency order
    await this.nats.connect(this.config.nats.url, this.config.nats.credentials);
    await this.redis.connect(this.config.redis.url);

    // Initialize static server if UI is enabled
    if (this.config.ui?.enabled) {
      this.staticServer = new StaticServer(this.config.ui.staticPath);
    }

    // Create unified HTTP server
    this.httpServer = createServer(
      (req: IncomingMessage, res: ServerResponse) =>
        this.handleHttpRequest(req, res),
    );

    const jwtSecret = this.jwtSecret;

    // Attach WebSocket to the shared HTTP server
    await this.ws.start({
      httpServer: this.httpServer,
      path: '/ws',
      allowAnonymous: this.config.websocket.allowAnonymous ?? false,
      authenticate: async (token: string) => {
        // Try JWT first (JWTs contain dots)
        if (token.includes('.') && jwtSecret) {
          const payload = await verifyToken(token, jwtSecret);
          if (payload) return payload.sub;
        }
        // Fall back to shared secret (web UI / backward compat)
        const secret = this.config.websocket.sharedSecret;
        if (secret && token === secret) return 'authenticated';
        // No valid credential: allow if anonymous mode is enabled
        if (this.config.websocket.allowAnonymous) return token || null;
        return null;
      },
      onMessage: (msg: AgentMessage, sessionId?: string) =>
        this.handleIncomingMessage(msg, sessionId),
      onDisconnect: (sessionId: string) => {
        for (const [correlationId, entry] of this.pendingResponses) {
          if (entry.sessionId === sessionId) {
            this.pendingResponses.delete(correlationId);
          }
        }
      },
    });

    this.startCleanupLoop();

    // Listen on the configured port
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.config.websocket.port, this.config.websocket.host, resolve);
    });
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';

    // POST /auth/token — exchange API key for JWT
    if (req.method === 'POST' && url === '/auth/token') {
      this.handleTokenRequest(req, res);
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    // Health endpoints (inlined from HealthServer)
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url === '/ready') {
      const nats = this.nats.isConnected();
      const redis = this.redis.isConnected();
      const status: HealthStatus = {
        status: nats && redis ? 'ok' : 'degraded',
        nats,
        redis,
        uptime: Date.now() - this.startTime,
      };
      res.writeHead(nats && redis ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(status));
      return;
    }

    // Static file serving (SPA)
    if (this.staticServer) {
      this.staticServer.handle(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleTokenRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      // Guard against oversized payloads
      if (body.length > 4096) {
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });
    req.on('end', () => {
      void (async () => {
        try {
          const parsed = JSON.parse(body) as { key?: string };
          const key = parsed.key;
          if (typeof key !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing "key" field' }));
            return;
          }

          // Look up which service account owns this key
          let serviceId: string | null = null;
          for (const [id, storedKey] of this.serviceKeys) {
            if (storedKey === key) {
              serviceId = id;
              break;
            }
          }

          if (!serviceId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid API key' }));
            return;
          }

          const expiryMs = this.config.websocket.tokenExpiryMs ?? 3_600_000;
          const { token, expiresIn } = await signToken(serviceId, this.jwtSecret, expiryMs);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token, expiresIn }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      })();
    });
  }

  private async handleIncomingMessage(
    msg: AgentMessage,
    wsSessionId?: string,
  ): Promise<void> {
    // Track the WS session for response routing
    if (wsSessionId) {
      const correlationId = msg.correlationId ?? msg.id;
      this.pendingResponses.set(correlationId, { sessionId: wsSessionId, createdAt: Date.now() });
    }

    const laneKey: LaneKey = this.buildLaneKey(msg);

    await this.laneQueue.enqueue(laneKey, msg, async (m) => {
      // Idempotency check
      const key = m.idempotencyKey ?? m.id;
      const isNew = await this.redis.checkIdempotency(key);
      if (!isNew) return; // Duplicate, skip

      // Circuit breaker check — when open, consumer is paused so messages
      // shouldn't arrive, but guard silently just in case.
      const cb = this.getCircuitBreaker(m.target);
      if (!cb.isAllowed()) {
        return;
      }

      try {
        await this.router.route(m);
        cb.recordSuccess();
      } catch (err) {
        cb.recordFailure();
        throw err;
      }
    });
  }

  private buildLaneKey(msg: AgentMessage): LaneKey {
    // Extract components from source/target for lane ordering
    const source = msg.source.replace(/^\w+:\/\//, '');
    const target = msg.target.replace(/^\w+:\/\//, '');
    return `${source}:${target}:${msg.correlationId ?? 'default'}`;
  }

  private getCircuitBreaker(target: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(target);
    if (!cb) {
      cb = new CircuitBreaker({
        onStateChange: (newState) => {
          const sub = this.targetSubscriptions.get(target);
          if (!sub) return;
          if (newState === 'OPEN') {
            sub.pause();
          } else if (newState === 'CLOSED') {
            sub.resume().catch(() => {
              // Best-effort resume
            });
          }
        },
      });
      this.circuitBreakers.set(target, cb);
    }
    return cb;
  }

  registerSubscription(target: string, sub: Subscription): void {
    this.targetSubscriptions.set(target, sub);
  }

  unregisterSubscription(target: string): void {
    this.targetSubscriptions.delete(target);
  }

  async stop(): Promise<void> {
    // Graceful shutdown in reverse order
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.ws.close();
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.httpServer = null;
    }
    await this.redis.close();
    await this.nats.close();
  }

  /**
   * Send a response back to the WS client that originated the request.
   * Looks up the WS session ID via the correlationId.
   */
  sendResponse(correlationId: string, response: AgentMessage): boolean {
    const pending = this.pendingResponses.get(correlationId);
    if (pending) {
      return this.ws.send(pending.sessionId, response);
    }
    return false;
  }

  /**
   * Remove a pending response tracking entry.
   * Call after the final response has been sent.
   */
  completePendingResponse(correlationId: string): void {
    this.pendingResponses.delete(correlationId);
  }

  private startCleanupLoop(): void {
    const ttlMs = this.config.websocket.responseTtlMs ?? 10 * 60 * 1000;
    if (ttlMs <= 0) return;
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - ttlMs;
      for (const [correlationId, entry] of this.pendingResponses) {
        if (entry.createdAt < cutoff) {
          this.pendingResponses.delete(correlationId);
        }
      }
    }, Math.min(ttlMs, 60_000));
    this.cleanupInterval.unref?.();
  }

  getNatsClient(): NatsClient {
    return this.nats;
  }

  getRedisClient(): RedisClient {
    return this.redis;
  }

  getWebSocketServer(): GatewayWebSocketServer {
    return this.ws;
  }
}
