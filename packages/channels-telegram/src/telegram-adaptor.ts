import type {
  ChannelAdaptor,
  ChannelAdaptorContext,
  ChannelAdaptorInfo,
  ChannelAdaptorStatus,
  InboundMessage,
  OutboundMessage,
} from '@clothos/core';
import { Bot } from 'grammy';

/** Maximum Telegram message length. */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Split text into chunks of at most `maxLen` characters,
 * preferring to break at newlines.
 */
function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) {
      // No newline found — break at last space
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt <= 0) {
      // No good break point — hard split
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export class TelegramAdaptor implements ChannelAdaptor {
  readonly info: ChannelAdaptorInfo = {
    channelType: 'telegram',
    displayName: 'Telegram',
    description: 'Telegram Bot API via grammY (long polling)',
  };

  private _status: ChannelAdaptorStatus = 'stopped';
  get status(): ChannelAdaptorStatus {
    return this._status;
  }

  private bot: Bot | null = null;
  private ctx: ChannelAdaptorContext | null = null;

  /** Maps correlationId → Telegram chatId for response routing. */
  private readonly chatIds = new Map<string, number>();

  /** Buffers responses that arrive before chatId mapping is stored. */
  private readonly earlyResponses = new Map<string, OutboundMessage[]>();

  async start(ctx: ChannelAdaptorContext): Promise<void> {
    const botToken = ctx.config.settings?.botToken;
    if (!botToken || typeof botToken !== 'string' || botToken.length === 0) {
      throw new Error(
        'Telegram adaptor requires a non-empty "botToken" in settings',
      );
    }

    this.ctx = ctx;
    this._status = 'starting';

    const bot = new Bot(botToken);

    // Handle inbound text messages
    bot.on('message:text', async (grammyCtx) => {
      const inbound: InboundMessage = {
        text: grammyCtx.message.text,
        senderId: String(grammyCtx.from.id),
        conversationId: String(grammyCtx.chat.id),
        platformData: {
          messageId: grammyCtx.message.message_id,
          chatType: grammyCtx.chat.type,
        },
      };

      try {
        const chatId = grammyCtx.chat.id;
        const correlationId = await ctx.sendMessage(inbound);

        // Store the chatId mapping and flush any responses that arrived
        // before sendMessage returned (race condition with fast agents).
        this.chatIds.set(correlationId, chatId);

        const buffered = this.earlyResponses.get(correlationId);
        if (buffered) {
          this.earlyResponses.delete(correlationId);
          for (const outbound of buffered) {
            void this.sendResponse(bot, chatId, outbound);
          }
        }
      } catch (err) {
        ctx.logger.error(
          `Telegram: failed to process inbound message: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // Handle outbound responses
    ctx.onResponse((outbound: OutboundMessage) => {
      const chatId = this.chatIds.get(outbound.correlationId);
      if (chatId !== undefined) {
        void this.sendResponse(bot, chatId, outbound);
        return;
      }

      // chatId not yet mapped — buffer the response for when it arrives
      let buffer = this.earlyResponses.get(outbound.correlationId);
      if (!buffer) {
        buffer = [];
        this.earlyResponses.set(outbound.correlationId, buffer);
      }
      buffer.push(outbound);
    });

    // Start long polling (non-blocking — runs in background)
    bot.start({
      onStart: () => {
        ctx.logger.info('Telegram bot started polling');
      },
    });

    this.bot = bot;
    this._status = 'running';
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
    }
    this.chatIds.clear();
    this.earlyResponses.clear();
    this.bot = null;
    this.ctx = null;
    this._status = 'stopped';
  }

  isHealthy(): boolean {
    return this._status === 'running' && this.bot !== null;
  }

  private async sendResponse(
    bot: Bot,
    chatId: number,
    outbound: OutboundMessage,
  ): Promise<void> {
    const isDone =
      outbound.data?.type === 'task.done' ||
      outbound.data?.type === 'task.error';

    // Lifecycle signals (task.done, task.error) with no meaningful text — just clean up
    const hasText = outbound.text && outbound.text !== '{}' && outbound.text !== 'undefined';
    if (!hasText) {
      if (isDone) {
        this.chatIds.delete(outbound.correlationId);
        this.ctx?.removeResponseListener(outbound.correlationId);
      }
      return;
    }

    const chunks = splitMessage(outbound.text);

    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch {
        // Markdown parse failure — retry as plain text
        try {
          await bot.api.sendMessage(chatId, chunk);
        } catch (err) {
          this.ctx?.logger.error(
            `Telegram: failed to send message to chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (isDone) {
      this.chatIds.delete(outbound.correlationId);
      this.ctx?.removeResponseListener(outbound.correlationId);
    }
  }
}
