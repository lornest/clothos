import type { McpServerConfig } from '@clothos/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpConnectionError } from '../errors.js';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Wraps a single MCP server connection using the official MCP SDK.
 * Manages transport lifecycle (stdio or SSE) and exposes tool discovery + invocation.
 */
export class McpClientConnection {
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;

  constructor(private readonly config: McpServerConfig) {}

  /** Establish a connection to the MCP server. */
  async connect(): Promise<void> {
    try {
      if (this.config.transport === 'stdio') {
        if (!this.config.command) {
          throw new McpConnectionError(
            this.config.name,
            'stdio transport requires a "command" field',
          );
        }
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env,
        });
      } else if (this.config.transport === 'http-sse') {
        if (!this.config.url) {
          throw new McpConnectionError(
            this.config.name,
            'http-sse transport requires a "url" field',
          );
        }
        this.transport = new StreamableHTTPClientTransport(new URL(this.config.url));
      } else {
        throw new McpConnectionError(
          this.config.name,
          `Unsupported transport: ${String(this.config.transport)}`,
        );
      }

      this.client = new Client(
        { name: this.config.name, version: '1.0.0' },
        { capabilities: {} },
      );

      await this.client.connect(this.transport);
    } catch (error) {
      // If it's already an McpConnectionError, rethrow directly
      if (error instanceof McpConnectionError) {
        throw error;
      }
      throw new McpConnectionError(
        this.config.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Discover all tools exposed by this MCP server. */
  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) {
      throw new McpConnectionError(this.config.name, 'Not connected');
    }

    const result = await this.client.listTools();
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }

  /** Invoke a tool on the MCP server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      throw new McpConnectionError(this.config.name, 'Not connected');
    }

    const result = await this.client.callTool({ name, arguments: args });

    if ('isError' in result && result.isError) {
      const content = 'content' in result ? result.content : result;
      throw new Error(`MCP tool error: ${JSON.stringify(content)}`);
    }

    // The SDK can return either { content: [...] } or { toolResult: unknown }
    if ('content' in result) {
      return result.content;
    }
    if ('toolResult' in result) {
      return result.toolResult;
    }

    return result;
  }

  /** Register a callback for tool list changes (hot-reload). */
  onToolsChanged(callback: () => void): void {
    if (!this.client) return;

    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      () => { callback(); },
    );
  }

  /** Disconnect from the MCP server and release resources. */
  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }

  /** The configured server name. */
  get serverName(): string {
    return this.config.name;
  }
}
