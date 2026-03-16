import type {
  Binding,
  ChannelAdaptor,
  ChannelAdaptorConfig,
  ChannelAdaptorContext,
  ChannelsConfig,
  GatewayTransport,
  InboundMessage,
  Logger,
  OutboundMessage,
} from '@clothos/core';
import { resolveAgent } from './binding-resolver.js';
import { buildAgentMessage, buildOutboundMessage } from './message-builder.js';

export interface ChannelManagerOptions {
  gateway: GatewayTransport;
  bindings: Binding[];
  channelsConfig: ChannelsConfig;
  logger: Logger;
}

export class ChannelManager {
  private readonly adaptors = new Map<string, ChannelAdaptor>();
  private readonly gateway: GatewayTransport;
  private readonly bindings: Binding[];
  private readonly channelsConfig: ChannelsConfig;
  private readonly logger: Logger;

  constructor(options: ChannelManagerOptions) {
    this.gateway = options.gateway;
    this.bindings = options.bindings;
    this.channelsConfig = options.channelsConfig;
    this.logger = options.logger;
  }

  register(adaptor: ChannelAdaptor): void {
    const { channelType } = adaptor.info;
    if (this.adaptors.has(channelType)) {
      throw new Error(`Adaptor already registered for channel type "${channelType}"`);
    }
    this.adaptors.set(channelType, adaptor);
  }

  async startAll(): Promise<void> {
    for (const [channelType, adaptor] of this.adaptors) {
      const adaptorConfig = this.channelsConfig.adaptors[channelType];
      if (!adaptorConfig?.enabled) {
        this.logger.info(`Channel adaptor "${channelType}" is disabled, skipping`);
        continue;
      }

      try {
        const ctx = this.createContext(channelType, adaptorConfig);
        await adaptor.start(ctx);
        this.logger.info(`Channel adaptor "${channelType}" started`);
      } catch (err) {
        this.logger.error(
          `Failed to start channel adaptor "${channelType}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [channelType, adaptor] of this.adaptors) {
      if (adaptor.status === 'stopped') continue;
      try {
        await adaptor.stop();
        this.logger.info(`Channel adaptor "${channelType}" stopped`);
      } catch (err) {
        this.logger.error(
          `Failed to stop channel adaptor "${channelType}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  getStatuses(): Array<{ type: string; status: string; healthy: boolean }> {
    const statuses: Array<{ type: string; status: string; healthy: boolean }> = [];
    for (const [type, adaptor] of this.adaptors) {
      statuses.push({
        type,
        status: adaptor.status,
        healthy: adaptor.isHealthy(),
      });
    }
    return statuses;
  }

  private createContext(
    channelType: string,
    adaptorConfig: ChannelAdaptorConfig,
  ): ChannelAdaptorContext {
    const responseHandlers: Array<(msg: OutboundMessage) => void> = [];

    const ctx: ChannelAdaptorContext = {
      sendMessage: async (inbound: InboundMessage): Promise<string> => {
        // Enforce allowlist if configured
        if (adaptorConfig.allowlist && adaptorConfig.allowlist.length > 0) {
          if (!adaptorConfig.allowlist.includes(inbound.senderId)) {
            throw new Error(
              `Sender "${inbound.senderId}" is not in the allowlist for channel "${channelType}"`,
            );
          }
        }

        const resolved = resolveAgent(
          this.bindings,
          channelType,
          inbound.senderId,
          inbound.conversationId,
        );

        const agentMsg = buildAgentMessage(inbound, channelType, resolved.agentId);

        // Propagate binding overrides via metadata
        if (resolved.binding.overrides) {
          agentMsg.metadata = {
            ...agentMsg.metadata,
            'x-binding-overrides': JSON.stringify(resolved.binding.overrides),
          };
        }
        const correlationId = agentMsg.correlationId!;

        // Register a response listener before injecting so we don't miss it.
        // Don't auto-remove: the agent may send multiple responses per turn
        // (streaming chunks, intermediate results, final answer). Cleanup
        // happens when the browser session disconnects.
        this.gateway.onResponse(correlationId, (response) => {
          const outbound = buildOutboundMessage(response);
          for (const handler of responseHandlers) {
            handler(outbound);
          }
        });

        await this.gateway.send(agentMsg);
        return correlationId;
      },

      onResponse: (handler: (msg: OutboundMessage) => void): void => {
        responseHandlers.push(handler);
      },

      removeResponseListener: (correlationId: string): void => {
        this.gateway.removeResponseHandler(correlationId);
      },

      resolveAgent: (ct: string, senderId: string, conversationId?: string): string => {
        return resolveAgent(this.bindings, ct, senderId, conversationId).agentId;
      },

      logger: this.logger,
      config: adaptorConfig,
    };

    return ctx;
  }
}
