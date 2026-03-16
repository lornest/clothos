import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '@clothos/core';
import type { McpToolInfo } from '../src/mcp/mcp-client-connection.js';

// Shared map that each test configures before calling connectAll.
let toolsByServer: Record<string, McpToolInfo[]> = {};
let callToolResults: Record<string, unknown> = {};
const createdInstances: Record<
  string,
  {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    onToolsChanged: ReturnType<typeof vi.fn>;
    serverName: string;
  }
> = {};

vi.mock('../src/mcp/mcp-client-connection.js', () => {
  // Use a real class so vitest recognises the constructor pattern
  class MockMcpClientConnection {
    serverName: string;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    onToolsChanged: ReturnType<typeof vi.fn>;

    constructor(config: McpServerConfig) {
      this.serverName = config.name;
      this.connect = vi.fn().mockResolvedValue(undefined);
      this.disconnect = vi.fn().mockResolvedValue(undefined);
      this.listTools = vi.fn().mockImplementation(async () => toolsByServer[config.name] ?? []);
      this.callTool = vi.fn().mockImplementation(async () => callToolResults[config.name] ?? { ok: true });
      this.onToolsChanged = vi.fn();
      createdInstances[config.name] = this;
    }
  }

  return { McpClientConnection: MockMcpClientConnection };
});

import { McpClientManager } from '../src/mcp/mcp-client-manager.js';
import { ToolRegistry } from '../src/registry.js';

const serverConfigs: McpServerConfig[] = [
  {
    name: 'search',
    transport: 'stdio',
    command: '/usr/bin/search-server',
    args: [],
  },
  {
    name: 'calendar',
    transport: 'stdio',
    command: '/usr/bin/calendar-server',
    args: [],
  },
];

describe('McpClientManager', () => {
  let registry: ToolRegistry;
  let manager: McpClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared state
    toolsByServer = {};
    callToolResults = {};
    for (const key of Object.keys(createdInstances)) {
      delete createdInstances[key];
    }

    registry = new ToolRegistry();
    manager = new McpClientManager(serverConfigs, registry);
  });

  // ── connectAll ──────────────────────────────────────────────────────

  describe('connectAll', () => {
    it('creates connections and discovers tools', async () => {
      toolsByServer = {
        search: [
          { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object' } },
        ],
        calendar: [
          { name: 'get_events', description: 'Get calendar events', inputSchema: { type: 'object' } },
          { name: 'create_event', description: 'Create a calendar event', inputSchema: { type: 'object' } },
        ],
      };

      await manager.connectAll();

      // Verify tools were registered in the registry
      expect(registry.has('search__web_search')).toBe(true);
      expect(registry.has('calendar__get_events')).toBe(true);
      expect(registry.has('calendar__create_event')).toBe(true);
    });
  });

  // ── Tool namespacing ────────────────────────────────────────────────

  describe('tool namespacing', () => {
    it('namespaces tool names as serverName__toolName', async () => {
      toolsByServer = {
        search: [{ name: 'my_tool', description: 'A tool', inputSchema: { type: 'object' } }],
        calendar: [{ name: 'my_tool', description: 'A tool', inputSchema: { type: 'object' } }],
      };

      await manager.connectAll();

      const tools = manager.getAllTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain('search__my_tool');
      expect(toolNames).toContain('calendar__my_tool');
    });
  });

  // ── callTool ────────────────────────────────────────────────────────

  describe('callTool', () => {
    it('routes to the correct server and strips namespace', async () => {
      toolsByServer = {
        search: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object' } }],
        calendar: [{ name: 'get_events', description: 'Events', inputSchema: { type: 'object' } }],
      };
      callToolResults = {
        search: { results: ['result1'] },
      };

      await manager.connectAll();

      const result = await manager.callTool('search__web_search', { query: 'test' });

      expect(result).toEqual({ results: ['result1'] });
      // Verify the original (non-namespaced) name was used
      expect(createdInstances['search']!.callTool).toHaveBeenCalledWith(
        'web_search',
        { query: 'test' },
      );
    });

    it('throws for unknown namespaced tool name', async () => {
      await expect(
        manager.callTool('nonexistent__tool', {}),
      ).rejects.toThrow(/No MCP tool registered/);
    });
  });

  // ── disconnect ──────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('removes tools from registry when server is disconnected', async () => {
      toolsByServer = {
        search: [{ name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } }],
        calendar: [{ name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } }],
      };

      await manager.connectAll();

      expect(registry.has('search__tool_a')).toBe(true);
      expect(registry.has('calendar__tool_a')).toBe(true);

      await manager.disconnect('search');

      expect(registry.has('search__tool_a')).toBe(false);
      // Calendar tools should remain
      expect(registry.has('calendar__tool_a')).toBe(true);
    });
  });

  // ── getAllTools ──────────────────────────────────────────────────────

  describe('getAllTools', () => {
    it('returns all discovered tools', async () => {
      toolsByServer = {
        search: [{ name: 'find', description: 'Find things', inputSchema: { type: 'object' } }],
        calendar: [{ name: 'list', description: 'List events', inputSchema: { type: 'object' } }],
      };

      await manager.connectAll();

      const allTools = manager.getAllTools();

      expect(allTools).toHaveLength(2);
      expect(allTools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['search__find', 'calendar__list']),
      );
      expect(allTools.find((t) => t.name === 'search__find')!.serverName).toBe('search');
      expect(allTools.find((t) => t.name === 'calendar__list')!.serverName).toBe('calendar');
    });
  });
});
