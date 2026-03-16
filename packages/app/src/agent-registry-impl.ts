import type { AgentRegistry, AgentRegistryEntry } from '@clothos/orchestrator';
import type { WiredAgent } from './agent-wiring.js';

/**
 * Build a read-only AgentRegistry backed by the wired agents map.
 * The registry delegates to AgentManager for status and dispatch.
 */
export function buildAgentRegistry(
  agents: Map<string, WiredAgent>,
): AgentRegistry {
  const entries = new Map<string, AgentRegistryEntry>();

  for (const [id, wired] of agents) {
    entries.set(id, {
      agentId: id,
      getStatus: () => wired.manager.getStatus(),
      dispatch: (message: string, sessionId?: string) =>
        wired.manager.dispatch(message, sessionId),
    });
  }

  return {
    get(agentId: string) {
      return entries.get(agentId);
    },
    has(agentId: string) {
      return entries.has(agentId);
    },
    getAll() {
      return Array.from(entries.values());
    },
    getAvailable() {
      return Array.from(entries.values()).filter((e) => {
        const status = e.getStatus();
        return status === 'READY' || status === 'RUNNING';
      });
    },
  };
}
