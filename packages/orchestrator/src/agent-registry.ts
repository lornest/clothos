import type { AgentEvent, AgentStatus } from '@clothos/core';

/** A single entry in the agent registry. */
export interface AgentRegistryEntry {
  agentId: string;
  getStatus(): AgentStatus;
  dispatch(message: string, sessionId?: string): AsyncGenerator<AgentEvent>;
  /** Enter plan mode on this agent (if supported). */
  enterPlanMode?(config: { slug: string; goal?: string }): Promise<void>;
}

/** Read-only lookup of wired agents. */
export interface AgentRegistry {
  get(agentId: string): AgentRegistryEntry | undefined;
  has(agentId: string): boolean;
  getAll(): AgentRegistryEntry[];
  getAvailable(): AgentRegistryEntry[];
}
