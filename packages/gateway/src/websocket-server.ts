import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { generateId, now } from '@clothos/core';
import type { AgentMessage } from '@clothos/core';
import type { WsSession } from './types.js';

/** Handler that receives a message along with its originating WS session ID. */
export type WsMessageHandler = (msg: AgentMessage, wsSessionId: string) => void;

export interface WebSocketServerOptions {
  /** Standalone mode: listen on this port directly. Mutually exclusive with httpServer. */
  port?: number;
  host?: string;
  /** Shared mode: attach to an existing HTTP server. Mutually exclusive with port. */
  httpServer?: HttpServer;
  /** URL path to accept WebSocket upgrades on (only used with httpServer). Default: "/ws" */
  path?: string;
  /** When true and no token is provided, assign an anonymous identity. */
  allowAnonymous?: boolean;
  authenticate: (token: string) => Promise<string | null>;
  onMessage: WsMessageHandler;
  /** Called when a WebSocket session disconnects (close or error). */
  onDisconnect?: (sessionId: string) => void;
}

export class GatewayWebSocketServer {
  private wss: WebSocketServer | null = null;
  private readonly sessions = new Map<string, { ws: WebSocket; session: WsSession }>();

  async start(options: WebSocketServerOptions): Promise<void> {
    const { allowAnonymous = false } = options;

    if (options.httpServer) {
      // Shared (noServer) mode: manual upgrade handling
      this.wss = new WebSocketServer({ noServer: true });

      const wsPath = options.path ?? '/ws';

      options.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (url.pathname !== wsPath) {
          socket.destroy();
          return;
        }

        const token = this.extractToken(req);
        if (!token && !allowAnonymous) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        void (async () => {
          const userId = token
            ? await options.authenticate(token)
            : null;

          if (!userId && !allowAnonymous) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }

          const resolvedUserId = userId ?? `anon-${generateId().slice(0, 8)}`;

          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.handleConnection(ws, resolvedUserId, options.onMessage, options.onDisconnect);
          });
        })();
      });
    } else {
      // Standalone mode: own port (backward compatible, used by tests)
      this.wss = new WebSocketServer({
        port: options.port,
        host: options.host,
        verifyClient: async (info, cb) => {
          const token = this.extractToken(info.req);
          if (!token && !allowAnonymous) {
            cb(false, 401, 'Unauthorized');
            return;
          }
          const userId = token
            ? await options.authenticate(token)
            : null;
          if (!userId && !allowAnonymous) {
            cb(false, 403, 'Forbidden');
            return;
          }
          const resolvedUserId = userId ?? `anon-${generateId().slice(0, 8)}`;
          (info.req as IncomingMessage & { userId?: string }).userId = resolvedUserId;
          cb(true);
        },
      });

      this.wss.on('connection', (ws, req) => {
        const userId = (req as IncomingMessage & { userId?: string }).userId ?? 'unknown';
        this.handleConnection(ws, userId, options.onMessage, options.onDisconnect);
      });

      await new Promise<void>((resolve) => {
        this.wss!.on('listening', resolve);
      });
    }
  }

  private handleConnection(
    ws: WebSocket,
    userId: string,
    onMessage: WsMessageHandler,
    onDisconnect?: (sessionId: string) => void,
  ): void {
    const sessionId = generateId();
    const session: WsSession = {
      id: sessionId,
      userId,
      connectedAt: now(),
    };
    this.sessions.set(sessionId, { ws, session });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as AgentMessage;
        onMessage(msg, sessionId);
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      this.sessions.delete(sessionId);
      onDisconnect?.(sessionId);
    });

    ws.on('error', () => {
      this.sessions.delete(sessionId);
      onDisconnect?.(sessionId);
    });
  }

  send(sessionId: string, msg: AgentMessage): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
    entry.ws.send(JSON.stringify(msg));
    return true;
  }

  broadcast(msg: AgentMessage): void {
    const payload = JSON.stringify(msg);
    for (const { ws } of this.sessions.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  getSession(sessionId: string): WsSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    if (!this.wss) return;
    for (const { ws } of this.sessions.values()) {
      ws.close(1001, 'Server shutting down');
    }
    this.sessions.clear();
    await new Promise<void>((resolve, reject) => {
      this.wss!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.wss = null;
  }

  private extractToken(req: IncomingMessage): string | null {
    // Check Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    // Fall back to query parameter
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    return url.searchParams.get('token');
  }
}
