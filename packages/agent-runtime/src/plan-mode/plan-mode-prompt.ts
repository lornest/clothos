import type { HookHandler } from '@clothos/core';
import type { AssembledContext } from '../types.js';
import { appendToSystemPrompt } from '../prompt-handlers.js';

/**
 * Creates a context_assemble hook that injects plan mode instructions
 * into the system prompt each turn.
 */
export function createPlanModePromptHandler(
  goal?: string,
): HookHandler {
  const goalSection = goal
    ? `\n## Goal\n${goal}\n`
    : '';

  const promptText = `<plan-mode>
You are in PLAN MODE. Explore the codebase and write a detailed implementation plan.

## Rules
- You can READ files, search code, and run read-only bash commands
- You CANNOT modify any project files — all write tools are blocked
- Use the \`write_plan\` tool to write your plan (overwrites the plan file)
- Use the \`edit_plan\` tool to make targeted edits to the plan file
- When your plan is complete, call \`exit_plan_mode\`

## Workflow
1. Explore: Read relevant files, search for patterns, understand the architecture
2. Design: Think through the approach, consider trade-offs, identify dependencies
3. Write: Document your plan using the write_plan tool
4. Exit: Call exit_plan_mode when ready
${goalSection}
</plan-mode>`;

  return (context: unknown): unknown => {
    const assembled = context as AssembledContext;
    return appendToSystemPrompt(assembled, promptText);
  };
}

/**
 * Creates a context_assemble hook that injects the completed plan
 * into context during execution (post-plan mode).
 */
export function createPlanContextHandler(planContent: string): HookHandler {
  const section = `<implementation-plan>\n${planContent}\n</implementation-plan>`;

  return (context: unknown): unknown => {
    const assembled = context as AssembledContext;
    return appendToSystemPrompt(assembled, section);
  };
}
