/** Shape matching AgentMessage from @clothos/core. */
export interface AgentMessage {
  id: string;
  specversion: '1.0';
  type: string;
  source: string;
  target: string;
  time: string;
  datacontenttype: string;
  data: unknown;
  correlationId?: string;
  metadata?: Record<string, string>;
}

type MessageCallback = (msg: AgentMessage) => void;

/**
 * WebSocket client that connects to the Gateway at /ws.
 * Sends and receives AgentMessage objects. Auto-reconnects with exponential backoff.
 */
export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private intentionallyClosed = false;
  private onMessage: MessageCallback | null = null;
  private onStatusChange: ((connected: boolean) => void) | null = null;
  private token: string | undefined;

  connect(
    onMessage: MessageCallback,
    onStatusChange?: (connected: boolean) => void,
    token?: string,
  ): void {
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange ?? null;
    this.token = token;
    this.intentionallyClosed = false;
    this.doConnect();
  }

  private doConnect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${protocol}//${location.host}/ws`;
    const url = this.token ? `${base}?token=${encodeURIComponent(this.token)}` : base;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.onStatusChange?.(true);
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as AgentMessage;
        this.onMessage?.(msg);
      } catch {
        // Ignore unparseable messages
      }
    };

    this.ws.onclose = () => {
      this.onStatusChange?.(false);
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.maxReconnectDelay,
      );
      this.doConnect();
    }, this.reconnectDelay);
  }

  send(msg: AgentMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
