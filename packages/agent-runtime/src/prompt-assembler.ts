import type { Disposable, ToolDefinition, SkillEntry } from '@clothos/core';
import type { HookRegistry } from './hook-registry.js';
import type { FileSystem } from './types.js';
import type { PromptAssemblerConfig } from './prompt-types.js';
import {
  DEFAULT_PROMPT_PRIORITIES,
  DEFAULT_BOOTSTRAP_CONFIG,
} from './prompt-types.js';
import { BootstrapLoader } from './bootstrap-loader.js';
import { collectRuntimeInfo } from './runtime-info.js';
import {
  createToolsHandler,
  createSkillsHandler,
  createRuntimeInfoHandler,
  createBootstrapHandler,
} from './prompt-handlers.js';

export interface RegisterPromptHandlersParams {
  hooks: HookRegistry;
  agentId: string;
  agentName: string;
  agentDir: string;
  model: string;
  basePath: string;
  fs: FileSystem;
  getTools: () => ToolDefinition[];
  skills: SkillEntry[];
  config: PromptAssemblerConfig;
}

/**
 * Registers all prompt enrichment handlers on the hook registry.
 * Returns disposable handles for cleanup.
 * In 'none' mode, registers nothing and returns an empty array.
 */
export function registerPromptHandlers(
  params: RegisterPromptHandlersParams,
): Disposable[] {
  const { config } = params;
  if (config.promptMode === 'none') return [];

  const priorities = {
    ...DEFAULT_PROMPT_PRIORITIES,
    ...config.priorities,
  };

  const bootstrapConfig = config.bootstrap ?? DEFAULT_BOOTSTRAP_CONFIG;

  const runtimeInfo = collectRuntimeInfo({
    model: params.model,
    repoRoot: params.basePath,
    agentId: params.agentId,
    agentName: params.agentName,
  });

  const loader = new BootstrapLoader(
    params.agentDir,
    params.fs,
    bootstrapConfig,
  );

  const disposables: Disposable[] = [];

  disposables.push(
    params.hooks.register(
      'context_assemble',
      createToolsHandler(params.getTools, config.promptMode),
      priorities.tools,
    ),
  );

  disposables.push(
    params.hooks.register(
      'context_assemble',
      createSkillsHandler(params.skills, config.promptMode),
      priorities.skills,
    ),
  );

  disposables.push(
    params.hooks.register(
      'context_assemble',
      createRuntimeInfoHandler(runtimeInfo, config.promptMode),
      priorities.runtime,
    ),
  );

  disposables.push(
    params.hooks.register(
      'context_assemble',
      createBootstrapHandler(loader, config.promptMode),
      priorities.bootstrap,
    ),
  );

  return disposables;
}
