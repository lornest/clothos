import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolHandler } from '@clothos/core';
import { safePath } from './safe-path.js';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const gitStatusToolDefinition: ToolDefinition = {
  name: 'git_status',
  description: 'Show the working tree status (staged, unstaged, and untracked files).',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export const gitDiffToolDefinition: ToolDefinition = {
  name: 'git_diff',
  description: 'Show changes in the working tree or staging area.',
  inputSchema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'When true, show staged changes (--staged). Default: false.',
      },
      path: {
        type: 'string',
        description: 'Limit diff to a specific file path.',
      },
    },
    required: [],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export const gitCommitToolDefinition: ToolDefinition = {
  name: 'git_commit',
  description: 'Stage files and create a git commit.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific files to stage. If omitted, stages all changes (git add -A).',
      },
    },
    required: ['message'],
  },
  annotations: {
    readOnly: false,
    riskLevel: 'yellow',
  },
};

export const createPrToolDefinition: ToolDefinition = {
  name: 'create_pr',
  description: 'Create a GitHub pull request using the gh CLI.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Pull request title.',
      },
      body: {
        type: 'string',
        description: 'Pull request body/description.',
      },
      base: {
        type: 'string',
        description: 'Base branch. Default: main.',
      },
      draft: {
        type: 'boolean',
        description: 'Create as draft PR.',
      },
    },
    required: ['title'],
  },
  annotations: {
    readOnly: false,
    riskLevel: 'yellow',
  },
};

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

export interface GitToolOptions {
  workspaceRoot: string;
  timeout?: number;
}

async function execGit(
  args: string[],
  cwd: string,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

async function execGh(
  args: string[],
  cwd: string,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------

export function createGitStatusHandler(opts: GitToolOptions): ToolHandler {
  const { workspaceRoot, timeout } = opts;

  return async (): Promise<unknown> => {
    const result = await execGit(['status', '--porcelain=v2'], workspaceRoot, timeout);
    if (result.exitCode !== 0) {
      return { error: `git status failed: ${result.stderr}` };
    }

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('?')) {
        // Untracked: "? <path>"
        untracked.push(line.slice(2));
      } else if (line.startsWith('1') || line.startsWith('2')) {
        // Changed entry: "1 XY ..." or "2 XY ..."
        const xy = line.split(' ')[1] ?? '';
        // Extract path — it's the last field
        const parts = line.split(' ');
        const path = parts[parts.length - 1] ?? '';
        if (xy[0] !== '.') staged.push(path);
        if (xy[1] !== '.') unstaged.push(path);
      }
    }

    return {
      staged,
      unstaged,
      untracked,
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    };
  };
}

export function createGitDiffHandler(opts: GitToolOptions): ToolHandler {
  const { workspaceRoot, timeout } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const gitArgs = ['diff'];
    if (args.staged === true) gitArgs.push('--staged');

    if (typeof args.path === 'string' && args.path.trim() !== '') {
      try {
        safePath(workspaceRoot, args.path);
      } catch (err) {
        return { error: (err as Error).message };
      }
      gitArgs.push('--', args.path);
    }

    const result = await execGit(gitArgs, workspaceRoot, timeout);
    if (result.exitCode !== 0) {
      return { error: `git diff failed: ${result.stderr}` };
    }

    // Count files changed from diff stat
    const statResult = await execGit(
      [...gitArgs.slice(0, gitArgs.indexOf('diff') + 1), '--stat', ...gitArgs.slice(gitArgs.indexOf('diff') + 1)],
      workspaceRoot,
      timeout,
    );
    const filesChanged = (statResult.stdout.match(/\d+ files? changed/)?.[0] ?? '0').replace(/\D+/g, '');

    return {
      diff: result.stdout,
      filesChanged: parseInt(filesChanged, 10) || 0,
    };
  };
}

export function createGitCommitHandler(opts: GitToolOptions): ToolHandler {
  const { workspaceRoot, timeout } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const message = args.message;
    if (typeof message !== 'string' || message.trim() === '') {
      return { error: 'message must be a non-empty string' };
    }

    const files = args.files;

    // Stage files
    if (Array.isArray(files) && files.length > 0) {
      for (const f of files) {
        if (typeof f !== 'string') {
          return { error: 'Each file must be a string' };
        }
        try {
          safePath(workspaceRoot, f);
        } catch (err) {
          return { error: (err as Error).message };
        }
      }
      const addResult = await execGit(['add', ...files as string[]], workspaceRoot, timeout);
      if (addResult.exitCode !== 0) {
        return { error: `git add failed: ${addResult.stderr}` };
      }
    } else {
      const addResult = await execGit(['add', '-A'], workspaceRoot, timeout);
      if (addResult.exitCode !== 0) {
        return { error: `git add failed: ${addResult.stderr}` };
      }
    }

    // Commit
    const commitResult = await execGit(['commit', '-m', message], workspaceRoot, timeout);
    if (commitResult.exitCode !== 0) {
      return { error: `git commit failed: ${commitResult.stderr}` };
    }

    // Get SHA
    const shaResult = await execGit(['rev-parse', 'HEAD'], workspaceRoot, timeout);
    const sha = shaResult.stdout.trim();

    // Count files in commit
    const showResult = await execGit(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], workspaceRoot, timeout);
    const filesChanged = showResult.stdout.trim().split('\n').filter(Boolean).length;

    return { committed: true, sha, filesChanged };
  };
}

export function createCreatePrHandler(opts: GitToolOptions): ToolHandler {
  const { workspaceRoot, timeout } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const title = args.title;
    if (typeof title !== 'string' || title.trim() === '') {
      return { error: 'title must be a non-empty string' };
    }

    const ghArgs = ['pr', 'create', '--title', title];

    if (typeof args.body === 'string') {
      ghArgs.push('--body', args.body);
    }
    if (typeof args.base === 'string') {
      ghArgs.push('--base', args.base);
    } else {
      ghArgs.push('--base', 'main');
    }
    if (args.draft === true) {
      ghArgs.push('--draft');
    }

    const result = await execGh(ghArgs, workspaceRoot, timeout);
    if (result.exitCode !== 0) {
      const stderr = result.stderr;
      if (stderr.includes('not authenticated') || stderr.includes('auth login')) {
        return { error: `GitHub CLI not authenticated. Run 'gh auth login' first. Details: ${stderr}` };
      }
      return { error: `gh pr create failed: ${stderr}` };
    }

    // gh pr create outputs the PR URL on stdout
    const url = result.stdout.trim();
    // Try to extract PR number from URL
    const numberMatch = url.match(/\/pull\/(\d+)/);
    const number = numberMatch ? parseInt(numberMatch[1]!, 10) : undefined;

    return { url, number };
  };
}
