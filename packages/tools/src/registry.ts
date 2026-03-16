import type {
  ToolDefinition,
  ToolHandler,
  ToolHandlerMap,
  ToolRegistryEntry,
  ToolSource,
} from '@clothos/core';
import { ToolConflictError } from './errors.js';

/**
 * Central in-memory tool registry.
 * Single source of truth for all tool registrations (builtin, MCP, plugin, memory).
 */
export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>();

  /** Register a tool. Throws ToolConflictError on duplicate name. */
  register(
    definition: ToolDefinition,
    handler: ToolHandler,
    source: ToolSource,
    mcpServer?: string,
  ): void {
    if (this.entries.has(definition.name)) {
      throw new ToolConflictError(definition.name);
    }
    this.entries.set(definition.name, { definition, handler, source, mcpServer });
  }

  /** Remove a tool by name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /** Get a registry entry by name, or undefined. */
  get(name: string): ToolRegistryEntry | undefined {
    return this.entries.get(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Get all registry entries. */
  getAll(): ToolRegistryEntry[] {
    return [...this.entries.values()];
  }

  /** Get entries filtered by source. */
  getBySource(source: ToolSource): ToolRegistryEntry[] {
    return this.getAll().filter((e) => e.source === source);
  }

  /** Build a ToolHandlerMap compatible with executeToolCall(). */
  buildHandlerMap(names?: string[]): ToolHandlerMap {
    const map: ToolHandlerMap = new Map();
    if (names) {
      for (const name of names) {
        const entry = this.entries.get(name);
        if (entry) {
          map.set(name, entry.handler);
        }
      }
    } else {
      for (const [name, entry] of this.entries) {
        map.set(name, entry.handler);
      }
    }
    return map;
  }

  /** Get ToolDefinition[] for LLM context. */
  getDefinitions(names?: string[]): ToolDefinition[] {
    if (names) {
      const defs: ToolDefinition[] = [];
      for (const name of names) {
        const entry = this.entries.get(name);
        if (entry) {
          defs.push(entry.definition);
        }
      }
      return defs;
    }
    return this.getAll().map((e) => e.definition);
  }

  /** Remove all entries. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of registered tools. */
  get size(): number {
    return this.entries.size;
  }
}
