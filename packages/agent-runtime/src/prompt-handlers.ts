import type { HookHandler, ToolDefinition, SkillEntry } from '@clothos/core';
import type { AssembledContext } from './types.js';
import type { PromptMode, RuntimeInfo } from './prompt-types.js';
import type { BootstrapLoader } from './bootstrap-loader.js';
import {
  formatToolsSummary,
  formatSkillsSummary,
  formatBootstrapFiles,
} from './prompt-section-builder.js';
import { formatRuntimeInfo } from './runtime-info.js';

/** Clones the assembled context and appends a section to the system prompt. */
export function appendToSystemPrompt(
  assembled: AssembledContext,
  sectionText: string,
): AssembledContext {
  if (!sectionText) return assembled;

  const messages = assembled.messages.map((m, i) => {
    if (i === 0 && m.role === 'system') {
      return { ...m, content: m.content + '\n\n' + sectionText };
    }
    return m;
  });

  return { ...assembled, messages };
}

/** Creates a handler that injects `<available-tools>` into the system prompt. */
export function createToolsHandler(
  getTools: () => ToolDefinition[],
  mode: PromptMode,
): HookHandler {
  return (context: unknown): unknown => {
    if (mode === 'none') return context;

    const assembled = context as AssembledContext;
    const tools = getTools();
    const text = formatToolsSummary(tools);
    return appendToSystemPrompt(assembled, text);
  };
}

/** Creates a handler that injects `<available-skills>` into the system prompt. */
export function createSkillsHandler(
  skills: SkillEntry[],
  mode: PromptMode,
): HookHandler {
  return (context: unknown): unknown => {
    if (mode === 'none' || mode === 'minimal') return context;

    const assembled = context as AssembledContext;
    const text = formatSkillsSummary(skills);
    return appendToSystemPrompt(assembled, text);
  };
}

/** Creates a handler that injects `<runtime-info>` into the system prompt. */
export function createRuntimeInfoHandler(
  info: RuntimeInfo,
  mode: PromptMode,
): HookHandler {
  // Pre-format once since runtime info is session-stable
  const formatted = formatRuntimeInfo(info);

  return (context: unknown): unknown => {
    if (mode === 'none') return context;

    const assembled = context as AssembledContext;
    return appendToSystemPrompt(assembled, formatted);
  };
}

/** Creates a handler that injects bootstrap file sections into the system prompt. */
export function createBootstrapHandler(
  loader: BootstrapLoader,
  mode: PromptMode,
): HookHandler {
  return async (context: unknown): Promise<unknown> => {
    if (mode === 'none') return context;

    const assembled = context as AssembledContext;
    const files = await loader.loadFiles();

    // In minimal mode, only load SOUL.md and IDENTITY.md
    const filtered =
      mode === 'minimal'
        ? files.filter((f) => f.name === 'SOUL.md' || f.name === 'IDENTITY.md')
        : files;

    const text = formatBootstrapFiles(filtered);
    return appendToSystemPrompt(assembled, text);
  };
}
