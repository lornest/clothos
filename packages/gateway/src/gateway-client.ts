import { WebSocket } from 'ws';
import type { AgentMessage, GatewayTransport, Logger } from '@clothos/core';

export interface GatewayClientOptions {
  /** WebSocket URL, e.g. ws://localhost:18789/ws */
  url: string;
  /** API key — exchanged for a JWT via POST /auth/token before connecting. */
  apiKey?: string;
  /** Raw auth token (legacy shared secret). Used directly if apiKey is not set. */
  authToken?: string;
  /** Auto-reconnect on disconnect. Default: true. */
  reconnect?: boolean;
  /** Max reconnect backoff in ms. Default: 30 000. */
  maxReconnectDelayMs?: number;
  logger?: Logger;
}

/**
 * WebSocket client that connects to a GatewayServer as a regular client.
 * Used by channel adaptors so they go through the same auth, rate-limiting,
 * and circuit-breaker pipeline as every other client (e.g. the web UI).
 */
export class GatewayClient implements GatewayTransport {
  private ws: WebSocket | null = null;
  private readonly responseHandlers = new Map<string, (msg: AgentMessage) => void>();
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly authToken: string | undefined;
  private readonly shouldReconnect: boolean;
  private readonly maxReconnectDelayMs: number;
  private readonly logger: Logger | undefined;

  private jwt: string | null = null;
  private jwtExpiresIn = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(options: GatewayClientOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.authToken = options.authToken;
    this.shouldReconnect = options.reconnect ?? true;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.logger = options.logger;
  }

  async connect(): Promise<void> {
    this.closing = false;
    if (this.apiKey) {
      await this.acquireToken();
    }
    return this.doConnect();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000, 'Client shutting down');
    }
    this.responseHandlers.clear();
  }

  async send(msg: AgentMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('GatewayClient is not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  onResponse(correlationId: string, handler: (msg: AgentMessage) => void): void {
    this.responseHandlers.set(correlationId, handler);
  }

  removeResponseHandler(correlationId: string): void {
    this.responseHandlers.delete(correlationId);
  }

  /** Derive the HTTP base URL from the WebSocket URL. */
  private getHttpBaseUrl(): string {
    const wsUrl = new URL(this.url);
    wsUrl.protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    // Remove the /ws path to get the server root
    wsUrl.pathname = '';
    return wsUrl.origin;
  }

  /** Exchange API key for a JWT via POST /auth/token. */
  private async acquireToken(): Promise<void> {
    const baseUrl = this.getHttpBaseUrl();
    const res = await fetch(`${baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: this.apiKey }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token acquisition failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { token: string; expiresIn: number };
    this.jwt = data.token;
    this.jwtExpiresIn = data.expiresIn;
    this.scheduleTokenRefresh();
  }

  /** Schedule a token refresh at 80% of the expiry time. */
  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!this.apiKey || this.jwtExpiresIn <= 0) return;

    const refreshMs = this.jwtExpiresIn * 1000 * 0.8;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.acquireToken().catch((err) => {
        this.logger?.error(
          `JWT refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, refreshMs);
    this.refreshTimer.unref?.();
  }

  private getAuthToken(): string | undefined {
    // Prefer JWT from API key exchange; fall back to static authToken
    return this.jwt ?? this.authToken;
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const token = this.getAuthToken();
      const url = token
        ? `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
        : this.url;

      const ws = new WebSocket(url);

      ws.on('open', () => {
        this.ws = ws;
        this.reconnectAttempt = 0;
        this.logger?.info('GatewayClient connected');
        resolve();
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as AgentMessage;
          const correlationId = msg.correlationId ?? msg.id;
          const handler = this.responseHandlers.get(correlationId);
          if (handler) {
            handler(msg);
          }
        } catch {
          this.logger?.warn('GatewayClient: failed to parse incoming message');
        }
      });

      ws.on('close', () => {
        this.ws = null;
        if (!this.closing) {
          this.logger?.warn('GatewayClient disconnected');
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (!this.ws) {
          // Connection failed on initial attempt
          reject(new Error(`GatewayClient connection failed: ${err.message}`));
          return;
        }
        this.logger?.error(`GatewayClient error: ${err.message}`);
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.closing) return;

    const delay = Math.min(
      1000 * 2 ** this.reconnectAttempt,
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempt++;

    this.logger?.info(`GatewayClient reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-acquire token before reconnecting if using API key
      const preConnect = this.apiKey ? this.acquireToken() : Promise.resolve();
      preConnect
        .then(() => this.doConnect())
        .catch((err) => {
          this.logger?.error(
            `GatewayClient reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.scheduleReconnect();
        });
    }, delay);
  }
}
