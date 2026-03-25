import type { HookHandler } from '@clothos/core';
import type { ToolCallHookResult } from '../types.js';

/** Tools that are always allowed in plan mode. */
const ALWAYS_ALLOWED = new Set([
  'read_file',
  'grep_search',
  'glob_find',
  'list_directory',
  'git_status',
  'git_diff',
  'exit_plan_mode',
  'write_plan',
  'edit_plan',
]);

/** Safe base commands for bash in plan mode. */
const SAFE_BASH_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'echo', 'head', 'tail', 'wc', 'date',
  'whoami', 'env', 'which', 'true', 'false', 'test', 'printf',
  'grep', 'rg', 'find', 'tree', 'file', 'stat', 'diff',
]);

/** Git subcommands that are read-only. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'tag', 'describe',
  'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'shortlog',
  'blame', 'reflog',
]);

/** Redirect operators that indicate writing. */
const REDIRECT_PATTERN = /(?:>>?|>\||&>)\s|(?:\|\s*tee\b)/;

/**
 * Extract the base command from a shell command string.
 * Strips env-var assignments and path prefixes.
 */
function extractBaseCommand(command: string): string {
  let trimmed = command.trim();
  // Strip leading env-var assignments
  while (/^\w+=\S*\s/.test(trimmed)) {
    trimmed = trimmed.replace(/^\w+=\S*\s+/, '');
  }
  const firstWord = trimmed.split(/\s+/)[0] ?? '';
  const idx = firstWord.lastIndexOf('/');
  return idx === -1 ? firstWord : firstWord.slice(idx + 1);
}

/**
 * Check if a bash command is safe for plan mode (read-only).
 * Returns an error reason string if unsafe, or null if safe.
 */
function classifyBashForPlanMode(command: string): string | null {
  // Block redirect operators
  if (REDIRECT_PATTERN.test(command)) {
    return 'Plan mode: bash commands with redirects (>, >>, | tee) are not allowed during planning';
  }

  // Split on chain operators and check each segment
  const segments = command.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const baseCmd = extractBaseCommand(trimmed);
    if (!baseCmd) continue;

    // Special handling for git: only allow read-only subcommands
    if (baseCmd === 'git') {
      const args = trimmed.replace(/^\S+\s*/, ''); // strip 'git'
      const subcommand = args.split(/\s+/)[0] ?? '';
      if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
        return `Plan mode: 'git ${subcommand}' is not allowed during planning — only read-only git commands are permitted`;
      }
      continue;
    }

    if (!SAFE_BASH_COMMANDS.has(baseCmd)) {
      return `Plan mode: '${baseCmd}' is not allowed during planning — only read-only commands are permitted`;
    }
  }

  return null;
}

/**
 * Creates a tool_call hook that enforces plan mode constraints.
 *
 * - Allows read-only tools and plan-specific tools (write_plan, edit_plan, exit_plan_mode)
 * - Blocks all general-purpose write tools (write_file, edit_file, etc.)
 * - Restricts bash to safe read-only commands
 */
export function createPlanModeToolCallHook(): HookHandler {
  return (context: unknown): unknown => {
    const ctx = context as { name: string; arguments?: string | Record<string, unknown> };
    const toolName = ctx.name;

    // Always-allowed tools pass through
    if (ALWAYS_ALLOWED.has(toolName)) {
      return context;
    }

    // Bash — allow only safe read-only commands
    if (toolName === 'bash') {
      // Parse arguments: may be a JSON string (from ToolCall) or already an object
      let args: Record<string, unknown> | undefined;
      if (typeof ctx.arguments === 'string') {
        try {
          args = JSON.parse(ctx.arguments) as Record<string, unknown>;
        } catch {
          args = undefined;
        }
      } else {
        args = ctx.arguments;
      }

      const command = args?.command;
      if (typeof command !== 'string') {
        return {
          blocked: true,
          reason: 'Plan mode: bash requires a command argument',
        } satisfies ToolCallHookResult;
      }

      const unsafeReason = classifyBashForPlanMode(command);
      if (unsafeReason) {
        return { blocked: true, reason: unsafeReason } satisfies ToolCallHookResult;
      }

      return context;
    }

    // Everything else is blocked
    return {
      blocked: true,
      reason: `Plan mode: '${toolName}' is not available during planning. Use read-only tools to explore the codebase, then use write_plan to write your plan.`,
    } satisfies ToolCallHookResult;
  };
}
