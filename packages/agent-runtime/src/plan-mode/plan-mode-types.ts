import type { FileSystem } from '../types.js';

export interface PlanModeConfig {
  slug: string;              // "implement-auth" → plans/implement-auth.md
  plansDir?: string;         // Default: 'plans'
  goal?: string;             // User's goal, injected into the plan mode prompt
}

export interface PlanModeState {
  active: boolean;
  planFilePath: string | null;
  slug: string | null;
  goal: string | null;
}

export interface ExitPlanModeResult {
  exited: boolean;
  planFilePath: string;
  planContent: string;
}

export interface PlanModeControllerOptions {
  agentWorkspacePath: string;    // e.g. {basePath}/agents/{agentId}
  fs: FileSystem;                // Injected filesystem
}
