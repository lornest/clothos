// Types
export type {
  CircuitState,
  CircuitBreakerOptions,
  LaneKey,
  WsSession,
  Subscription,
  MessageHandler,
  StreamDefinition,
  GatewayOptions,
  HealthStatus,
} from './types.js';

// Circuit breaker
export { CircuitBreaker } from './circuit-breaker.js';

// Lane queue
export { LaneQueue } from './lane-queue.js';

// Redis client
export { RedisClient } from './redis-client.js';

// NATS client
export { NatsClient } from './nats-client.js';

// Router
export { MessageRouter, parseTarget } from './router.js';
export type { ParsedTarget } from './router.js';

// WebSocket server
export { GatewayWebSocketServer } from './websocket-server.js';
export type { WebSocketServerOptions, WsMessageHandler } from './websocket-server.js';

// Static file server
export { StaticServer } from './static-server.js';

// Gateway server (top-level orchestrator)
export { GatewayServer } from './gateway-server.js';

// Gateway client (WebSocket client for channel adaptors)
export { GatewayClient } from './gateway-client.js';
export type { GatewayClientOptions } from './gateway-client.js';

// JWT utilities
export { signToken, verifyToken } from './jwt.js';
export type { TokenPayload } from './jwt.js';
