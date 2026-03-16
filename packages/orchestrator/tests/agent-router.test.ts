import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Binding } from '@clothos/core';
import type { AgentRegistryEntry, AgentRegistry } from '../src/agent-registry.js';
import { AgentRouter } from '../src/agent-router.js';

function createEntry(agentId: string, status: string = 'READY'): AgentRegistryEntry {
  return {
    agentId,
    getStatus: () => status as any,
    dispatch: async function* () {},
  };
}

function createRegistry(entries: AgentRegistryEntry[]): AgentRegistry {
  const map = new Map(entries.map((e) => [e.agentId, e]));
  return {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    getAll: () => entries,
    getAvailable: () => entries.filter((e) => {
      const s = e.getStatus();
      return s === 'READY' || s === 'RUNNING';
    }),
  };
}

describe('AgentRouter', () => {
  const bindings: Binding[] = [
    { channel: 'default', agentId: 'default-agent' },
    { channel: 'webchat', agentId: 'webchat-agent' },
    { channel: 'webchat', peer: 'alice', agentId: 'alice-agent' },
  ];

  let registry: AgentRegistry;
  let router: AgentRouter;

  beforeEach(() => {
    registry = createRegistry([
      createEntry('default-agent'),
      createEntry('webchat-agent'),
      createEntry('alice-agent'),
    ]);
    router = new AgentRouter({ bindings, registry });
  });

  it('resolves to the best-scoring available agent', () => {
    const result = router.resolve('webchat', 'random-user');
    expect(result?.agentId).toBe('webchat-agent');
  });

  it('resolves peer-specific binding', () => {
    const result = router.resolve('webchat', 'alice');
    expect(result?.agentId).toBe('alice-agent');
  });

  it('falls back to default binding for unknown channels', () => {
    const result = router.resolve('telegram', 'random-user');
    expect(result?.agentId).toBe('default-agent');
  });

  it('skips unavailable agents and falls back', () => {
    registry = createRegistry([
      createEntry('webchat-agent', 'SUSPENDED'),
      createEntry('default-agent'),
    ]);
    router = new AgentRouter({ bindings, registry });

    const result = router.resolve('webchat', 'random-user');
    expect(result?.agentId).toBe('default-agent');
  });

  it('returns undefined when no agent is available', () => {
    registry = createRegistry([
      createEntry('webchat-agent', 'TERMINATED'),
      createEntry('default-agent', 'ERROR'),
      createEntry('alice-agent', 'SUSPENDED'),
    ]);
    router = new AgentRouter({ bindings, registry });

    const result = router.resolve('webchat', 'random-user');
    expect(result).toBeUndefined();
  });

  it('returns undefined when agent not in registry', () => {
    registry = createRegistry([]);
    router = new AgentRouter({ bindings, registry });

    const result = router.resolve('webchat', 'user');
    expect(result).toBeUndefined();
  });

  describe('circuit breaking', () => {
    it('starts with healthy agents', () => {
      expect(router.isAgentHealthy('webchat-agent')).toBe(true);
    });

    it('stays healthy below failure threshold', () => {
      for (let i = 0; i < 4; i++) {
        router.recordFailure('webchat-agent');
      }
      expect(router.isAgentHealthy('webchat-agent')).toBe(true);
    });

    it('trips circuit after threshold failures', () => {
      for (let i = 0; i < 5; i++) {
        router.recordFailure('webchat-agent');
      }
      expect(router.isAgentHealthy('webchat-agent')).toBe(false);
    });

    it('skips unhealthy agent in resolution', () => {
      for (let i = 0; i < 5; i++) {
        router.recordFailure('webchat-agent');
      }

      const result = router.resolve('webchat', 'random-user');
      // Falls back to default-agent since webchat-agent circuit is open
      expect(result?.agentId).toBe('default-agent');
    });

    it('resets circuit on success', () => {
      for (let i = 0; i < 5; i++) {
        router.recordFailure('webchat-agent');
      }
      expect(router.isAgentHealthy('webchat-agent')).toBe(false);

      router.recordSuccess('webchat-agent');
      expect(router.isAgentHealthy('webchat-agent')).toBe(true);
    });

    it('transitions to half-open after cooldown', () => {
      router = new AgentRouter({
        bindings,
        registry,
        cooldownMs: 100,
      });

      for (let i = 0; i < 5; i++) {
        router.recordFailure('webchat-agent');
      }
      expect(router.isAgentHealthy('webchat-agent')).toBe(false);

      // Simulate time passing by manipulating the circuit directly
      const info = router.getHealthInfo('webchat-agent');
      expect(info.circuitState).toBe('open');

      // Use a real short cooldown and wait
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(router.isAgentHealthy('webchat-agent')).toBe(true);
          const updatedInfo = router.getHealthInfo('webchat-agent');
          expect(updatedInfo.circuitState).toBe('half-open');
          resolve();
        }, 150);
      });
    });

    it('provides health info for unknown agents', () => {
      const info = router.getHealthInfo('unknown-agent');
      expect(info.failureCount).toBe(0);
      expect(info.circuitState).toBe('closed');
    });

    it('prunes old failures outside the window', () => {
      router = new AgentRouter({
        bindings,
        registry,
        failureWindowMs: 100,
        failureThreshold: 3,
      });

      // Record 2 failures
      router.recordFailure('webchat-agent');
      router.recordFailure('webchat-agent');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Old failures are outside window, new one shouldn't trip circuit
          router.recordFailure('webchat-agent');
          expect(router.isAgentHealthy('webchat-agent')).toBe(true);
          resolve();
        }, 150);
      });
    });
  });
});
