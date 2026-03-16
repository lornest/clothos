import type { Logger, Plugin } from '@clothos/core';
import { PluginLoadError } from './errors.js';
import type { LoadedPlugin, PluginLoaderCallbacks, PluginLoaderOptions } from './types.js';
import { discoverPlugins } from './plugin-discovery.js';
import { resolveDependencyOrder } from './dependency-resolver.js';
import { createPluginContext } from './plugin-context-impl.js';
import { FileWatcher } from './file-watcher.js';

/** Main plugin lifecycle manager. */
export class PluginLoader {
  private loaded = new Map<string, LoadedPlugin>();
  private readonly directories: string[];
  private readonly enabled: string[];
  private readonly disabled: string[];
  private readonly callbacks: PluginLoaderCallbacks;
  private readonly logger: Logger;
  private readonly pluginConfigs: Record<string, Record<string, unknown>>;
  private watcher: FileWatcher | null = null;

  constructor(options: PluginLoaderOptions) {
    this.directories = options.directories;
    this.enabled = options.enabled;
    this.disabled = options.disabled;
    this.callbacks = options.callbacks;
    this.logger = options.logger;
    this.pluginConfigs = options.pluginConfigs ?? {};
  }

  /** Discover → resolve dependency order → load each in order. */
  async loadAll(): Promise<void> {
    const discovered = await discoverPlugins(
      this.directories,
      this.enabled,
      this.disabled,
      this.logger,
    );

    const ordered = resolveDependencyOrder(discovered);

    for (const plugin of ordered) {
      try {
        await this.loadPlugin(plugin.manifest.name, plugin.entryPath, plugin.directory);
      } catch (err) {
        this.logger.error(
          `Failed to load plugin "${plugin.manifest.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Load a single plugin by importing its entry module. */
  async loadPlugin(name: string, entryPath: string, directory: string): Promise<void> {
    if (this.loaded.has(name)) {
      await this.unloadPlugin(name);
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(`${entryPath}?v=${Date.now()}`)) as Record<string, unknown>;
    } catch (err) {
      throw new PluginLoadError(name, err instanceof Error ? err : undefined);
    }

    // Expect default export or `plugin` named export
    const pluginFactory = (mod['default'] ?? mod['plugin']) as Plugin | undefined;
    if (!pluginFactory || typeof pluginFactory.onLoad !== 'function') {
      throw new PluginLoadError(name, new Error('Module does not export a valid Plugin'));
    }

    const pluginConfig = this.pluginConfigs[name] ?? {};
    const { context, registeredTools, hookDisposables, commandDisposables } =
      createPluginContext(name, this.callbacks, this.logger, pluginConfig);

    try {
      await pluginFactory.onLoad(context);
    } catch (err) {
      throw new PluginLoadError(name, err instanceof Error ? err : undefined);
    }

    this.loaded.set(name, {
      manifest: pluginFactory.manifest,
      instance: pluginFactory,
      directory,
      tools: registeredTools,
      hookDisposables,
      commandDisposables,
    });

    this.logger.info(`Plugin "${name}" loaded successfully`);
  }

  /** Unload a plugin: call onUnload, dispose hooks/commands, unregister tools. */
  async unloadPlugin(name: string): Promise<void> {
    const loaded = this.loaded.get(name);
    if (!loaded) return;

    try {
      await loaded.instance.onUnload();
    } catch (err) {
      this.logger.error(
        `Error during onUnload for "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const d of loaded.hookDisposables) {
      d.dispose();
    }
    for (const d of loaded.commandDisposables) {
      d.dispose();
    }
    for (const toolName of loaded.tools) {
      this.callbacks.unregisterTool(toolName);
    }

    this.loaded.delete(name);
    this.logger.info(`Plugin "${name}" unloaded`);
  }

  /** Reload a plugin by unloading and re-importing. */
  async reloadPlugin(name: string, entryPath: string, directory: string): Promise<void> {
    await this.unloadPlugin(name);
    await this.loadPlugin(name, entryPath, directory);
  }

  /** Unload all plugins in reverse dependency order. */
  async unloadAll(): Promise<void> {
    const names = [...this.loaded.keys()].reverse();
    for (const name of names) {
      await this.unloadPlugin(name);
    }
  }

  /** Get all currently loaded plugins. */
  getLoadedPlugins(): Map<string, LoadedPlugin> {
    return new Map(this.loaded);
  }

  /** Check if a plugin is currently loaded. */
  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Enable hot-reload by watching plugin directories. */
  enableHotReload(): void {
    if (this.watcher) return;
    this.watcher = new FileWatcher();

    for (const dir of this.directories) {
      this.watcher.watch(dir, async (changedPath) => {
        // Determine which plugin was affected
        for (const [name, loaded] of this.loaded) {
          if (changedPath.startsWith(loaded.directory)) {
            this.logger.info(`Detected change in plugin "${name}", reloading...`);
            try {
              // Find the entry path from the loaded plugin's directory
              const discovered = await discoverPlugins(
                [loaded.directory.replace(`/${name}`, '')],
                [name],
                [],
                this.logger,
              );
              if (discovered.length > 0) {
                await this.reloadPlugin(name, discovered[0]!.entryPath, loaded.directory);
              }
            } catch (err) {
              this.logger.error(
                `Hot-reload failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            break;
          }
        }
      });
    }
  }

  /** Stop watching for changes. */
  disableHotReload(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
