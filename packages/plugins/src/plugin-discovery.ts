import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger, PluginManifest } from '@clothos/core';
import type { DiscoveredPlugin } from './types.js';

/**
 * Checks whether a plugin is enabled given the enabled/disabled lists.
 * Disabled takes precedence. Empty enabled list means all are enabled.
 */
function isPluginEnabled(
  name: string,
  enabled: string[],
  disabled: string[],
): boolean {
  if (disabled.includes(name)) return false;
  if (enabled.length === 0) return true;
  return enabled.includes(name);
}

/**
 * Parses a plugin's package.json to extract its manifest and entry path.
 * Returns null if the package.json doesn't contain an `clothos` field.
 */
async function parsePluginManifest(
  pluginDir: string,
): Promise<DiscoveredPlugin | null> {
  const pkgPath = join(pluginDir, 'package.json');
  let raw: string;
  try {
    raw = await readFile(pkgPath, 'utf-8');
  } catch {
    return null;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const clothos = pkg['clothos'] as
    | { entry?: string; manifest?: PluginManifest }
    | undefined;

  if (!clothos?.manifest) return null;

  const entryPath = resolve(pluginDir, clothos.entry ?? 'dist/index.js');

  return {
    manifest: clothos.manifest,
    entryPath,
    directory: pluginDir,
  };
}

/**
 * Discovers plugins by scanning directories for subdirectories
 * containing package.json files with an `clothos` field.
 */
export async function discoverPlugins(
  directories: string[],
  enabled: string[],
  disabled: string[],
  logger: Logger,
): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = [];

  for (const dir of directories) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      logger.warn(`Plugin directory not found: ${dir}`);
      continue;
    }

    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      const plugin = await parsePluginManifest(pluginDir);

      if (!plugin) continue;

      if (!isPluginEnabled(plugin.manifest.name, enabled, disabled)) {
        logger.debug(`Plugin "${plugin.manifest.name}" is disabled, skipping`);
        continue;
      }

      discovered.push(plugin);
    }
  }

  return discovered;
}
