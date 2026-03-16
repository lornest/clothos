import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PolicyContext } from '@clothos/core';
import { createUseMcpToolHandler } from '../src/mcp/use-mcp-tool.js';

// ── Mock types ────────────────────────────────────────────────────────

interface MockMcpManager {
  callTool: ReturnType<typeof vi.fn>;
  getToolSchema: ReturnType<typeof vi.fn>;
}

interface MockPolicyEngine {
  isAllowed: ReturnType<typeof vi.fn>;
}

describe('createUseMcpToolHandler', () => {
  let mockMcpManager: MockMcpManager;
  let mockPolicyEngine: MockPolicyEngine;
  let mockContext: PolicyContext;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    mockMcpManager = {
      callTool: vi.fn(),
      getToolSchema: vi.fn().mockReturnValue(undefined),
    };

    mockPolicyEngine = {
      isAllowed: vi.fn().mockReturnValue(true),
    };

    mockContext = { agentId: 'agent-1' };

    handler = createUseMcpToolHandler(
      mockMcpManager as any,
      mockPolicyEngine as any,
      () => mockContext,
    );
  });

  // ── Valid call ──────────────────────────────────────────────────────

  it('routes to mcpManager and returns result', async () => {
    mockMcpManager.callTool.mockResolvedValue({ data: 'search results' });

    const result = await handler({
      tool_name: 'search__web_search',
      arguments: { query: 'hello' },
    });

    expect(result).toEqual({ data: 'search results' });
    expect(mockMcpManager.callTool).toHaveBeenCalledWith('search__web_search', {
      query: 'hello',
    });
  });

  // ── Policy denial ──────────────────────────────────────────────────

  it('returns error when tool is not allowed by policy', async () => {
    mockPolicyEngine.isAllowed.mockReturnValue(false);

    const result = (await handler({
      tool_name: 'search__web_search',
      arguments: {},
    })) as { error: string };

    expect(result.error).toContain('not allowed');
    expect(result.error).toContain('agent-1');
    expect(mockMcpManager.callTool).not.toHaveBeenCalled();
  });

  // ── Missing tool_name ──────────────────────────────────────────────

  it('returns error when tool_name is missing', async () => {
    const result = (await handler({ arguments: {} })) as { error: string };

    expect(result.error).toContain('Missing required argument: tool_name');
    expect(mockMcpManager.callTool).not.toHaveBeenCalled();
  });

  // ── Validation errors ──────────────────────────────────────────────

  it('returns error with schema hints when args are invalid', async () => {
    mockMcpManager.getToolSchema.mockReturnValue({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    });

    // Pass args without the required 'query' field
    const result = (await handler({
      tool_name: 'search__web_search',
      arguments: { limit: 'not-a-number' },
    })) as { error: string };

    expect(result.error).toContain('Argument validation failed');
    expect(result.error).toContain('query');
    expect(result.error).toContain('Schema properties');
    expect(mockMcpManager.callTool).not.toHaveBeenCalled();
  });

  // ── Default empty args ─────────────────────────────────────────────

  it('defaults to empty args when arguments is not provided', async () => {
    mockMcpManager.callTool.mockResolvedValue({ ok: true });

    const result = await handler({ tool_name: 'search__list' });

    expect(mockMcpManager.callTool).toHaveBeenCalledWith('search__list', {});
    expect(result).toEqual({ ok: true });
  });

  // ── Error from mcpManager ──────────────────────────────────────────

  it('returns error object when mcpManager.callTool throws', async () => {
    mockMcpManager.callTool.mockRejectedValue(new Error('Connection lost'));

    const result = (await handler({
      tool_name: 'search__web_search',
      arguments: {},
    })) as { error: string };

    expect(result.error).toBe('Connection lost');
  });
});
