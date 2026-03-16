import type { AgentMessage } from '@clothos/core';

/** Circuit breaker states. */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Configuration for a circuit breaker instance. */
export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit. Default: 5 */
  failureThreshold: number;
  /** Time window in ms to count failures. Default: 60_000 */
  failureWindowMs: number;
  /** Cooldown in ms before transitioning OPEN → HALF_OPEN. Default: 30_000 */
  cooldownMs: number;
  /** Called when the circuit state changes (e.g. to OPEN or CLOSED). */
  onStateChange?: (newState: CircuitState) => void;
}

/** Key identifying a message ordering lane: `{agentId}:{channelId}:{userId}`. */
export type LaneKey = string;

/** A connected WebSocket session. */
export interface WsSession {
  id: string;
  userId: string;
  connectedAt: string;
}

/** A NATS subscription handle. */
export interface Subscription {
  subject: string;
  queueGroup?: string;
  streamName: string;
  consumerName: string;
  unsubscribe(): void;
  pause(): void;
  resume(): Promise<void>;
  /** Delete the durable consumer and purge stream messages for this subject. */
  destroy(): Promise<void>;
}

/** Handler invoked when a message arrives. */
export type MessageHandler = (msg: AgentMessage) => Promise<void>;

/** Definition of a JetStream stream to be created on connect. */
export interface StreamDefinition {
  name: string;
  subjects: string[];
  retention: 'workqueue' | 'interest' | 'limits';
  maxDeliver: number;
  ackWaitNs: number;
  maxAge?: number;
}

/** Options for constructing the gateway server. */
export interface GatewayOptions {
  nats: {
    url: string;
    credentials?: string;
  };
  redis: {
    url: string;
  };
  websocket: {
    port: number;
    host?: string;
  };
  maxConcurrentAgents: number;
}

/** Health check status. */
export interface HealthStatus {
  status: 'ok' | 'degraded';
  nats: boolean;
  redis: boolean;
  uptime: number;
}
