import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGrepSearchHandler,
  createGlobFindHandler,
  createListDirectoryHandler,
} from '../src/builtin/search-tools.js';

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'clothos-search-test-'));

  // Create test file structure
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await mkdir(join(workspaceRoot, 'src/utils'), { recursive: true });
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });

  await writeFile(join(workspaceRoot, 'src/index.ts'), 'export function hello() {\n  return "world";\n}\n');
  await writeFile(join(workspaceRoot, 'src/utils/math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number) {\n  return a * b;\n}\n');
  await writeFile(join(workspaceRoot, 'src/utils/string.ts'), 'export function capitalize(s: string) {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n');
  await writeFile(join(workspaceRoot, 'docs/readme.md'), '# Hello\n\nThis is a readme file.\n');
  await writeFile(join(workspaceRoot, 'package.json'), '{ "name": "test" }\n');

  // Create a "binary" file (contains null bytes)
  const binaryBuf = Buffer.alloc(100);
  binaryBuf[0] = 0;
  binaryBuf[10] = 0x48; // 'H'
  await writeFile(join(workspaceRoot, 'binary.dat'), binaryBuf);
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

// ── grep_search ─────────────────────────────────────────────────────

describe('createGrepSearchHandler', () => {
  it('finds matches with context lines', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    const result = (await handler({ pattern: 'function add' })) as {
      matches: Array<{ file: string; line: number; content: string; context: { before: string[]; after: string[] } }>;
      totalMatches: number;
      truncated: boolean;
    };

    expect(result.totalMatches).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.matches[0]!.file).toContain('math.ts');
    expect(result.matches[0]!.line).toBe(1);
    expect(result.matches[0]!.content).toContain('function add');
  });

  it('respects include filter', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    const result = (await handler({ pattern: 'export', include: '*.md' })) as {
      matches: unknown[];
      totalMatches: number;
    };

    expect(result.totalMatches).toBe(0);
  });

  it('respects include filter matching .ts files', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    const result = (await handler({ pattern: 'export', include: '*.ts' })) as {
      matches: Array<{ file: string }>;
      totalMatches: number;
    };

    expect(result.totalMatches).toBeGreaterThan(0);
    for (const m of result.matches) {
      expect(m.file).toMatch(/\.ts$/);
    }
  });

  it('respects maxResults cap', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    const result = (await handler({ pattern: 'export', maxResults: 2 })) as {
      matches: unknown[];
      totalMatches: number;
      truncated: boolean;
    };

    expect(result.matches.length).toBeLessThanOrEqual(2);
    if (result.totalMatches > 2) {
      expect(result.truncated).toBe(true);
    }
  });

  it('skips binary files', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    // The binary file shouldn't produce any matches even if pattern would match bytes
    const result = (await handler({ pattern: 'H' })) as {
      matches: Array<{ file: string }>;
    };

    for (const m of result.matches) {
      expect(m.file).not.toContain('binary.dat');
    }
  });

  it('blocks path traversal', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    const result = (await handler({ pattern: 'test', path: '../../../etc' })) as {
      error: string;
    };

    expect(result.error).toContain('Path traversal detected');
  });

  it('returns error for invalid regex', async () => {
    const handler = createGrepSearchHandler({ workspaceRoot });
    const result = (await handler({ pattern: '[invalid' })) as { error: string };

    expect(result.error).toContain('Invalid regex');
  });
});

// ── glob_find ───────────────────────────────────────────────────────

describe('createGlobFindHandler', () => {
  it('finds files matching glob pattern', async () => {
    const handler = createGlobFindHandler({ workspaceRoot });
    const result = (await handler({ pattern: '**/*.ts' })) as {
      files: string[];
      total: number;
      truncated: boolean;
    };

    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual(expect.arrayContaining([
      expect.stringContaining('index.ts'),
    ]));
  });

  it('finds files in subdirectory', async () => {
    const handler = createGlobFindHandler({ workspaceRoot });
    const result = (await handler({ pattern: '*.ts', path: 'src/utils' })) as {
      files: string[];
      total: number;
    };

    expect(result.total).toBe(2);
  });

  it('respects maxResults truncation', async () => {
    const handler = createGlobFindHandler({ workspaceRoot });
    const result = (await handler({ pattern: '**/*', maxResults: 2 })) as {
      files: string[];
      total: number;
      truncated: boolean;
    };

    expect(result.files.length).toBe(2);
    if (result.total > 2) {
      expect(result.truncated).toBe(true);
    }
  });
});

// ── list_directory ──────────────────────────────────────────────────

describe('createListDirectoryHandler', () => {
  it('lists workspace root by default', async () => {
    const handler = createListDirectoryHandler({ workspaceRoot });
    const result = (await handler({})) as {
      entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }>;
    };

    const names = result.entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('docs');
    expect(names).toContain('package.json');

    const srcEntry = result.entries.find((e) => e.name === 'src');
    expect(srcEntry!.type).toBe('directory');

    const pkgEntry = result.entries.find((e) => e.name === 'package.json');
    expect(pkgEntry!.type).toBe('file');
    expect(pkgEntry!.size).toBeGreaterThan(0);
  });

  it('lists subdirectory', async () => {
    const handler = createListDirectoryHandler({ workspaceRoot });
    const result = (await handler({ path: 'src/utils' })) as {
      entries: Array<{ name: string; type: string }>;
    };

    const names = result.entries.map((e) => e.name);
    expect(names).toContain('math.ts');
    expect(names).toContain('string.ts');
  });

  it('returns error for nonexistent directory', async () => {
    const handler = createListDirectoryHandler({ workspaceRoot });
    const result = (await handler({ path: 'nonexistent' })) as { error: string };

    expect(result.error).toContain('Failed to read directory');
  });
});
