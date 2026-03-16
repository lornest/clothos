import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger, Plugin, PluginManifest } from '@clothos/core';
import type { PluginLoaderCallbacks } from '../src/types.js';
import { PluginLoader } from '../src/plugin-loader.js';
import { PluginLoadError } from '../src/errors.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCallbacks(): PluginLoaderCallbacks {
  return {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
    registerHook: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    getService: vi.fn(),
  };
}

describe('PluginLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plugin-loader-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createPluginModule(
    name: string,
    manifest: PluginManifest,
    onLoadBody = '',
    onUnloadBody = '',
  ): Promise<string> {
    const pluginDir = join(tempDir, name);
    await mkdir(join(pluginDir, 'dist'), { recursive: true });

    // Create the actual JS module
    await writeFile(
      join(pluginDir, 'dist', 'index.js'),
      `
export default {
  manifest: ${JSON.stringify(manifest)},
  async onLoad(ctx) {
    ${onLoadBody}
  },
  async onUnload() {
    ${onUnloadBody}
  },
};
`,
    );

    // Create package.json with clothos field
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: `@test/${name}`,
        version: manifest.version,
        clothos: {
          entry: 'dist/index.js',
          manifest,
        },
      }),
    );

    return pluginDir;
  }

  it('loadAll discovers and loads plugins', async () => {
    await createPluginModule('test-plugin', {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
    });

    const logger = makeLogger();
    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger,
    });

    await loader.loadAll();
    expect(loader.isLoaded('test-plugin')).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('loaded successfully'));
  });

  it('loadPlugin imports and initializes a plugin', async () => {
    const pluginDir = await createPluginModule('my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'Test',
    });

    const logger = makeLogger();
    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger,
    });

    await loader.loadPlugin(
      'my-plugin',
      join(pluginDir, 'dist', 'index.js'),
      pluginDir,
    );

    expect(loader.isLoaded('my-plugin')).toBe(true);
  });

  it('unloadPlugin removes a loaded plugin', async () => {
    const pluginDir = await createPluginModule('my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'Test',
    });

    const callbacks = makeCallbacks();
    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks,
      logger: makeLogger(),
    });

    await loader.loadPlugin(
      'my-plugin',
      join(pluginDir, 'dist', 'index.js'),
      pluginDir,
    );

    expect(loader.isLoaded('my-plugin')).toBe(true);
    await loader.unloadPlugin('my-plugin');
    expect(loader.isLoaded('my-plugin')).toBe(false);
  });

  it('unloadAll removes all plugins', async () => {
    await createPluginModule('plugin-a', {
      name: 'plugin-a',
      version: '1.0.0',
      description: 'A',
    });
    await createPluginModule('plugin-b', {
      name: 'plugin-b',
      version: '1.0.0',
      description: 'B',
    });

    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger: makeLogger(),
    });

    await loader.loadAll();
    expect(loader.getLoadedPlugins().size).toBe(2);

    await loader.unloadAll();
    expect(loader.getLoadedPlugins().size).toBe(0);
  });

  it('handles loadPlugin error gracefully during loadAll', async () => {
    // Create a plugin with invalid JS
    const pluginDir = join(tempDir, 'bad-plugin');
    await mkdir(join(pluginDir, 'dist'), { recursive: true });
    await writeFile(join(pluginDir, 'dist', 'index.js'), 'this is not valid javascript {{{');
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: '@test/bad-plugin',
        version: '1.0.0',
        clothos: {
          entry: 'dist/index.js',
          manifest: { name: 'bad-plugin', version: '1.0.0', description: 'Bad' },
        },
      }),
    );

    const logger = makeLogger();
    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger,
    });

    // Should not throw — logs error and continues
    await loader.loadAll();
    expect(loader.isLoaded('bad-plugin')).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws PluginLoadError for invalid module', async () => {
    const pluginDir = join(tempDir, 'empty-plugin');
    await mkdir(join(pluginDir, 'dist'), { recursive: true });
    await writeFile(
      join(pluginDir, 'dist', 'index.js'),
      'export const notAPlugin = true;',
    );

    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger: makeLogger(),
    });

    await expect(
      loader.loadPlugin(
        'empty-plugin',
        join(pluginDir, 'dist', 'index.js'),
        pluginDir,
      ),
    ).rejects.toThrow(PluginLoadError);
  });

  it('getLoadedPlugins returns a copy of loaded plugins', async () => {
    await createPluginModule('test-plugin', {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test',
    });

    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger: makeLogger(),
    });

    await loader.loadAll();
    const plugins = loader.getLoadedPlugins();
    expect(plugins.size).toBe(1);
    expect(plugins.has('test-plugin')).toBe(true);

    // Should be a copy
    plugins.delete('test-plugin');
    expect(loader.getLoadedPlugins().size).toBe(1);
  });

  it('isLoaded returns false for unknown plugin', () => {
    const loader = new PluginLoader({
      directories: [],
      enabled: [],
      disabled: [],
      callbacks: makeCallbacks(),
      logger: makeLogger(),
    });
    expect(loader.isLoaded('nonexistent')).toBe(false);
  });

  it('respects disabled list during loadAll', async () => {
    await createPluginModule('enabled-plugin', {
      name: 'enabled-plugin',
      version: '1.0.0',
      description: 'Enabled',
    });
    await createPluginModule('disabled-plugin', {
      name: 'disabled-plugin',
      version: '1.0.0',
      description: 'Disabled',
    });

    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: ['disabled-plugin'],
      callbacks: makeCallbacks(),
      logger: makeLogger(),
    });

    await loader.loadAll();
    expect(loader.isLoaded('enabled-plugin')).toBe(true);
    expect(loader.isLoaded('disabled-plugin')).toBe(false);
  });

  it('plugin can register tools via context', async () => {
    await createPluginModule(
      'tool-plugin',
      {
        name: 'tool-plugin',
        version: '1.0.0',
        description: 'Registers a tool',
      },
      `ctx.registerTool(
        { name: "my-tool", description: "A tool", inputSchema: {} },
        async () => "result"
      );`,
    );

    const callbacks = makeCallbacks();
    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks,
      logger: makeLogger(),
    });

    await loader.loadAll();
    expect(callbacks.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-tool' }),
      expect.any(Function),
    );
  });

  it('unregisterTool called when unloading a plugin that registered tools', async () => {
    await createPluginModule(
      'tool-plugin',
      {
        name: 'tool-plugin',
        version: '1.0.0',
        description: 'Tool plugin',
      },
      `ctx.registerTool(
        { name: "unload-tool", description: "Will be unloaded", inputSchema: {} },
        async () => "result"
      );`,
    );

    const callbacks = makeCallbacks();
    const loader = new PluginLoader({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      callbacks,
      logger: makeLogger(),
    });

    await loader.loadAll();
    await loader.unloadPlugin('tool-plugin');
    expect(callbacks.unregisterTool).toHaveBeenCalledWith('unload-tool');
  });
});
