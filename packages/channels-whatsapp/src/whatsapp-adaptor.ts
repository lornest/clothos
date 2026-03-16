import * as path from 'node:path';
import type {
  ChannelAdaptor,
  ChannelAdaptorContext,
  ChannelAdaptorInfo,
  ChannelAdaptorStatus,
  InboundMessage,
  OutboundMessage,
} from '@clothos/core';
import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from '@clothos/core';

/** Disconnect reasons that should NOT trigger reconnection. */
const FATAL_DISCONNECT_REASONS = new Set([
  DisconnectReason.loggedOut,           // 401
  DisconnectReason.forbidden,           // 403
  405,                                  // Method Not Allowed (not in enum but observed)
  DisconnectReason.multideviceMismatch, // 411
  DisconnectReason.connectionReplaced,  // 440
  DisconnectReason.badSession,          // 500
]);

/** Reverse map for human-readable disconnect reason logging. */
const DISCONNECT_REASON_NAME: Record<number, string> = {
  [DisconnectReason.connectionClosed]: 'connectionClosed',
  [DisconnectReason.connectionLost]: 'connectionLost',
  [DisconnectReason.connectionReplaced]: 'connectionReplaced',
  [DisconnectReason.loggedOut]: 'loggedOut',
  [DisconnectReason.badSession]: 'badSession',
  [DisconnectReason.restartRequired]: 'restartRequired',
  [DisconnectReason.multideviceMismatch]: 'multideviceMismatch',
  [DisconnectReason.forbidden]: 'forbidden',
  [DisconnectReason.unavailableService]: 'unavailableService',
};

/**
 * Create a Baileys-compatible logger that forwards warn/error to our logger
 * but silences the verbose trace/debug/info noise.
 */
function makeBaileysLogger(appLogger: Logger) {
  const logger: Record<string, unknown> = {
    level: 'warn',
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (msg: unknown) => {
      appLogger.warn(`WhatsApp/Baileys: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    },
    error: (msg: unknown) => {
      appLogger.error(`WhatsApp/Baileys: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    },
  };
  return logger as unknown as Parameters<typeof makeWASocket>[0]['logger'];
}

export class WhatsAppAdaptor implements ChannelAdaptor {
  readonly info: ChannelAdaptorInfo = {
    channelType: 'whatsapp',
    displayName: 'WhatsApp',
    description: 'WhatsApp via Baileys (multi-device)',
  };

  private _status: ChannelAdaptorStatus = 'stopped';
  get status(): ChannelAdaptorStatus {
    return this._status;
  }

  private sock: WASocket | null = null;
  private ctx: ChannelAdaptorContext | null = null;
  private resolvedAuthDir: string | null = null;
  private stopping = false;
  private retryCount = 0;
  private readonly maxRetries = 10;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Maps correlationId → WhatsApp JID for response routing. */
  private readonly chatJids = new Map<string, string>();

  /** Buffers responses that arrive before JID mapping is stored. */
  private readonly earlyResponses = new Map<string, OutboundMessage[]>();

  async start(ctx: ChannelAdaptorContext): Promise<void> {
    const authDir = ctx.config.settings?.authDir;
    if (!authDir || typeof authDir !== 'string' || authDir.length === 0) {
      throw new Error(
        'WhatsApp adaptor requires a non-empty "authDir" in settings',
      );
    }

    this.ctx = ctx;
    this.stopping = false;
    this.retryCount = 0;
    this.reconnecting = false;
    this._status = 'starting';

    this.resolvedAuthDir = path.isAbsolute(authDir)
      ? authDir
      : path.resolve(authDir);

    // Register outbound response handler once
    ctx.onResponse((outbound: OutboundMessage) => {
      const jid = this.chatJids.get(outbound.correlationId);
      if (jid !== undefined && this.sock) {
        void this.sendResponse(this.sock, jid, outbound);
        return;
      }

      // JID not yet mapped — buffer the response for when it arrives
      let buffer = this.earlyResponses.get(outbound.correlationId);
      if (!buffer) {
        buffer = [];
        this.earlyResponses.set(outbound.correlationId, buffer);
      }
      buffer.push(outbound);
    });

    await this.connect();
    this._status = 'running';
  }

  /** Create a Baileys socket and bind events. Called on start and on reconnect. */
  private async connect(): Promise<void> {
    const ctx = this.ctx!;
    const authDir = this.resolvedAuthDir!;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const baileysLogger = makeBaileysLogger(ctx.logger);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger!),
      },
      browser: Browsers.macOS('AgentOS'),
      printQRInTerminal: true,
      markOnlineOnConnect: false,
      logger: baileysLogger,
    });

    // Persist credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Track connection state
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        ctx.logger.info(
          'WhatsApp: scan the QR code above with WhatsApp → Linked Devices → Link a Device',
        );
      }

      if (connection === 'open') {
        ctx.logger.info('WhatsApp: connected');
        this.retryCount = 0;
        this.reconnecting = false;
        this._status = 'running';
      }

      if (connection === 'close') {
        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode;

        const reasonName = statusCode !== undefined
          ? (DISCONNECT_REASON_NAME[statusCode] ?? 'unknown')
          : 'unknown';

        ctx.logger.info(
          `WhatsApp: disconnected — reason=${reasonName} (${statusCode ?? '?'})`,
        );

        this.cleanupSocket(sock);

        if (statusCode !== undefined && FATAL_DISCONNECT_REASONS.has(statusCode)) {
          ctx.logger.error(
            `WhatsApp: fatal disconnect (${reasonName}). ` +
            (statusCode === DisconnectReason.loggedOut
              ? 'Delete the auth directory and restart to re-link.'
              : 'Check configuration and restart.'),
          );
          this._status = 'error';
          return;
        }

        this.scheduleReconnect(statusCode);
      }
    });

    // Handle inbound messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          '';

        if (!text) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const inbound: InboundMessage = {
          text,
          senderId: remoteJid,
          conversationId: remoteJid,
          platformData: {
            messageId: msg.key.id,
            pushName: msg.pushName,
            isGroup: remoteJid.endsWith('@g.us'),
          },
        };

        try {
          const correlationId = await ctx.sendMessage(inbound);

          this.chatJids.set(correlationId, remoteJid);

          const buffered = this.earlyResponses.get(correlationId);
          if (buffered) {
            this.earlyResponses.delete(correlationId);
            for (const outbound of buffered) {
              void this.sendResponse(sock, remoteJid, outbound);
            }
          }
        } catch (err) {
          ctx.logger.error(
            `WhatsApp: failed to process inbound message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    this.sock = sock;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      this.cleanupSocket(this.sock);
      this.sock.end(undefined);
    }
    this.retryCount = 0;
    this.reconnecting = false;
    this.chatJids.clear();
    this.earlyResponses.clear();
    this.sock = null;
    this.ctx = null;
    this.resolvedAuthDir = null;
    this._status = 'stopped';
  }

  /** Remove event listeners from an old socket to prevent ghost handlers. */
  private cleanupSocket(sock: WASocket): void {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('messages.upsert');
    sock.ev.removeAllListeners('creds.update');
  }

  /** Exponential backoff: min(1s * 2^attempt, 60s) + jitter. 0 for restartRequired. */
  private computeBackoff(statusCode: number | undefined): number {
    if (statusCode === DisconnectReason.restartRequired) return 0;
    const base = Math.min(1000 * 2 ** this.retryCount, 60_000);
    return base + Math.random() * 1000;
  }

  /** Schedule a reconnection attempt with backoff and retry limits. */
  private scheduleReconnect(statusCode: number | undefined): void {
    if (this.stopping || this.reconnecting) return;

    this.retryCount++;
    if (this.retryCount > this.maxRetries) {
      this.ctx?.logger.error(
        `WhatsApp: max retries (${this.maxRetries}) exceeded — giving up`,
      );
      this._status = 'error';
      return;
    }

    this.reconnecting = true;
    this._status = 'starting';

    const delay = this.computeBackoff(statusCode);
    this.ctx?.logger.info(
      `WhatsApp: reconnecting in ${Math.round(delay)}ms (attempt ${this.retryCount}/${this.maxRetries})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      this.connect().catch(() => {
        this.scheduleReconnect(statusCode);
      });
    }, delay);
  }

  isHealthy(): boolean {
    return this._status === 'running' && this.sock !== null;
  }

  private async sendResponse(
    sock: WASocket,
    jid: string,
    outbound: OutboundMessage,
  ): Promise<void> {
    const isDone =
      outbound.data?.type === 'task.done' ||
      outbound.data?.type === 'task.error';

    const hasText =
      outbound.text && outbound.text !== '{}' && outbound.text !== 'undefined';
    if (!hasText) {
      if (isDone) {
        this.chatJids.delete(outbound.correlationId);
        this.ctx?.removeResponseListener(outbound.correlationId);
      }
      return;
    }

    try {
      await sock.sendMessage(jid, { text: outbound.text });
    } catch (err) {
      this.ctx?.logger.error(
        `WhatsApp: failed to send message to ${jid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (isDone) {
      this.chatJids.delete(outbound.correlationId);
      this.ctx?.removeResponseListener(outbound.correlationId);
    }
  }
}
