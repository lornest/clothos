import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillEntry } from '@clothos/core';
import type { SkillDiscoveryOptions } from './types.js';
import { parseSkillFile } from './skill-parser.js';
import { filterAvailableSkills } from './skill-gating.js';

const SKILL_FILENAME = 'SKILL.md';

/**
 * Scan a single directory for skill subdirectories containing SKILL.md files.
 */
async function scanSkillDirectory(
  dir: string,
): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);

    // Verify it's a directory
    try {
      const s = await stat(skillDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillPath = join(skillDir, SKILL_FILENAME);
    let content: string;
    try {
      content = await readFile(skillPath, 'utf-8');
    } catch {
      continue;
    }

    skills.push(parseSkillFile(content, skillPath));
  }

  return skills;
}

/**
 * Merge multiple skill sources. Later sources override earlier ones by name.
 * Priority: bundled < user < workspace.
 */
export function mergeSkillSources(...sources: SkillEntry[][]): SkillEntry[] {
  const map = new Map<string, SkillEntry>();
  for (const source of sources) {
    for (const skill of source) {
      map.set(skill.name, skill);
    }
  }
  return [...map.values()];
}

/**
 * Filter skills by enabled/disabled config lists.
 * Disabled takes precedence. Empty enabled list means all are enabled.
 */
function filterByConfig(
  skills: SkillEntry[],
  enabled: string[],
  disabled: string[],
): SkillEntry[] {
  return skills.filter((skill) => {
    if (disabled.includes(skill.name)) return false;
    if (enabled.length === 0) return true;
    return enabled.includes(skill.name);
  });
}

/**
 * Discover skills from multiple directories, merge with precedence,
 * apply config filtering, and gate on requirements.
 */
export async function discoverSkills(
  options: SkillDiscoveryOptions,
): Promise<SkillEntry[]> {
  const sources: SkillEntry[][] = [];

  for (const dir of options.directories) {
    sources.push(await scanSkillDirectory(dir));
  }

  let skills = mergeSkillSources(...sources);
  skills = filterByConfig(skills, options.enabled, options.disabled);
  skills = filterAvailableSkills(skills, options.logger);

  return skills;
}
