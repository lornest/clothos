import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createReadFileHandler,
  createWriteFileHandler,
  createEditFileHandler,
} from '../src/builtin/file-tools.js';

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'clothos-test-'));
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

// ── Read File Handler ─────────────────────────────────────────────────

describe('createReadFileHandler', () => {
  it('reads a file and returns content and line count', async () => {
    // Set up a file first
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'hello.txt', content: 'line1\nline2\nline3' });

    const readHandler = createReadFileHandler({ workspaceRoot });
    const result = (await readHandler({ path: 'hello.txt' })) as {
      content: string;
      lines: number;
    };

    expect(result.content).toBe('line1\nline2\nline3');
    expect(result.lines).toBe(3);
  });

  it('reads a file with offset and limit', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'multiline.txt', content: 'a\nb\nc\nd\ne' });

    const readHandler = createReadFileHandler({ workspaceRoot });
    const result = (await readHandler({ path: 'multiline.txt', offset: 1, limit: 2 })) as {
      content: string;
      lines: number;
    };

    expect(result.content).toBe('b\nc');
    expect(result.lines).toBe(2);
  });

  it('returns error for non-existent file', async () => {
    const readHandler = createReadFileHandler({ workspaceRoot });
    const result = (await readHandler({ path: 'nonexistent.txt' })) as { error: string };

    expect(result.error).toContain('Failed to read file');
  });

  it('blocks path traversal', async () => {
    const readHandler = createReadFileHandler({ workspaceRoot });
    const result = (await readHandler({ path: '../../../etc/passwd' })) as {
      error: string;
    };

    expect(result.error).toContain('Path traversal detected');
  });
});

// ── Write File Handler ────────────────────────────────────────────────

describe('createWriteFileHandler', () => {
  it('writes a file with content and creates parent directories', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    const result = (await writeHandler({
      path: 'subdir/nested/output.txt',
      content: 'hello from write',
    })) as { written: boolean; path: string };

    expect(result.written).toBe(true);

    // Verify file was actually written
    const content = await readFile(join(workspaceRoot, 'subdir/nested/output.txt'), 'utf-8');
    expect(content).toBe('hello from write');
  });

  it('blocks path traversal', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    const result = (await writeHandler({
      path: '../../../tmp/evil.txt',
      content: 'payload',
    })) as { error: string };

    expect(result.error).toContain('Path traversal detected');
  });
});

// ── Edit File Handler ─────────────────────────────────────────────────

describe('createEditFileHandler', () => {
  it('replaces a unique string successfully', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'edit-target.txt', content: 'foo bar baz' });

    const editHandler = createEditFileHandler({ workspaceRoot });
    const result = (await editHandler({
      path: 'edit-target.txt',
      old_string: 'bar',
      new_string: 'QUX',
    })) as { edited: boolean; path: string };

    expect(result.edited).toBe(true);

    // Verify the file was updated
    const content = await readFile(join(workspaceRoot, 'edit-target.txt'), 'utf-8');
    expect(content).toBe('foo QUX baz');
  });

  it('returns error when no match is found', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'edit-no-match.txt', content: 'hello world' });

    const editHandler = createEditFileHandler({ workspaceRoot });
    const result = (await editHandler({
      path: 'edit-no-match.txt',
      old_string: 'NOTFOUND',
      new_string: 'replacement',
    })) as { error: string };

    expect(result.error).toBe('No match found');
  });

  it('returns error when multiple matches are found', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'edit-multi.txt', content: 'aaa bbb aaa' });

    const editHandler = createEditFileHandler({ workspaceRoot });
    const result = (await editHandler({
      path: 'edit-multi.txt',
      old_string: 'aaa',
      new_string: 'zzz',
    })) as { error: string };

    expect(result.error).toContain('Multiple matches found');
    expect(result.error).toContain('2 occurrences');
  });

  it('blocks path traversal', async () => {
    const editHandler = createEditFileHandler({ workspaceRoot });
    const result = (await editHandler({
      path: '../../../etc/passwd',
      old_string: 'root',
      new_string: 'hacked',
    })) as { error: string };

    expect(result.error).toContain('Path traversal detected');
  });

  it('replaces all occurrences when replace_all is true', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'edit-replace-all.txt', content: 'aaa bbb aaa ccc aaa' });

    const editHandler = createEditFileHandler({ workspaceRoot });
    const result = (await editHandler({
      path: 'edit-replace-all.txt',
      old_string: 'aaa',
      new_string: 'zzz',
      replace_all: true,
    })) as { edited: boolean; replacements: number; path: string };

    expect(result.edited).toBe(true);
    expect(result.replacements).toBe(3);

    // Verify file contents
    const content = await readFile(join(workspaceRoot, 'edit-replace-all.txt'), 'utf-8');
    expect(content).toBe('zzz bbb zzz ccc zzz');
  });

  it('returns case-insensitive hint when no exact match found', async () => {
    const writeHandler = createWriteFileHandler({ workspaceRoot });
    await writeHandler({ path: 'edit-case-hint.txt', content: 'Hello World' });

    const editHandler = createEditFileHandler({ workspaceRoot });
    const result = (await editHandler({
      path: 'edit-case-hint.txt',
      old_string: 'hello world',
      new_string: 'goodbye',
    })) as { error: string };

    expect(result.error).toContain('case-insensitive match exists');
  });
});
