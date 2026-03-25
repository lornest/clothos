import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { globSync } from 'node:fs';
import type { ToolDefinition, ToolHandler } from '@clothos/core';
import { safePath } from './safe-path.js';
import type { FileToolOptions } from './file-tools.js';

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const grepSearchToolDefinition: ToolDefinition = {
  name: 'grep_search',
  description:
    'Search file contents using a regex pattern. Returns matching lines with surrounding context.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search within (relative to workspace root). Defaults to workspace root.',
      },
      include: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. "*.ts").',
      },
      contextLines: {
        type: 'number',
        description: 'Number of context lines before and after each match. Default: 2.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of matches to return. Default: 50.',
      },
    },
    required: ['pattern'],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export const globFindToolDefinition: ToolDefinition = {
  name: 'glob_find',
  description: 'Find files matching a glob pattern.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.json").',
      },
      path: {
        type: 'string',
        description: 'Directory to search within (relative to workspace root). Defaults to workspace root.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of files to return. Default: 200.',
      },
    },
    required: ['pattern'],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export const listDirectoryToolDefinition: ToolDefinition = {
  name: 'list_directory',
  description: 'List directory contents with file types and sizes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list (relative to workspace root). Defaults to workspace root.',
      },
    },
    required: [],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

function isBinaryBuffer(buffer: Buffer): boolean {
  // Check first 512 bytes for null byte
  const check = buffer.subarray(0, 512);
  return check.includes(0);
}

function matchesGlob(filename: string, pattern: string): boolean {
  // Simple glob matching for include filters like "*.ts"
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(filename);
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      // entry.parentPath is available in Node 22 recursive readdir
      const parent = (entry as unknown as { parentPath?: string }).parentPath ?? dir;
      files.push(join(parent, entry.name));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------

export function createGrepSearchHandler(opts: FileToolOptions): ToolHandler {
  const { workspaceRoot } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { error: 'pattern must be a non-empty string' };
    }

    const contextLines = typeof args.contextLines === 'number' ? Math.max(0, Math.floor(args.contextLines)) : 2;
    const maxResults = typeof args.maxResults === 'number' ? Math.max(1, Math.floor(args.maxResults)) : 50;
    const include = typeof args.include === 'string' ? args.include : undefined;

    let searchDir: string;
    try {
      searchDir = typeof args.path === 'string' && args.path.trim() !== ''
        ? safePath(workspaceRoot, args.path)
        : workspaceRoot;
    } catch (err) {
      return { error: (err as Error).message };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return { error: `Invalid regex pattern: ${pattern}` };
    }

    let files: string[];
    try {
      files = await walkFiles(searchDir);
    } catch (err) {
      return { error: `Failed to read directory: ${(err as Error).message}` };
    }

    // Filter by include glob
    if (include) {
      files = files.filter((f) => {
        const name = f.split('/').pop() ?? '';
        return matchesGlob(name, include);
      });
    }

    interface Match {
      file: string;
      line: number;
      content: string;
      context: { before: string[]; after: string[] };
    }

    const matches: Match[] = [];
    let totalMatches = 0;

    for (const filePath of files) {
      if (matches.length >= maxResults) break;

      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      if (fileStat.size > MAX_FILE_SIZE) continue;

      let buffer: Buffer;
      try {
        buffer = await readFile(filePath) as unknown as Buffer;
      } catch {
        continue;
      }
      if (isBinaryBuffer(buffer)) continue;

      const content = buffer.toString('utf-8');
      const lines = content.split('\n');
      const relPath = relative(workspaceRoot, filePath);

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          totalMatches++;
          if (matches.length < maxResults) {
            const beforeStart = Math.max(0, i - contextLines);
            const afterEnd = Math.min(lines.length - 1, i + contextLines);
            matches.push({
              file: relPath,
              line: i + 1, // 1-based
              content: lines[i]!,
              context: {
                before: lines.slice(beforeStart, i),
                after: lines.slice(i + 1, afterEnd + 1),
              },
            });
          }
        }
      }
    }

    return {
      matches,
      totalMatches,
      truncated: totalMatches > maxResults,
    };
  };
}

export function createGlobFindHandler(opts: FileToolOptions): ToolHandler {
  const { workspaceRoot } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { error: 'pattern must be a non-empty string' };
    }

    const maxResults = typeof args.maxResults === 'number' ? Math.max(1, Math.floor(args.maxResults)) : 200;

    let cwd: string;
    try {
      cwd = typeof args.path === 'string' && args.path.trim() !== ''
        ? safePath(workspaceRoot, args.path)
        : workspaceRoot;
    } catch (err) {
      return { error: (err as Error).message };
    }

    let allFiles: string[];
    try {
      allFiles = globSync(pattern, { cwd }) as unknown as string[];
    } catch (err) {
      return { error: `Glob error: ${(err as Error).message}` };
    }

    const truncated = allFiles.length > maxResults;
    const files = truncated ? allFiles.slice(0, maxResults) : allFiles;

    return {
      files,
      total: allFiles.length,
      truncated,
    };
  };
}

export function createListDirectoryHandler(opts: FileToolOptions): ToolHandler {
  const { workspaceRoot } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    let dir: string;
    try {
      dir = typeof args.path === 'string' && args.path.trim() !== ''
        ? safePath(workspaceRoot, args.path)
        : workspaceRoot;
    } catch (err) {
      return { error: (err as Error).message };
    }

    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      return { error: `Failed to read directory: ${(err as Error).message}` };
    }

    interface Entry {
      name: string;
      type: 'file' | 'directory';
      size?: number;
    }

    const entries: Entry[] = [];
    for (const entry of dirEntries) {
      const entryPath = join(dir, entry.name);
      const e: Entry = {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
      if (entry.isFile()) {
        try {
          const s = await stat(entryPath);
          e.size = s.size;
        } catch {
          // skip stat errors
        }
      }
      entries.push(e);
    }

    return { entries };
  };
}
