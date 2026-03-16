import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/registry.js';
import { ToolConflictError } from '../src/errors.js';
import type { ToolDefinition, ToolHandler } from '@clothos/core';

/** Helper to create a minimal valid ToolDefinition. */
function makeDef(name: string, description = `Tool ${name}`): ToolDefinition {
  return { name, description, inputSchema: { type: 'object' } };
}

/** Helper to create a trivial ToolHandler. */
function makeHandler(returnValue: unknown = 'ok'): ToolHandler {
  return async () => returnValue;
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ── register / get ──────────────────────────────────────────────────

  describe('register and get', () => {
    it('registers a tool and retrieves it by name', () => {
      const def = makeDef('read_file');
      const handler = makeHandler();

      registry.register(def, handler, 'builtin');

      const entry = registry.get('read_file');
      expect(entry).toBeDefined();
      expect(entry!.definition).toBe(def);
      expect(entry!.handler).toBe(handler);
      expect(entry!.source).toBe('builtin');
      expect(entry!.mcpServer).toBeUndefined();
    });

    it('stores mcpServer when provided', () => {
      const def = makeDef('mcp_tool');
      registry.register(def, makeHandler(), 'mcp', 'my-server');

      const entry = registry.get('mcp_tool');
      expect(entry).toBeDefined();
      expect(entry!.mcpServer).toBe('my-server');
    });

    it('returns undefined for an unregistered tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  // ── conflict detection ──────────────────────────────────────────────

  describe('conflict detection', () => {
    it('throws ToolConflictError on duplicate name', () => {
      registry.register(makeDef('bash'), makeHandler(), 'builtin');

      expect(() => {
        registry.register(makeDef('bash'), makeHandler(), 'builtin');
      }).toThrow(ToolConflictError);
    });

    it('error message contains the conflicting tool name', () => {
      registry.register(makeDef('bash'), makeHandler(), 'builtin');

      expect(() => {
        registry.register(makeDef('bash'), makeHandler(), 'plugin');
      }).toThrow(/bash/);
    });
  });

  // ── unregister ──────────────────────────────────────────────────────

  describe('unregister', () => {
    it('removes an existing entry and returns true', () => {
      registry.register(makeDef('temp'), makeHandler(), 'builtin');
      expect(registry.has('temp')).toBe(true);

      const result = registry.unregister('temp');
      expect(result).toBe(true);
      expect(registry.has('temp')).toBe(false);
      expect(registry.get('temp')).toBeUndefined();
    });

    it('returns false for a non-existent tool', () => {
      expect(registry.unregister('ghost')).toBe(false);
    });
  });

  // ── getBySource ─────────────────────────────────────────────────────

  describe('getBySource', () => {
    it('filters entries by source correctly', () => {
      registry.register(makeDef('read_file'), makeHandler(), 'builtin');
      registry.register(makeDef('write_file'), makeHandler(), 'builtin');
      registry.register(makeDef('mcp_search'), makeHandler(), 'mcp', 'search-server');
      registry.register(makeDef('my_plugin'), makeHandler(), 'plugin');
      registry.register(makeDef('memory_search'), makeHandler(), 'memory');

      const builtins = registry.getBySource('builtin');
      expect(builtins).toHaveLength(2);
      expect(builtins.map((e) => e.definition.name)).toEqual(
        expect.arrayContaining(['read_file', 'write_file']),
      );

      const mcps = registry.getBySource('mcp');
      expect(mcps).toHaveLength(1);
      expect(mcps[0]!.definition.name).toBe('mcp_search');

      const plugins = registry.getBySource('plugin');
      expect(plugins).toHaveLength(1);

      const memory = registry.getBySource('memory');
      expect(memory).toHaveLength(1);
    });

    it('returns empty array when no tools match the source', () => {
      registry.register(makeDef('read_file'), makeHandler(), 'builtin');
      expect(registry.getBySource('mcp')).toEqual([]);
    });
  });

  // ── buildHandlerMap ─────────────────────────────────────────────────

  describe('buildHandlerMap', () => {
    it('returns a ToolHandlerMap with all tools when no names filter', () => {
      const h1 = makeHandler('one');
      const h2 = makeHandler('two');
      registry.register(makeDef('tool_a'), h1, 'builtin');
      registry.register(makeDef('tool_b'), h2, 'builtin');

      const map = registry.buildHandlerMap();
      expect(map.size).toBe(2);
      expect(map.get('tool_a')).toBe(h1);
      expect(map.get('tool_b')).toBe(h2);
    });

    it('returns only requested tools when names filter is provided', () => {
      registry.register(makeDef('a'), makeHandler('a'), 'builtin');
      registry.register(makeDef('b'), makeHandler('b'), 'builtin');
      registry.register(makeDef('c'), makeHandler('c'), 'builtin');

      const map = registry.buildHandlerMap(['a', 'c']);
      expect(map.size).toBe(2);
      expect(map.has('a')).toBe(true);
      expect(map.has('b')).toBe(false);
      expect(map.has('c')).toBe(true);
    });

    it('silently skips names not in the registry', () => {
      registry.register(makeDef('a'), makeHandler(), 'builtin');

      const map = registry.buildHandlerMap(['a', 'nonexistent']);
      expect(map.size).toBe(1);
      expect(map.has('a')).toBe(true);
    });

    it('returns the actual handler functions', async () => {
      registry.register(makeDef('echo'), async () => 'hello', 'builtin');

      const map = registry.buildHandlerMap();
      const handler = map.get('echo')!;
      const result = await handler({});
      expect(result).toBe('hello');
    });
  });

  // ── getDefinitions ──────────────────────────────────────────────────

  describe('getDefinitions', () => {
    it('returns all ToolDefinitions when no names filter', () => {
      const defA = makeDef('a');
      const defB = makeDef('b');
      registry.register(defA, makeHandler(), 'builtin');
      registry.register(defB, makeHandler(), 'mcp');

      const defs = registry.getDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs).toEqual(expect.arrayContaining([defA, defB]));
    });

    it('returns only requested definitions when names filter is provided', () => {
      const defA = makeDef('a');
      const defB = makeDef('b');
      const defC = makeDef('c');
      registry.register(defA, makeHandler(), 'builtin');
      registry.register(defB, makeHandler(), 'builtin');
      registry.register(defC, makeHandler(), 'builtin');

      const defs = registry.getDefinitions(['b']);
      expect(defs).toHaveLength(1);
      expect(defs[0]).toBe(defB);
    });

    it('skips names not in the registry', () => {
      registry.register(makeDef('a'), makeHandler(), 'builtin');

      const defs = registry.getDefinitions(['a', 'missing']);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.name).toBe('a');
    });
  });

  // ── clear ───────────────────────────────────────────────────────────

  describe('clear', () => {
    it('empties the registry', () => {
      registry.register(makeDef('a'), makeHandler(), 'builtin');
      registry.register(makeDef('b'), makeHandler(), 'mcp');
      expect(registry.size).toBe(2);

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.get('a')).toBeUndefined();
      expect(registry.get('b')).toBeUndefined();
    });
  });

  // ── size ────────────────────────────────────────────────────────────

  describe('size', () => {
    it('returns 0 for an empty registry', () => {
      expect(registry.size).toBe(0);
    });

    it('returns the correct count after registrations', () => {
      registry.register(makeDef('a'), makeHandler(), 'builtin');
      expect(registry.size).toBe(1);

      registry.register(makeDef('b'), makeHandler(), 'mcp');
      expect(registry.size).toBe(2);
    });

    it('decreases after unregister', () => {
      registry.register(makeDef('a'), makeHandler(), 'builtin');
      registry.register(makeDef('b'), makeHandler(), 'builtin');
      expect(registry.size).toBe(2);

      registry.unregister('a');
      expect(registry.size).toBe(1);
    });
  });
});
