import { join } from 'node:path';
import type { Disposable, ToolDefinition, ToolHandler } from '@clothos/core';
import type { HookRegistry } from '../hook-registry.js';
import type {
  PlanModeConfig,
  PlanModeState,
  PlanModeControllerOptions,
  ExitPlanModeResult,
} from './plan-mode-types.js';
import { createPlanModeToolCallHook } from './plan-mode-hooks.js';
import { createPlanModePromptHandler, createPlanContextHandler } from './plan-mode-prompt.js';
import {
  exitPlanModeToolDefinition,
  createExitPlanModeHandler,
  writePlanToolDefinition,
  createWritePlanHandler,
  editPlanToolDefinition,
  createEditPlanHandler,
} from './plan-mode-tools.js';

/** Return type of PlanModeController.enter(). */
export interface PlanModeTools {
  exitToolDefinition: ToolDefinition;
  exitToolHandler: ToolHandler;
  writePlanDefinition: ToolDefinition;
  writePlanHandler: ToolHandler;
  editPlanDefinition: ToolDefinition;
  editPlanHandler: ToolHandler;
}

/**
 * Orchestrates plan mode lifecycle: entering, enforcing constraints via hooks,
 * and exiting with the completed plan.
 *
 * Self-contained — does not modify AgentManager or agentLoop.
 * Registers hooks on an existing HookRegistry and disposes them on exit.
 */
export class PlanModeController {
  private readonly agentWorkspacePath: string;
  private readonly fs: PlanModeControllerOptions['fs'];

  private active = false;
  private planFilePath: string | null = null;
  private slug: string | null = null;
  private goal: string | null = null;
  private disposables: Disposable[] = [];

  constructor(options: PlanModeControllerOptions) {
    this.agentWorkspacePath = options.agentWorkspacePath;
    this.fs = options.fs;
  }

  /**
   * Enter plan mode: compute plan file path, create the plans directory,
   * register hooks, and return the plan-mode tool definitions + handlers.
   */
  async enter(
    hooks: HookRegistry,
    config: PlanModeConfig,
  ): Promise<PlanModeTools> {
    if (this.active) {
      throw new Error('Plan mode is already active');
    }

    const plansDir = config.plansDir ?? 'plans';
    const plansDirPath = join(this.agentWorkspacePath, plansDir);
    this.planFilePath = join(plansDirPath, `${config.slug}.md`);
    this.slug = config.slug;
    this.goal = config.goal ?? null;
    this.active = true;

    // Ensure plans directory exists
    await this.fs.mkdir(plansDirPath, { recursive: true });

    // Create plan file with header if it doesn't exist
    if (!(await this.fs.exists(this.planFilePath))) {
      const header = `# Plan: ${config.slug}\n\n`;
      await this.fs.writeFile(this.planFilePath, header);
    }

    // Register tool_call hook (priority 10 — runs before most other hooks)
    const toolCallDisposable = hooks.register(
      'tool_call',
      createPlanModeToolCallHook(),
      10,
    );
    this.disposables.push(toolCallDisposable);

    // Register context_assemble hook (priority 5 — before other prompt handlers at 10+)
    const promptDisposable = hooks.register(
      'context_assemble',
      createPlanModePromptHandler(this.goal ?? undefined),
      5,
    );
    this.disposables.push(promptDisposable);

    return {
      exitToolDefinition: exitPlanModeToolDefinition,
      exitToolHandler: createExitPlanModeHandler(this),
      writePlanDefinition: writePlanToolDefinition,
      writePlanHandler: createWritePlanHandler(this.planFilePath, this.fs),
      editPlanDefinition: editPlanToolDefinition,
      editPlanHandler: createEditPlanHandler(this.planFilePath, this.fs),
    };
  }

  /**
   * Exit plan mode: read the plan file, dispose all hooks, and return the result.
   * Optionally registers a post-plan context handler if a hooks registry is provided.
   */
  async exit(hooks?: HookRegistry): Promise<ExitPlanModeResult> {
    if (!this.active || !this.planFilePath) {
      throw new Error('Plan mode is not active');
    }

    const planContent = await this.fs.readFile(this.planFilePath);
    const planFilePath = this.planFilePath;

    // Dispose all registered hooks
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];

    // Reset state
    this.active = false;

    // Optionally register post-plan context injection
    if (hooks) {
      hooks.register(
        'context_assemble',
        createPlanContextHandler(planContent),
        55, // After bootstrap at 50
      );
    }

    return {
      exited: true,
      planFilePath,
      planContent,
    };
  }

  /** Returns the current plan mode state for introspection. */
  getState(): PlanModeState {
    return {
      active: this.active,
      planFilePath: this.planFilePath,
      slug: this.slug,
      goal: this.goal,
    };
  }
}
