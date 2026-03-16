import type { HookHandler } from '@clothos/core';

/** Message shape used in the assembled context. */
interface AssembledMessage {
  role: string;
  content: string;
}

/** Minimal assembled context shape for prompt injection. */
interface AssembledContext {
  messages: AssembledMessage[];
}

/**
 * Creates a HookHandler for the `context_assemble` lifecycle event
 * that injects the MCP tool catalog into the system prompt.
 *
 * Follows the same pattern as agent-runtime's `appendToSystemPrompt`:
 * clones the messages array, finds the first system message,
 * and appends the catalog text.
 *
 * @param getCatalogText - Returns the formatted MCP catalog string.
 *   If the string is empty, the context is returned unchanged.
 */
export function createMcpCatalogPromptHandler(
  getCatalogText: () => string,
): HookHandler {
  return (context: unknown): unknown => {
    const catalogText = getCatalogText();
    if (!catalogText) return context;

    const assembled = context as AssembledContext;
    const messages = assembled.messages.map((m, i) => {
      if (i === 0 && m.role === 'system') {
        return { ...m, content: m.content + '\n\n' + catalogText };
      }
      return m;
    });

    return { ...assembled, messages };
  };
}
