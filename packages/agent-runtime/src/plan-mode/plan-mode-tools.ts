import { dirname } from 'node:path';
import type { ToolDefinition, ToolHandler } from '@clothos/core';
import type { PlanModeController } from './plan-mode-controller.js';
import type { PlanModeConfig, PlanModeState } from './plan-mode-types.js';
import type { FileSystem } from '../types.js';

// ── enter_plan_mode ─────────────────────────────────────────

/** Tool definition for enter_plan_mode — always available, lets the agent self-initiate planning. */
export const enterPlanModeToolDefinition: ToolDefinition = {
  name: 'enter_plan_mode',
  description:
    'Enter plan mode to create an implementation plan before executing a complex task. ' +
    'Use this when a task involves multiple files, architectural decisions, or unfamiliar code. ' +
    'Only works when plan mode is not already active.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Short identifier for the plan file (e.g. "implement-auth", "refactor-api").',
      },
      goal: {
        type: 'string',
        description: 'The goal or task to plan.',
      },
    },
    required: ['slug'],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

/**
 * Creates a tool handler for enter_plan_mode.
 * Delegates to the provided enter function and state getter.
 */
export function createEnterPlanModeHandler(
  enterFn: (config: PlanModeConfig) => Promise<void>,
  getState: () => PlanModeState,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    if (getState().active) {
      return { error: 'Plan mode is already active' };
    }

    const slug = args.slug;
    if (typeof slug !== 'string' || slug.trim() === '') {
      return { error: 'slug must be a non-empty string' };
    }

    const goal = typeof args.goal === 'string' ? args.goal : undefined;

    await enterFn({ slug: slug.trim(), goal });

    return { entered: true, slug: slug.trim(), planFilePath: getState().planFilePath };
  };
}

// ── exit_plan_mode ──────────────────────────────────────────

/** Tool definition for exit_plan_mode. */
export const exitPlanModeToolDefinition: ToolDefinition = {
  name: 'exit_plan_mode',
  description:
    'Exit plan mode. Call this when your implementation plan is complete and you are ready to begin execution.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'A 1-3 sentence summary of the plan.',
      },
    },
    required: ['summary'],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

/**
 * Creates a tool handler for exit_plan_mode that delegates to the controller.
 */
export function createExitPlanModeHandler(
  controller: PlanModeController,
): ToolHandler {
  return async (_args: Record<string, unknown>) => {
    const result = await controller.exit();
    return result;
  };
}

// ── write_plan ──────────────────────────────────────────────

/** Tool definition for write_plan. */
export const writePlanToolDefinition: ToolDefinition = {
  name: 'write_plan',
  description:
    'Write content to the plan file, replacing its current contents. Use this to create or overwrite your implementation plan.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The full content to write to the plan file.',
      },
    },
    required: ['content'],
  },
  annotations: {
    readOnly: false,
    riskLevel: 'green',
  },
};

/**
 * Creates a tool handler for write_plan.
 * The plan file path is baked into the closure — no user-supplied path.
 */
export function createWritePlanHandler(
  planFilePath: string,
  fs: FileSystem,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const content = args.content;
    if (typeof content !== 'string') {
      return { error: 'content must be a string' };
    }

    try {
      await fs.mkdir(dirname(planFilePath), { recursive: true });
      await fs.writeFile(planFilePath, content);
    } catch (err) {
      return { error: `Failed to write plan file: ${(err as Error).message}` };
    }

    return { written: true, path: planFilePath };
  };
}

// ── edit_plan ───────────────────────────────────────────────

/** Tool definition for edit_plan. */
export const editPlanToolDefinition: ToolDefinition = {
  name: 'edit_plan',
  description:
    'Make a targeted edit to the plan file by replacing a specific string. Use this for small updates to an existing plan.',
  inputSchema: {
    type: 'object',
    properties: {
      old_string: {
        type: 'string',
        description: 'The exact string to find in the plan file.',
      },
      new_string: {
        type: 'string',
        description: 'The string to replace it with.',
      },
      replace_all: {
        type: 'boolean',
        description: 'If true, replace all occurrences. Default: false (requires unique match).',
      },
    },
    required: ['old_string', 'new_string'],
  },
  annotations: {
    readOnly: false,
    riskLevel: 'green',
  },
};

/**
 * Creates a tool handler for edit_plan.
 * Mirrors `createEditFileHandler` semantics but targets a single fixed file.
 */
export function createEditPlanHandler(
  planFilePath: string,
  fs: FileSystem,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const oldString = args.old_string;
    if (typeof oldString !== 'string') {
      return { error: 'old_string must be a string' };
    }
    const newString = args.new_string;
    if (typeof newString !== 'string') {
      return { error: 'new_string must be a string' };
    }

    let content: string;
    try {
      content = await fs.readFile(planFilePath);
    } catch (err) {
      return { error: `Failed to read plan file: ${(err as Error).message}` };
    }

    const replaceAll = args.replace_all === true;

    // Count occurrences
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldString, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + oldString.length;
    }

    if (count === 0) {
      if (content.toLowerCase().includes(oldString.toLowerCase())) {
        return { error: 'No exact match found. A case-insensitive match exists — check your casing.' };
      }
      return { error: 'No match found' };
    }

    let updated: string;
    if (replaceAll) {
      updated = content.split(oldString).join(newString);
    } else {
      if (count > 1) {
        return {
          error: `Multiple matches found (${count} occurrences). Provide more context to make the match unique, or set replace_all to true.`,
        };
      }
      updated = content.replace(oldString, newString);
    }

    try {
      await fs.writeFile(planFilePath, updated);
    } catch (err) {
      return { error: `Failed to write plan file: ${(err as Error).message}` };
    }

    return replaceAll
      ? { edited: true, replacements: count, path: planFilePath }
      : { edited: true, path: planFilePath };
  };
}
