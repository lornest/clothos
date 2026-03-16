import type { ToolDefinition, ToolHandler, PolicyContext } from '@clothos/core';
import type { McpClientManager } from './mcp-client-manager.js';
import type { PolicyEngine } from '../policy-engine.js';
import { validateToolArgs, formatValidationErrors } from './schema-validator.js';

/**
 * Meta-tool definition that lets LLMs invoke any MCP tool via a single
 * unified interface. The LLM provides the namespaced tool name and
 * arguments; this handler validates, authorizes, and routes the call.
 */
export const useMcpToolDefinition: ToolDefinition = {
  name: 'use_mcp_tool',
  description:
    'Invoke an MCP tool by name. Use the MCP catalog in the system prompt to find available tools.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: 'The namespaced MCP tool name (e.g. server__tool)',
      },
      arguments: {
        type: 'object',
        description: 'Arguments to pass to the tool',
      },
    },
    required: ['tool_name'],
  },
  annotations: {
    readOnly: false,
    riskLevel: 'yellow',
  },
};

/**
 * Creates the handler for the `use_mcp_tool` meta-tool.
 *
 * @param mcpManager - Manages MCP server connections and tool routing
 * @param policyEngine - Checks if a tool is allowed for the current context
 * @param getContext - Returns the current PolicyContext (agentId, sessionId, etc.)
 */
export function createUseMcpToolHandler(
  mcpManager: McpClientManager,
  policyEngine: PolicyEngine,
  getContext: () => PolicyContext,
): ToolHandler {
  return async (args: Record<string, unknown>): Promise<unknown> => {
    const toolName = args.tool_name as string | undefined;
    if (!toolName) {
      return { error: 'Missing required argument: tool_name' };
    }

    const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
    const ctx = getContext();

    // Policy check
    if (!policyEngine.isAllowed(toolName, ctx)) {
      return {
        error: `Tool "${toolName}" is not allowed for agent "${ctx.agentId}"`,
      };
    }

    // Schema validation
    const schema = mcpManager.getToolSchema(toolName);
    if (schema) {
      const validation = validateToolArgs(toolArgs, schema);
      if (!validation.valid) {
        return {
          error: formatValidationErrors(validation.errors, schema),
        };
      }
    }

    // Route the call
    try {
      const result = await mcpManager.callTool(toolName, toolArgs);
      return result;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
