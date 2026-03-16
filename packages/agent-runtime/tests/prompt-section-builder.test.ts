import { describe, it, expect } from 'vitest';
import type { ToolDefinition, SkillEntry } from '@clothos/core';
import type { BootstrapFile } from '../src/prompt-types.js';
import {
  section,
  formatToolsSummary,
  formatSkillsSummary,
  formatBootstrapFiles,
} from '../src/prompt-section-builder.js';

describe('section', () => {
  it('wraps content in XML tags', () => {
    expect(section('foo', 'bar')).toBe('<foo>\nbar\n</foo>');
  });

  it('handles multi-line content', () => {
    const result = section('test', 'line1\nline2');
    expect(result).toBe('<test>\nline1\nline2\n</test>');
  });
});

describe('formatToolsSummary', () => {
  it('returns empty string for no tools', () => {
    expect(formatToolsSummary([])).toBe('');
  });

  it('formats tools as bullet list in XML tags', () => {
    const tools: ToolDefinition[] = [
      { name: 'read', description: 'Read a file', inputSchema: {} },
      { name: 'write', description: 'Write a file', inputSchema: {} },
    ];
    const result = formatToolsSummary(tools);
    expect(result).toBe(
      '<available-tools>\n- read: Read a file\n- write: Write a file\n</available-tools>',
    );
  });
});

describe('formatSkillsSummary', () => {
  it('returns empty string for no skills', () => {
    expect(formatSkillsSummary([])).toBe('');
  });

  it('formats skill entries as bullet list in XML tags', () => {
    const skills: SkillEntry[] = [
      { name: 'commit', description: 'Git commit helper', filePath: '/skills/commit/SKILL.md', metadata: {} },
      { name: 'review', description: 'Code review assistant', filePath: '/skills/review/SKILL.md', metadata: {} },
    ];
    const result = formatSkillsSummary(skills);
    expect(result).toBe(
      '<available-skills>\n' +
      '- commit: Git commit helper (path: /skills/commit/SKILL.md)\n' +
      '- review: Code review assistant (path: /skills/review/SKILL.md)\n' +
      '</available-skills>',
    );
  });
});

describe('formatBootstrapFiles', () => {
  it('returns empty string for no files', () => {
    expect(formatBootstrapFiles([])).toBe('');
  });

  it('wraps each file in its own section tag using lowercased name without extension', () => {
    const files: BootstrapFile[] = [
      { name: 'SOUL.md', content: 'I am helpful.', originalLength: 13, truncated: false },
      { name: 'TOOLS.md', content: 'Use tools.', originalLength: 10, truncated: false },
    ];
    const result = formatBootstrapFiles(files);
    expect(result).toContain('<soul>\nI am helpful.\n</soul>');
    expect(result).toContain('<tools>\nUse tools.\n</tools>');
  });

  it('adds [truncated] marker for truncated files', () => {
    const files: BootstrapFile[] = [
      { name: 'BIG.md', content: 'partial...', originalLength: 50000, truncated: true },
    ];
    const result = formatBootstrapFiles(files);
    expect(result).toContain('[truncated]');
    expect(result).toBe('<big>\npartial...\n[truncated]\n</big>');
  });

  it('does not add [truncated] marker for non-truncated files', () => {
    const files: BootstrapFile[] = [
      { name: 'SMALL.md', content: 'tiny', originalLength: 4, truncated: false },
    ];
    const result = formatBootstrapFiles(files);
    expect(result).not.toContain('[truncated]');
  });
});
