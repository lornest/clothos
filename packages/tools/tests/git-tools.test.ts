import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createGitStatusHandler,
  createGitDiffHandler,
  createGitCommitHandler,
  createCreatePrHandler,
} from '../src/builtin/git-tools.js';

const execFile = promisify(execFileCb);

let workspaceRoot: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: workspaceRoot });
  return stdout.trim();
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'clothos-git-test-'));

  // Initialize a git repo
  await git(['init']);
  await git(['config', 'user.email', 'test@test.com']);
  await git(['config', 'user.name', 'Test']);

  // Create initial commit
  await writeFile(join(workspaceRoot, 'readme.md'), '# Test\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'Initial commit']);
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

// ── git_status ──────────────────────────────────────────────────────

describe('createGitStatusHandler', () => {
  it('shows clean status after commit', async () => {
    const handler = createGitStatusHandler({ workspaceRoot });
    const result = (await handler({})) as {
      staged: string[];
      unstaged: string[];
      untracked: string[];
      clean: boolean;
    };

    expect(result.clean).toBe(true);
    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it('detects untracked files', async () => {
    await writeFile(join(workspaceRoot, 'new-file.txt'), 'hello');

    const handler = createGitStatusHandler({ workspaceRoot });
    const result = (await handler({})) as {
      untracked: string[];
      clean: boolean;
    };

    expect(result.clean).toBe(false);
    expect(result.untracked).toContain('new-file.txt');

    // Cleanup
    await git(['checkout', '--', '.']);
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(join(workspaceRoot, 'new-file.txt'));
  });

  it('detects staged files', async () => {
    await writeFile(join(workspaceRoot, 'staged.txt'), 'staged content');
    await git(['add', 'staged.txt']);

    const handler = createGitStatusHandler({ workspaceRoot });
    const result = (await handler({})) as {
      staged: string[];
      clean: boolean;
    };

    expect(result.clean).toBe(false);
    expect(result.staged).toContain('staged.txt');

    // Cleanup
    await git(['reset', 'HEAD', 'staged.txt']);
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(join(workspaceRoot, 'staged.txt'));
  });
});

// ── git_diff ────────────────────────────────────────────────────────

describe('createGitDiffHandler', () => {
  it('shows diff for modified file', async () => {
    await writeFile(join(workspaceRoot, 'readme.md'), '# Test\n\nUpdated content.\n');

    const handler = createGitDiffHandler({ workspaceRoot });
    const result = (await handler({})) as {
      diff: string;
      filesChanged: number;
    };

    expect(result.diff).toContain('Updated content');
    expect(result.filesChanged).toBe(1);

    // Cleanup
    await git(['checkout', '--', 'readme.md']);
  });

  it('shows staged diff', async () => {
    await writeFile(join(workspaceRoot, 'readme.md'), '# Test\n\nStaged change.\n');
    await git(['add', 'readme.md']);

    const handler = createGitDiffHandler({ workspaceRoot });
    const result = (await handler({ staged: true })) as {
      diff: string;
      filesChanged: number;
    };

    expect(result.diff).toContain('Staged change');
    expect(result.filesChanged).toBe(1);

    // Cleanup
    await git(['reset', 'HEAD', 'readme.md']);
    await git(['checkout', '--', 'readme.md']);
  });
});

// ── git_commit ──────────────────────────────────────────────────────

describe('createGitCommitHandler', () => {
  it('commits with correct message and SHA', async () => {
    await writeFile(join(workspaceRoot, 'commit-test.txt'), 'commit this');

    const handler = createGitCommitHandler({ workspaceRoot });
    const result = (await handler({
      message: 'test: add commit-test.txt',
      files: ['commit-test.txt'],
    })) as {
      committed: boolean;
      sha: string;
      filesChanged: number;
    };

    expect(result.committed).toBe(true);
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.filesChanged).toBe(1);

    // Verify commit message
    const log = await git(['log', '-1', '--pretty=%s']);
    expect(log).toBe('test: add commit-test.txt');
  });

  it('returns error for empty message', async () => {
    const handler = createGitCommitHandler({ workspaceRoot });
    const result = (await handler({ message: '' })) as { error: string };

    expect(result.error).toContain('message must be a non-empty string');
  });

  it('validates file paths', async () => {
    const handler = createGitCommitHandler({ workspaceRoot });
    const result = (await handler({
      message: 'evil',
      files: ['../../../etc/passwd'],
    })) as { error: string };

    expect(result.error).toContain('Path traversal detected');
  });
});

// ── create_pr ───────────────────────────────────────────────────────

describe('createCreatePrHandler', () => {
  it('returns error in non-GitHub repo', async () => {
    const handler = createCreatePrHandler({ workspaceRoot });
    const result = (await handler({
      title: 'Test PR',
      body: 'This should fail',
    })) as { error: string };

    // Should fail because the temp repo has no GitHub remote
    expect(result.error).toBeDefined();
  });

  it('returns error for empty title', async () => {
    const handler = createCreatePrHandler({ workspaceRoot });
    const result = (await handler({ title: '' })) as { error: string };

    expect(result.error).toContain('title must be a non-empty string');
  });
});
