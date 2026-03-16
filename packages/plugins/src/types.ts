import type {
  CommandHandler,
  Disposable,
  HookHandler,
  LifecycleEvent,
  Logger,
  Plugin,
  PluginManifest,
  ToolDefinition,
  ToolHandler,
} from '@clothos/core';

/** Pre-load metadata for a discovered plugin. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  entryPath: string;
  directory: string;
}

/** State of a loaded plugin instance. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  instance: Plugin;
  directory: string;
  tools: string[];
  hookDisposables: Disposable[];
  commandDisposables: Disposable[];
}

/** Callbacks from the application layer for wiring plugins into the system. */
export interface PluginLoaderCallbacks {
  registerTool(def: ToolDefinition, handler: ToolHandler): void;
  unregisterTool(name: string): void;
  registerHook(event: LifecycleEvent, handler: HookHandler): Disposable;
  registerCommand(name: string, handler: CommandHandler): Disposable;
  getService<T>(name: string): T;
}

/** Options for the PluginLoader. */
export interface PluginLoaderOptions {
  directories: string[];
  enabled: string[];
  disabled: string[];
  callbacks: PluginLoaderCallbacks;
  logger: Logger;
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

/** Options for skill directory discovery. */
export interface SkillDiscoveryOptions {
  directories: string[];
  enabled: string[];
  disabled: string[];
  logger: Logger;
}

/** Options for the file watcher. */
export interface FileWatcherOptions {
  debounceMs?: number;
  recursive?: boolean;
}
