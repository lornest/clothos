import type { AgentMessage } from '@clothos/core';
import { generateId, now } from '@clothos/core';
import type { GatewayWebSocketServer } from '@clothos/gateway';

/**
 * Routes agent responses back to the originating WebSocket client.
 *
 * Tracks which WS session initiated each request (via correlationId)
 * and forwards agent responses to the correct client.
 */
export class ResponseRouter {
  /** Maps correlationId → WS session ID */
  private readonly pending = new Map<string, string>();

  constructor(private readonly ws: GatewayWebSocketServer) {}

  /**
   * Register a pending request so we know where to route the response.
   * Called when a WS message arrives and is published to NATS.
   */
  trackRequest(correlationId: string, wsSessionId: string): void {
    this.pending.set(correlationId, wsSessionId);
  }

  /**
   * Route an agent response back to the originating WS client.
   * Returns true if the response was delivered, false if the session
   * was not found or disconnected.
   */
  routeResponse(correlationId: string, response: AgentMessage): boolean {
    const wsSessionId = this.pending.get(correlationId);
    if (!wsSessionId) return false;

    return this.ws.send(wsSessionId, response);
  }

  /**
   * Remove a tracked request after the final response has been sent.
   */
  completeRequest(correlationId: string): void {
    this.pending.delete(correlationId);
  }

  /**
   * Build a response AgentMessage from agent events.
   */
  static buildResponseMessage(
    original: AgentMessage,
    agentId: string,
    text: string,
    toolResults?: Array<{ name: string; result: unknown }>,
    sessionId?: string,
  ): AgentMessage {
    return {
      id: generateId(),
      specversion: '1.0',
      type: 'task.response',
      source: `agent://${agentId}`,
      target: original.source,
      time: now(),
      datacontenttype: 'application/json',
      data: {
        text,
        toolResults,
        sessionId,
      },
      correlationId: original.correlationId ?? original.id,
      causationId: original.id,
    };
  }

  /** Remove a tracked request (e.g. on timeout or cancellation). */
  untrack(correlationId: string): void {
    this.pending.delete(correlationId);
  }

  /** Number of pending requests. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
