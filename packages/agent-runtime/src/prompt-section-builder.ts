import type { ToolDefinition, SkillEntry } from '@clothos/core';
import type { BootstrapFile } from './prompt-types.js';

/** Wraps content in XML-style section tags. */
export function section(name: string, content: string): string {
  return `<${name}>\n${content}\n</${name}>`;
}

/** Formats tool definitions as an `<available-tools>` section. */
export function formatToolsSummary(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
  return section('available-tools', lines.join('\n'));
}

/** Formats skill entries as an `<available-skills>` section. */
export function formatSkillsSummary(skills: SkillEntry[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description} (path: ${s.filePath})`);
  return section('available-skills', lines.join('\n'));
}

/** Formats loaded bootstrap files, each in its own section tag. */
export function formatBootstrapFiles(files: BootstrapFile[]): string {
  if (files.length === 0) return '';
  const sections = files.map((f) => {
    const tag = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    const marker = f.truncated ? '\n[truncated]' : '';
    return section(tag, f.content + marker);
  });
  return sections.join('\n\n');
}
