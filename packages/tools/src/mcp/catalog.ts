import type { ToolDefinition } from '@clothos/core';

/** Build compact catalog for system prompt (excludes pinned tools). */
export function buildMcpCatalog(
  allTools: Array<{ name: string; description: string; serverName: string }>,
  pinnedNames: string[],
): Array<{ name: string; description: string }> {
  return allTools
    .filter((t) => !pinnedNames.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description }));
}

/** Get full ToolDefinitions for pinned MCP tools from registry. */
export function getPinnedToolDefinitions(
  pinnedNames: string[],
  getDefinition: (name: string) => ToolDefinition | undefined,
): ToolDefinition[] {
  return pinnedNames
    .map((name) => getDefinition(name))
    .filter((d): d is ToolDefinition => d !== undefined);
}

/** Format catalog as string for system prompt injection. */
export function formatMcpCatalog(
  catalog: Array<{ name: string; description: string }>,
): string {
  if (catalog.length === 0) return '';

  const lines = catalog.map((t) => `- ${t.name}: ${t.description}`);
  return `<available-mcp-tools>\nUse the use_mcp_tool tool to invoke these:\n${lines.join('\n')}\n</available-mcp-tools>`;
}
