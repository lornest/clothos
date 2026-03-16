import type {
  CommandHandler,
  Disposable,
  HookHandler,
  LifecycleEvent,
  Logger,
  PluginContext,
  ToolDefinition,
  ToolHandler,
} from '@clothos/core';
import type { PluginLoaderCallbacks } from './types.js';

export interface PluginContextResult {
  context: PluginContext;
  registeredTools: string[];
  hookDisposables: Disposable[];
  commandDisposables: Disposable[];
}

/**
 * Creates a scoped PluginContext for a single plugin.
 * Delegates registrations to application-level callbacks and tracks
 * what was registered for cleanup on unload.
 */
export function createPluginContext(
  pluginName: string,
  callbacks: PluginLoaderCallbacks,
  logger: Logger,
  config: Record<string, unknown>,
): PluginContextResult {
  const registeredTools: string[] = [];
  const hookDisposables: Disposable[] = [];
  const commandDisposables: Disposable[] = [];

  const prefix = `[plugin:${pluginName}]`;
  const pluginLogger: Logger = {
    debug: (msg: string, ...args: unknown[]) => logger.debug(`${prefix} ${msg}`, ...args),
    info: (msg: string, ...args: unknown[]) => logger.info(`${prefix} ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => logger.warn(`${prefix} ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => logger.error(`${prefix} ${msg}`, ...args),
  };

  const context: PluginContext = {
    registerTool(def: ToolDefinition, handler: ToolHandler): void {
      callbacks.registerTool(def, handler);
      registeredTools.push(def.name);
    },

    registerHook(event: LifecycleEvent, handler: HookHandler): Disposable {
      const disposable = callbacks.registerHook(event, handler);
      hookDisposables.push(disposable);
      return disposable;
    },

    registerCommand(name: string, handler: CommandHandler): Disposable {
      const disposable = callbacks.registerCommand(name, handler);
      commandDisposables.push(disposable);
      return disposable;
    },

    getService<T>(name: string): T {
      return callbacks.getService<T>(name);
    },

    logger: pluginLogger,
    config,
  };

  return { context, registeredTools, hookDisposables, commandDisposables };
}
