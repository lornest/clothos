import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '@clothos/core';
import { discoverSkills, mergeSkillSources } from '../src/skill-discovery.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('mergeSkillSources', () => {
  it('merges sources with later sources overriding by name', () => {
    const bundled = [
      { name: 'commit', description: 'bundled', filePath: '/bundled/commit/SKILL.md', metadata: {} },
    ];
    const user = [
      { name: 'commit', description: 'user override', filePath: '/user/commit/SKILL.md', metadata: {} },
      { name: 'review', description: 'user', filePath: '/user/review/SKILL.md', metadata: {} },
    ];
    const result = mergeSkillSources(bundled, user);
    expect(result).toHaveLength(2);
    const commit = result.find((s) => s.name === 'commit');
    expect(commit!.description).toBe('user override');
  });

  it('returns empty array for no sources', () => {
    expect(mergeSkillSources()).toEqual([]);
  });

  it('handles single source', () => {
    const skills = [
      { name: 'a', description: 'desc', filePath: '/a/SKILL.md', metadata: {} },
    ];
    expect(mergeSkillSources(skills)).toEqual(skills);
  });
});

describe('discoverSkills', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-discovery-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createSkill(
    dir: string,
    name: string,
    content: string,
  ): Promise<void> {
    const skillDir = join(dir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), content);
  }

  it('discovers skills from a directory', async () => {
    await createSkill(tempDir, 'commit', `---
name: commit
description: Git commit helper
---
# Commit`);

    const result = await discoverSkills({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('commit');
    expect(result[0]!.description).toBe('Git commit helper');
  });

  it('handles empty directory', async () => {
    const result = await discoverSkills({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });
    expect(result).toHaveLength(0);
  });

  it('handles non-existent directory', async () => {
    const result = await discoverSkills({
      directories: ['/non-existent-12345'],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });
    expect(result).toHaveLength(0);
  });

  it('handles empty directories array', async () => {
    const result = await discoverSkills({
      directories: [],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });
    expect(result).toHaveLength(0);
  });

  it('respects disabled list', async () => {
    await createSkill(tempDir, 'commit', `---
name: commit
description: Commit helper
---
Content`);
    await createSkill(tempDir, 'review', `---
name: review
description: Review helper
---
Content`);

    const result = await discoverSkills({
      directories: [tempDir],
      enabled: [],
      disabled: ['commit'],
      logger: makeLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('review');
  });

  it('respects enabled list', async () => {
    await createSkill(tempDir, 'commit', `---
name: commit
description: Commit helper
---
Content`);
    await createSkill(tempDir, 'review', `---
name: review
description: Review helper
---
Content`);

    const result = await discoverSkills({
      directories: [tempDir],
      enabled: ['commit'],
      disabled: [],
      logger: makeLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('commit');
  });

  it('merges multiple directories with precedence', async () => {
    const bundledDir = await mkdtemp(join(tmpdir(), 'skill-bundled-'));
    try {
      await createSkill(bundledDir, 'commit', `---
name: commit
description: bundled commit
---
Content`);
      await createSkill(tempDir, 'commit', `---
name: commit
description: workspace commit
---
Content`);

      const result = await discoverSkills({
        directories: [bundledDir, tempDir],
        enabled: [],
        disabled: [],
        logger: makeLogger(),
      });

      expect(result).toHaveLength(1);
      // Later directory (workspace) should override earlier (bundled)
      expect(result[0]!.description).toBe('workspace commit');
    } finally {
      await rm(bundledDir, { recursive: true, force: true });
    }
  });

  it('filters skills with unsatisfied requirements', async () => {
    await createSkill(tempDir, 'gated', `---
name: gated
description: Requires missing binary
requiredBinaries:
  - not-a-real-binary-xyz123
---
Content`);

    await createSkill(tempDir, 'available', `---
name: available
description: No requirements
---
Content`);

    const result = await discoverSkills({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('available');
  });

  it('skips non-directory entries', async () => {
    await writeFile(join(tempDir, 'not-a-dir.txt'), 'just a file');
    const result = await discoverSkills({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });
    expect(result).toHaveLength(0);
  });

  it('skips directories without SKILL.md', async () => {
    await mkdir(join(tempDir, 'no-skill'), { recursive: true });
    await writeFile(join(tempDir, 'no-skill', 'README.md'), '# Readme');
    const result = await discoverSkills({
      directories: [tempDir],
      enabled: [],
      disabled: [],
      logger: makeLogger(),
    });
    expect(result).toHaveLength(0);
  });
});
