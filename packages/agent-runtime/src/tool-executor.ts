import type { ToolCall, ToolDefinition, ToolResult, ToolHandler, ToolHandlerMap } from '@clothos/core';

export type { ToolHandler, ToolHandlerMap };

export async function executeToolCall(
  call: ToolCall,
  handlers: ToolHandlerMap,
): Promise<ToolResult> {
  const start = performance.now();

  const handler = handlers.get(call.name);
  if (!handler) {
    return {
      success: false,
      output: null,
      error: `Unknown tool: ${call.name}`,
      durationMs: Math.round(performance.now() - start),
    };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return {
      success: false,
      output: null,
      error: `Invalid JSON arguments: ${call.arguments}`,
      durationMs: Math.round(performance.now() - start),
    };
  }

  try {
    const output = await handler(args);
    return {
      success: true,
      output,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      success: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - start),
    };
  }
}

export function buildToolHandlerMap(
  tools: ToolDefinition[],
  registry: Map<string, ToolHandler>,
): ToolHandlerMap {
  const map: ToolHandlerMap = new Map();
  for (const tool of tools) {
    const handler = registry.get(tool.name);
    if (handler) {
      map.set(tool.name, handler);
    }
  }
  return map;
}
