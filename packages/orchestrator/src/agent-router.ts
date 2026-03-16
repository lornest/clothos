import type { AgentHealthInfo, Binding, ResolvedBinding } from '@clothos/core';
import type { AgentRegistry } from './agent-registry.js';

/** Options for the AgentRouter. */
export interface AgentRouterOptions {
  bindings: Binding[];
  registry: AgentRegistry;
  /** Number of failures in the window to trip the circuit. Default: 5. */
  failureThreshold?: number;
  /** Window in ms within which failures are counted. Default: 60000. */
  failureWindowMs?: number;
  /** Cooldown in ms before moving from open to half-open. Default: 30000. */
  cooldownMs?: number;
}

interface CircuitState {
  failures: number[];
  state: 'closed' | 'open' | 'half-open';
  openedAt: number;
}

/**
 * Wraps static binding resolution with runtime availability checks
 * and per-agent circuit breaking.
 */
export class AgentRouter {
  private readonly bindings: Binding[];
  private readonly registry: AgentRegistry;
  private readonly circuits = new Map<string, CircuitState>();
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly cooldownMs: number;

  constructor(options: AgentRouterOptions) {
    this.bindings = options.bindings;
    this.registry = options.registry;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  /**
   * Resolve the best available agent for a channel message.
   * Scores bindings statically, then checks availability and circuit health.
   * Falls back to alternate bindings if the top candidate is unavailable.
   */
  resolve(
    channelType: string,
    senderId: string,
    conversationId?: string,
  ): ResolvedBinding | undefined {
    const candidates = this.scoreBindings(channelType, senderId, conversationId);

    for (const { binding, score: _score } of candidates) {
      const entry = this.registry.get(binding.agentId);
      if (!entry) continue;

      const status = entry.getStatus();
      if (status !== 'READY' && status !== 'RUNNING') continue;

      if (!this.isAgentHealthy(binding.agentId)) continue;

      return { agentId: binding.agentId, binding };
    }

    return undefined;
  }

  /** Record a successful dispatch to an agent. Resets circuit to closed. */
  recordSuccess(agentId: string): void {
    const circuit = this.circuits.get(agentId);
    if (circuit) {
      circuit.failures = [];
      circuit.state = 'closed';
      circuit.openedAt = 0;
    }
  }

  /** Record a failed dispatch. May trip the circuit breaker. */
  recordFailure(agentId: string): void {
    let circuit = this.circuits.get(agentId);
    if (!circuit) {
      circuit = { failures: [], state: 'closed', openedAt: 0 };
      this.circuits.set(agentId, circuit);
    }

    const nowMs = Date.now();
    circuit.failures.push(nowMs);

    // Prune failures outside the window
    const cutoff = nowMs - this.failureWindowMs;
    circuit.failures = circuit.failures.filter((t) => t > cutoff);

    if (circuit.failures.length >= this.failureThreshold) {
      circuit.state = 'open';
      circuit.openedAt = nowMs;
    }
  }

  /** Check if an agent's circuit is healthy (closed or half-open after cooldown). */
  isAgentHealthy(agentId: string): boolean {
    const circuit = this.circuits.get(agentId);
    if (!circuit) return true;

    if (circuit.state === 'closed') return true;

    if (circuit.state === 'open') {
      const elapsed = Date.now() - circuit.openedAt;
      if (elapsed >= this.cooldownMs) {
        circuit.state = 'half-open';
        return true;
      }
      return false;
    }

    // half-open: allow one request through
    return true;
  }

  /** Get health info for an agent. */
  getHealthInfo(agentId: string): AgentHealthInfo {
    const circuit = this.circuits.get(agentId);
    if (!circuit) {
      return {
        agentId,
        failureCount: 0,
        lastFailureAt: 0,
        circuitState: 'closed',
      };
    }

    return {
      agentId,
      failureCount: circuit.failures.length,
      lastFailureAt: circuit.failures.length > 0
        ? circuit.failures[circuit.failures.length - 1]!
        : 0,
      circuitState: circuit.state,
    };
  }

  /**
   * Score all bindings for a given channel/sender/conversation,
   * sorted by score descending.
   */
  private scoreBindings(
    channelType: string,
    senderId: string,
    conversationId?: string,
  ): Array<{ binding: Binding; score: number }> {
    const scored: Array<{ binding: Binding; score: number }> = [];

    for (const binding of this.bindings) {
      let score = binding.priority ?? 0;
      let matches = true;

      if (binding.peer !== undefined) {
        if (binding.peer === senderId) {
          score += 4;
        } else {
          matches = false;
        }
      }

      if (binding.team !== undefined) {
        if (binding.team === conversationId) {
          score += 2;
        } else {
          matches = false;
        }
      }

      if (binding.account !== undefined) {
        score += 2;
      }

      if (binding.channel !== undefined) {
        if (binding.channel === channelType || binding.channel === 'default') {
          score += binding.channel === channelType ? 1 : 0;
        } else {
          matches = false;
        }
      }

      if (matches) {
        scored.push({ binding, score });
      }
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
