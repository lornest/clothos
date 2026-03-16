import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger, SkillEntry } from '@clothos/core';
import {
  checkSkillRequirements,
  filterAvailableSkills,
  isBinaryAvailable,
  isEnvVarSet,
} from '../src/skill-gating.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: 'test-skill',
    description: 'A test skill',
    filePath: '/skills/test/SKILL.md',
    metadata: {},
    ...overrides,
  };
}

describe('isBinaryAvailable', () => {
  it('returns true for a known binary', () => {
    // 'node' should be available in any test environment
    expect(isBinaryAvailable('node')).toBe(true);
  });

  it('returns false for a non-existent binary', () => {
    expect(isBinaryAvailable('definitely-not-a-real-binary-xyz123')).toBe(false);
  });
});

describe('isEnvVarSet', () => {
  it('returns true for a set environment variable', () => {
    process.env['TEST_SKILL_VAR'] = 'hello';
    expect(isEnvVarSet('TEST_SKILL_VAR')).toBe(true);
    delete process.env['TEST_SKILL_VAR'];
  });

  it('returns false for an unset environment variable', () => {
    delete process.env['DEFINITELY_NOT_SET_XYZ'];
    expect(isEnvVarSet('DEFINITELY_NOT_SET_XYZ')).toBe(false);
  });

  it('returns false for empty string environment variable', () => {
    process.env['EMPTY_VAR'] = '';
    expect(isEnvVarSet('EMPTY_VAR')).toBe(false);
    delete process.env['EMPTY_VAR'];
  });
});

describe('checkSkillRequirements', () => {
  it('returns available when no requirements', () => {
    const skill = makeSkill();
    const result = checkSkillRequirements(skill);
    expect(result.available).toBe(true);
  });

  it('returns available when binary exists', () => {
    const skill = makeSkill({ metadata: { requiredBinaries: ['node'] } });
    const result = checkSkillRequirements(skill);
    expect(result.available).toBe(true);
  });

  it('returns unavailable when binary is missing', () => {
    const skill = makeSkill({
      metadata: { requiredBinaries: ['not-a-real-binary-xyz'] },
    });
    const result = checkSkillRequirements(skill);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain('not-a-real-binary-xyz');
  });

  it('returns unavailable when env var is not set', () => {
    delete process.env['MISSING_SKILL_ENV'];
    const skill = makeSkill({
      metadata: { requiredEnvVars: ['MISSING_SKILL_ENV'] },
    });
    const result = checkSkillRequirements(skill);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain('MISSING_SKILL_ENV');
  });

  it('returns available when env var is set', () => {
    process.env['PRESENT_SKILL_ENV'] = 'yes';
    const skill = makeSkill({
      metadata: { requiredEnvVars: ['PRESENT_SKILL_ENV'] },
    });
    const result = checkSkillRequirements(skill);
    expect(result.available).toBe(true);
    delete process.env['PRESENT_SKILL_ENV'];
  });

  it('checks OS platform', () => {
    const currentPlatform = process.platform;
    const skill = makeSkill({
      metadata: { osPlatforms: [currentPlatform] },
    });
    expect(checkSkillRequirements(skill).available).toBe(true);

    const wrongPlatform = makeSkill({
      metadata: { osPlatforms: ['aix'] }, // Unlikely to be running on AIX
    });
    const result = checkSkillRequirements(wrongPlatform);
    expect(result.available).toBe(false);
  });

  it('checks OS platform before binaries', () => {
    const skill = makeSkill({
      metadata: {
        osPlatforms: ['aix'],
        requiredBinaries: ['node'],
      },
    });
    const result = checkSkillRequirements(skill);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain('OS');
  });
});

describe('filterAvailableSkills', () => {
  it('keeps skills with no requirements', () => {
    const skills = [makeSkill({ name: 'a' }), makeSkill({ name: 'b' })];
    const result = filterAvailableSkills(skills, makeLogger());
    expect(result).toHaveLength(2);
  });

  it('filters out skills with missing requirements', () => {
    const skills = [
      makeSkill({ name: 'good' }),
      makeSkill({
        name: 'bad',
        metadata: { requiredBinaries: ['not-a-real-binary-xyz'] },
      }),
    ];
    const result = filterAvailableSkills(skills, makeLogger());
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('good');
  });

  it('logs warnings for filtered skills', () => {
    const logger = makeLogger();
    const skills = [
      makeSkill({
        name: 'unavailable',
        metadata: { requiredBinaries: ['not-a-real-binary-xyz'] },
      }),
    ];
    filterAvailableSkills(skills, logger);
    expect(logger.warn).toHaveBeenCalled();
  });
});
