import type { McpServerConfig, ToolDefinition, ToolHandler } from '@clothos/core';
import type { ToolRegistry } from '../registry.js';
import { McpClientConnection, type McpToolInfo } from './mcp-client-connection.js';
import { McpConnectionError } from '../errors.js';

/** Namespace separator used between server name and tool name. */
const NAMESPACE_SEP = '__';

/** Summary of a discovered MCP tool. */
export interface McpToolSummary {
  name: string;
  description: string;
  serverName: string;
}

/**
 * Manages connections to multiple MCP servers.
 * Discovers tools from each server, registers them in the ToolRegistry
 * with namespaced names (`{serverName}__{toolName}`), and routes
 * tool calls to the correct backend connection.
 */
export class McpClientManager {
  private readonly connections = new Map<string, McpClientConnection>();
  private readonly toolMap = new Map<string, { serverName: string; originalName: string; info: McpToolInfo }>();

  constructor(
    private readonly configs: McpServerConfig[],
    private readonly registry: ToolRegistry,
  ) {}

  /** Connect to all configured MCP servers, discover tools, and register them. */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.configs.map((config) => this.connect(config)),
    );

    // Collect errors but don't fail the whole batch
    const errors: Error[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
        );
      }
    }

    if (errors.length > 0 && errors.length === this.configs.length) {
      throw new McpConnectionError(
        'all',
        `All ${errors.length} MCP server connections failed`,
      );
    }
  }

  /** Connect a single MCP server, discover its tools, and register them. */
  async connect(config: McpServerConfig): Promise<void> {
    const connection = new McpClientConnection(config);
    await connection.connect();

    this.connections.set(config.name, connection);

    // Discover and register tools
    await this.discoverAndRegister(connection);

    // Set up hot-reload on tool list changes
    connection.onToolsChanged(() => {
      void this.refreshTools(config.name);
    });
  }

  /** Disconnect a server and unregister all its tools. */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    // Unregister all tools from this server
    for (const [namespacedName, entry] of this.toolMap) {
      if (entry.serverName === serverName) {
        this.registry.unregister(namespacedName);
        this.toolMap.delete(namespacedName);
      }
    }

    await connection.disconnect();
    this.connections.delete(serverName);
  }

  /** Disconnect all MCP servers and unregister their tools. */
  async disconnectAll(): Promise<void> {
    const serverNames = [...this.connections.keys()];
    await Promise.allSettled(
      serverNames.map((name) => this.disconnect(name)),
    );
  }

  /**
   * Route a tool call to the correct MCP backend, stripping the namespace prefix.
   * @param namespacedName Full namespaced tool name (`server__tool`)
   * @param args Arguments to pass to the tool
   */
  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.toolMap.get(namespacedName);
    if (!entry) {
      throw new McpConnectionError('unknown', `No MCP tool registered: ${namespacedName}`);
    }

    const connection = this.connections.get(entry.serverName);
    if (!connection) {
      throw new McpConnectionError(entry.serverName, 'Server not connected');
    }

    return connection.callTool(entry.originalName, args);
  }

  /** Return all discovered MCP tools (namespaced). */
  getAllTools(): McpToolSummary[] {
    const tools: McpToolSummary[] = [];
    for (const [namespacedName, entry] of this.toolMap) {
      tools.push({
        name: namespacedName,
        description: entry.info.description,
        serverName: entry.serverName,
      });
    }
    return tools;
  }

  /** Get the input schema for a namespaced tool. */
  getToolSchema(namespacedName: string): Record<string, unknown> | undefined {
    return this.toolMap.get(namespacedName)?.info.inputSchema;
  }

  /** Discover tools from a connection and register them in the registry. */
  private async discoverAndRegister(connection: McpClientConnection): Promise<void> {
    const tools = await connection.listTools();

    for (const tool of tools) {
      const namespacedName = `${connection.serverName}${NAMESPACE_SEP}${tool.name}`;

      const definition: ToolDefinition = {
        name: namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          riskLevel: 'yellow',
        },
      };

      const handler: ToolHandler = async (args: Record<string, unknown>) => {
        return connection.callTool(tool.name, args);
      };

      this.toolMap.set(namespacedName, {
        serverName: connection.serverName,
        originalName: tool.name,
        info: tool,
      });

      // Only register if not already present (e.g. during refresh)
      if (!this.registry.has(namespacedName)) {
        this.registry.register(definition, handler, 'mcp', connection.serverName);
      }
    }
  }

  /** Refresh tools after a list_changed notification. */
  private async refreshTools(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    // Unregister existing tools for this server
    for (const [namespacedName, entry] of this.toolMap) {
      if (entry.serverName === serverName) {
        this.registry.unregister(namespacedName);
        this.toolMap.delete(namespacedName);
      }
    }

    // Re-discover and register
    await this.discoverAndRegister(connection);
  }
}
