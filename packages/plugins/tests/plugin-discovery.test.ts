import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '@clothos/core';
import { discoverPlugins } from '../src/plugin-discovery.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('discoverPlugins', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plugin-discovery-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createPluginDir(
    name: string,
    manifest: Record<string, unknown>,
    entry = 'dist/index.js',
  ): Promise<string> {
    const pluginDir = join(tempDir, name);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: `@test/${name}`,
        version: '1.0.0',
        clothos: {
          entry,
          manifest,
        },
      }),
    );
    return pluginDir;
  }

  it('discovers plugins in a directory', async () => {
    await createPluginDir('my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A test plugin',
    });

    const result = await discoverPlugins([tempDir], [], [], makeLogger());
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe('my-plugin');
  });

  it('skips directories without package.json', async () => {
    await mkdir(join(tempDir, 'no-pkg'), { recursive: true });
    const result = await discoverPlugins([tempDir], [], [], makeLogger());
    expect(result).toHaveLength(0);
  });

  it('skips packages without clothos field', async () => {
    const pluginDir = join(tempDir, 'plain-pkg');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'plain', version: '1.0.0' }),
    );
    const result = await discoverPlugins([tempDir], [], [], makeLogger());
    expect(result).toHaveLength(0);
  });

  it('respects disabled list', async () => {
    await createPluginDir('my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'Test',
    });
    const result = await discoverPlugins([tempDir], [], ['my-plugin'], makeLogger());
    expect(result).toHaveLength(0);
  });

  it('respects enabled list', async () => {
    await createPluginDir('plugin-a', {
      name: 'plugin-a',
      version: '1.0.0',
      description: 'A',
    });
    await createPluginDir('plugin-b', {
      name: 'plugin-b',
      version: '1.0.0',
      description: 'B',
    });
    const result = await discoverPlugins([tempDir], ['plugin-a'], [], makeLogger());
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe('plugin-a');
  });

  it('disabled takes precedence over enabled', async () => {
    await createPluginDir('my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'Test',
    });
    const result = await discoverPlugins(
      [tempDir],
      ['my-plugin'],
      ['my-plugin'],
      makeLogger(),
    );
    expect(result).toHaveLength(0);
  });

  it('handles non-existent directory gracefully', async () => {
    const logger = makeLogger();
    const result = await discoverPlugins(['/non-existent-path-12345'], [], [], logger);
    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('discovers plugins from multiple directories', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'plugin-discovery-2-'));
    try {
      await createPluginDir('plugin-a', {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'A',
      });

      const pluginDir2 = join(dir2, 'plugin-b');
      await mkdir(pluginDir2, { recursive: true });
      await writeFile(
        join(pluginDir2, 'package.json'),
        JSON.stringify({
          name: '@test/plugin-b',
          version: '1.0.0',
          clothos: {
            entry: 'dist/index.js',
            manifest: { name: 'plugin-b', version: '1.0.0', description: 'B' },
          },
        }),
      );

      const result = await discoverPlugins([tempDir, dir2], [], [], makeLogger());
      expect(result).toHaveLength(2);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('resolves entry path relative to plugin directory', async () => {
    await createPluginDir('my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'Test',
    }, 'src/main.js');

    const result = await discoverPlugins([tempDir], [], [], makeLogger());
    expect(result[0]!.entryPath).toContain('src/main.js');
  });

  it('empty enabled list means all plugins are enabled', async () => {
    await createPluginDir('plugin-a', {
      name: 'plugin-a',
      version: '1.0.0',
      description: 'A',
    });
    await createPluginDir('plugin-b', {
      name: 'plugin-b',
      version: '1.0.0',
      description: 'B',
    });
    const result = await discoverPlugins([tempDir], [], [], makeLogger());
    expect(result).toHaveLength(2);
  });
});
