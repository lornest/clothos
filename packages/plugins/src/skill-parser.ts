import { parse as parseYaml } from 'yaml';
import { basename, dirname } from 'node:path';
import type { SkillEntry, SkillMetadata } from '@clothos/core';

/**
 * Extract YAML frontmatter from a markdown string.
 * Frontmatter is delimited by `---` at the start.
 */
export function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};

  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Parse a SKILL.md file's content into a SkillEntry.
 * Falls back to the parent directory name for `name` if frontmatter is missing.
 */
export function parseSkillFile(content: string, filePath: string): SkillEntry {
  const frontmatter = extractFrontmatter(content);

  const dirName = basename(dirname(filePath));

  const name = typeof frontmatter['name'] === 'string'
    ? frontmatter['name']
    : dirName;

  const description = typeof frontmatter['description'] === 'string'
    ? frontmatter['description']
    : '';

  const metadata: SkillMetadata = {};

  if (Array.isArray(frontmatter['requiredBinaries'])) {
    metadata.requiredBinaries = frontmatter['requiredBinaries'].filter(
      (b): b is string => typeof b === 'string',
    );
  }

  if (Array.isArray(frontmatter['requiredEnvVars'])) {
    metadata.requiredEnvVars = frontmatter['requiredEnvVars'].filter(
      (v): v is string => typeof v === 'string',
    );
  }

  if (Array.isArray(frontmatter['osPlatforms'])) {
    metadata.osPlatforms = frontmatter['osPlatforms'].filter(
      (p): p is string => typeof p === 'string',
    );
  }

  return { name, description, filePath, metadata };
}
