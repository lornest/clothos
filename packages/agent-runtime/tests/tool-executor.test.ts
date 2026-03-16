import { describe, it, expect } from 'vitest';
import { executeToolCall, buildToolHandlerMap } from '../src/tool-executor.js';
import type { ToolHandler } from '../src/tool-executor.js';
import type { ToolDefinition } from '@clothos/core';

describe('executeToolCall', () => {
  it('executes a tool and returns success result', async () => {
    const handlers = new Map<string, ToolHandler>();
    handlers.set('echo', async (args) => args['text']);

    const result = await executeToolCall(
      { id: 'tc1', name: 'echo', arguments: '{"text":"hello"}' },
      handlers,
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error for unknown tool', async () => {
    const handlers = new Map<string, ToolHandler>();

    const result = await executeToolCall(
      { id: 'tc1', name: 'unknown', arguments: '{}' },
      handlers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool: unknown');
  });

  it('returns error for invalid JSON arguments', async () => {
    const handlers = new Map<string, ToolHandler>();
    handlers.set('echo', async (args) => args);

    const result = await executeToolCall(
      { id: 'tc1', name: 'echo', arguments: 'not json' },
      handlers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON arguments');
  });

  it('catches handler errors and returns error result', async () => {
    const handlers = new Map<string, ToolHandler>();
    handlers.set('fail', async () => {
      throw new Error('handler failed');
    });

    const result = await executeToolCall(
      { id: 'tc1', name: 'fail', arguments: '{}' },
      handlers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('handler failed');
  });

  it('measures duration', async () => {
    const handlers = new Map<string, ToolHandler>();
    handlers.set('slow', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'done';
    });

    const result = await executeToolCall(
      { id: 'tc1', name: 'slow', arguments: '{}' },
      handlers,
    );

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(10);
  });
});

describe('buildToolHandlerMap', () => {
  it('builds map from tools and registry', () => {
    const tools: ToolDefinition[] = [
      { name: 'a', description: 'Tool A', inputSchema: {} },
      { name: 'b', description: 'Tool B', inputSchema: {} },
      { name: 'c', description: 'Tool C', inputSchema: {} },
    ];
    const registry = new Map<string, ToolHandler>();
    registry.set('a', async () => 'a');
    registry.set('b', async () => 'b');
    // 'c' not in registry

    const map = buildToolHandlerMap(tools, registry);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(false);
  });
});
