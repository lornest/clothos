import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readDailyLog, listDailyLogs, appendDailyLog } from '../src/daily-log.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), 'clothos-test', randomUUID());
  mkdirSync(join(testDir, 'memory'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('readDailyLog', () => {
  it('reads an existing daily log file', async () => {
    writeFileSync(join(testDir, 'memory', '2025-01-15.md'), '# Daily Log\nSome content');
    const content = await readDailyLog(testDir, 'memory', '2025-01-15');
    expect(content).toBe('# Daily Log\nSome content');
  });

  it('returns null for non-existent file', async () => {
    const content = await readDailyLog(testDir, 'memory', '2099-01-01');
    expect(content).toBeNull();
  });
});

describe('listDailyLogs', () => {
  it('lists available log dates', async () => {
    writeFileSync(join(testDir, 'memory', '2025-01-15.md'), 'log 1');
    writeFileSync(join(testDir, 'memory', '2025-01-16.md'), 'log 2');
    writeFileSync(join(testDir, 'memory', '2025-01-14.md'), 'log 3');

    const dates = await listDailyLogs(testDir, 'memory');
    expect(dates).toEqual(['2025-01-14', '2025-01-15', '2025-01-16']);
  });

  it('returns empty for non-existent directory', async () => {
    const dates = await listDailyLogs(testDir, 'nonexistent');
    expect(dates).toEqual([]);
  });

  it('ignores non-md files', async () => {
    writeFileSync(join(testDir, 'memory', '2025-01-15.md'), 'log');
    writeFileSync(join(testDir, 'memory', 'notes.txt'), 'not a log');

    const dates = await listDailyLogs(testDir, 'memory');
    expect(dates).toEqual(['2025-01-15']);
  });
});

describe('appendDailyLog', () => {
  it('creates a new daily log', async () => {
    const writeFn = async (path: string, content: string) => {
      writeFileSync(path, content);
    };

    await appendDailyLog(testDir, 'memory', '2025-01-15', '## New Entry', writeFn);
    const content = readFileSync(join(testDir, 'memory', '2025-01-15.md'), 'utf-8');
    expect(content).toBe('## New Entry');
  });

  it('appends to existing daily log', async () => {
    writeFileSync(join(testDir, 'memory', '2025-01-15.md'), '## Existing');

    const writeFn = async (path: string, content: string) => {
      writeFileSync(path, content);
    };
    const readFn = async (path: string) => {
      return readFileSync(path, 'utf-8');
    };

    await appendDailyLog(testDir, 'memory', '2025-01-15', '## Appended', writeFn, readFn);
    const content = readFileSync(join(testDir, 'memory', '2025-01-15.md'), 'utf-8');
    expect(content).toBe('## Existing\n\n## Appended');
  });
});
