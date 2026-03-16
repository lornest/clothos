import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { Logger, SkillEntry } from '@clothos/core';

/** Check if a binary is available on the system PATH. */
export function isBinaryAvailable(name: string): boolean {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check if an environment variable is set. */
export function isEnvVarSet(name: string): boolean {
  return name in process.env && process.env[name] !== '';
}

/** Result of checking a skill's requirements. */
export type SkillCheckResult =
  | { available: true }
  | { available: false; reason: string };

/** Check whether a skill's metadata requirements are satisfied. */
export function checkSkillRequirements(skill: SkillEntry): SkillCheckResult {
  const { metadata } = skill;

  // Check OS platforms
  if (metadata.osPlatforms && metadata.osPlatforms.length > 0) {
    const currentPlatform = platform();
    if (!metadata.osPlatforms.includes(currentPlatform)) {
      return {
        available: false,
        reason: `requires OS: ${metadata.osPlatforms.join(', ')} (current: ${currentPlatform})`,
      };
    }
  }

  // Check required binaries
  if (metadata.requiredBinaries) {
    for (const bin of metadata.requiredBinaries) {
      if (!isBinaryAvailable(bin)) {
        return {
          available: false,
          reason: `required binary "${bin}" not found`,
        };
      }
    }
  }

  // Check required environment variables
  if (metadata.requiredEnvVars) {
    for (const envVar of metadata.requiredEnvVars) {
      if (!isEnvVarSet(envVar)) {
        return {
          available: false,
          reason: `required environment variable "${envVar}" not set`,
        };
      }
    }
  }

  return { available: true };
}

/**
 * Filter a list of skills to only those whose requirements are met.
 * Logs warnings for skills that are skipped.
 */
export function filterAvailableSkills(
  skills: SkillEntry[],
  logger: Logger,
): SkillEntry[] {
  return skills.filter((skill) => {
    const result = checkSkillRequirements(skill);
    if (!result.available) {
      logger.warn(`Skill "${skill.name}" unavailable: ${result.reason}`);
      return false;
    }
    return true;
  });
}
