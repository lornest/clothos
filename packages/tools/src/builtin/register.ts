import type { ToolRegistry } from '../registry.js';
import { bashToolDefinition } from './bash-tool.js';
import { createBashHandler } from './bash-handler.js';
import {
  readFileToolDefinition,
  writeFileToolDefinition,
  editFileToolDefinition,
  createReadFileHandler,
  createWriteFileHandler,
  createEditFileHandler,
} from './file-tools.js';
import {
  grepSearchToolDefinition,
  globFindToolDefinition,
  listDirectoryToolDefinition,
  createGrepSearchHandler,
  createGlobFindHandler,
  createListDirectoryHandler,
} from './search-tools.js';
import {
  gitStatusToolDefinition,
  gitDiffToolDefinition,
  gitCommitToolDefinition,
  createPrToolDefinition,
  createGitStatusHandler,
  createGitDiffHandler,
  createGitCommitHandler,
  createCreatePrHandler,
} from './git-tools.js';

export interface RegisterBuiltinOptions {
  workspaceRoot: string;
  defaultTimeout?: number;
  yoloMode?: boolean;
  sandboxExecutor?: (
    command: string,
    timeout: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Register all built-in tools into the given registry.
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  options: RegisterBuiltinOptions,
): void {
  const { workspaceRoot, defaultTimeout, yoloMode, sandboxExecutor } = options;

  // Bash tool
  registry.register(
    bashToolDefinition,
    createBashHandler({ defaultTimeout, cwd: workspaceRoot, yoloMode, sandboxExecutor }),
    'builtin',
  );

  // File tools
  const fileOpts = { workspaceRoot };

  registry.register(readFileToolDefinition, createReadFileHandler(fileOpts), 'builtin');
  registry.register(writeFileToolDefinition, createWriteFileHandler(fileOpts), 'builtin');
  registry.register(editFileToolDefinition, createEditFileHandler(fileOpts), 'builtin');

  // Search tools
  registry.register(grepSearchToolDefinition, createGrepSearchHandler(fileOpts), 'builtin');
  registry.register(globFindToolDefinition, createGlobFindHandler(fileOpts), 'builtin');
  registry.register(listDirectoryToolDefinition, createListDirectoryHandler(fileOpts), 'builtin');

  // Git tools
  const gitOpts = { workspaceRoot, timeout: defaultTimeout };

  registry.register(gitStatusToolDefinition, createGitStatusHandler(gitOpts), 'builtin');
  registry.register(gitDiffToolDefinition, createGitDiffHandler(gitOpts), 'builtin');
  registry.register(gitCommitToolDefinition, createGitCommitHandler(gitOpts), 'builtin');
  registry.register(createPrToolDefinition, createCreatePrHandler(gitOpts), 'builtin');
}
