import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDefinition, ToolHandler } from '@clothos/core';
import { safePath } from './safe-path.js';

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const readFileToolDefinition: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Supports optional line offset and limit.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read.',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based).',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to return.',
      },
    },
    required: ['path'],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export const writeFileToolDefinition: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories as needed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file.',
      },
    },
    required: ['path', 'content'],
  },
  annotations: {
    readOnly: false,
    destructive: true,
    riskLevel: 'yellow',
  },
};

export const editFileToolDefinition: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit a file by replacing a unique occurrence of old_string with new_string. Set replace_all to replace every occurrence.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find and replace. Must be unique in the file unless replace_all is true.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'When true, replace all occurrences instead of requiring a unique match.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  annotations: {
    readOnly: false,
    riskLevel: 'yellow',
  },
};

// ---------------------------------------------------------------------------
// Handler Options
// ---------------------------------------------------------------------------

export interface FileToolOptions {
  workspaceRoot: string;
}

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------

export function createReadFileHandler(opts: FileToolOptions): ToolHandler {
  const { workspaceRoot } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const userPath = args.path;
    if (typeof userPath !== 'string' || userPath.trim() === '') {
      return { error: 'path must be a non-empty string' };
    }

    let resolved: string;
    try {
      resolved = safePath(workspaceRoot, userPath);
    } catch (err) {
      return { error: (err as Error).message };
    }

    let raw: string;
    try {
      raw = await readFile(resolved, 'utf-8');
    } catch (err) {
      return { error: `Failed to read file: ${(err as Error).message}` };
    }

    const allLines = raw.split('\n');
    const offset =
      typeof args.offset === 'number' && args.offset >= 0
        ? Math.floor(args.offset)
        : 0;
    const limit =
      typeof args.limit === 'number' && args.limit > 0
        ? Math.floor(args.limit)
        : undefined;

    const sliced = limit !== undefined
      ? allLines.slice(offset, offset + limit)
      : allLines.slice(offset);

    return {
      content: sliced.join('\n'),
      lines: sliced.length,
    };
  };
}

export function createWriteFileHandler(opts: FileToolOptions): ToolHandler {
  const { workspaceRoot } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const userPath = args.path;
    if (typeof userPath !== 'string' || userPath.trim() === '') {
      return { error: 'path must be a non-empty string' };
    }
    const content = args.content;
    if (typeof content !== 'string') {
      return { error: 'content must be a string' };
    }

    let resolved: string;
    try {
      resolved = safePath(workspaceRoot, userPath);
    } catch (err) {
      return { error: (err as Error).message };
    }

    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf-8');
    } catch (err) {
      return { error: `Failed to write file: ${(err as Error).message}` };
    }

    return { written: true, path: resolved };
  };
}

export function createEditFileHandler(opts: FileToolOptions): ToolHandler {
  const { workspaceRoot } = opts;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const userPath = args.path;
    if (typeof userPath !== 'string' || userPath.trim() === '') {
      return { error: 'path must be a non-empty string' };
    }
    const oldString = args.old_string;
    if (typeof oldString !== 'string') {
      return { error: 'old_string must be a string' };
    }
    const newString = args.new_string;
    if (typeof newString !== 'string') {
      return { error: 'new_string must be a string' };
    }

    let resolved: string;
    try {
      resolved = safePath(workspaceRoot, userPath);
    } catch (err) {
      return { error: (err as Error).message };
    }

    let content: string;
    try {
      content = await readFile(resolved, 'utf-8');
    } catch (err) {
      return { error: `Failed to read file: ${(err as Error).message}` };
    }

    const replaceAll = args.replace_all === true;

    // Count occurrences
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldString, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + oldString.length;
    }

    if (count === 0) {
      // Provide a hint if a case-insensitive match exists
      if (content.toLowerCase().includes(oldString.toLowerCase())) {
        return { error: 'No exact match found. A case-insensitive match exists — check your casing.' };
      }
      return { error: 'No match found' };
    }

    let updated: string;
    if (replaceAll) {
      updated = content.split(oldString).join(newString);
    } else {
      if (count > 1) {
        return {
          error: `Multiple matches found (${count} occurrences). Provide more context to make the match unique.`,
        };
      }
      updated = content.replace(oldString, newString);
    }

    try {
      await writeFile(resolved, updated, 'utf-8');
    } catch (err) {
      return { error: `Failed to write file: ${(err as Error).message}` };
    }

    return replaceAll
      ? { edited: true, replacements: count, path: resolved }
      : { edited: true, path: resolved };
  };
}
