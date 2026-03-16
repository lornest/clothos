import { describe, it, expect } from 'vitest';
import type { ToolDefinition, SkillEntry } from '@clothos/core';
import type { AssembledContext } from '../src/types.js';
import { HookRegistry } from '../src/hook-registry.js';
import { registerPromptHandlers } from '../src/prompt-assembler.js';
import { DEFAULT_BOOTSTRAP_CONFIG } from '../src/prompt-types.js';
import { createMemoryFs } from './helpers.js';

function makeDefaultAssembled(): AssembledContext {
  return {
    messages: [
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'hi' },
    ],
    options: {},
  };
}

describe('registerPromptHandlers', () => {
  it('registers four handlers in full mode', () => {
    const hooks = new HookRegistry();
    const fs = createMemoryFs();

    const disposables = registerPromptHandlers({
      hooks,
      agentId: 'agent-1',
      agentName: 'Test',
      agentDir: '/agents/agent-1',
      model: 'gpt-4',
      basePath: '/data',
      fs,
      getTools: () => [],
      skills: [],
      config: { promptMode: 'full', bootstrap: DEFAULT_BOOTSTRAP_CONFIG },
    });

    expect(disposables).toHaveLength(4);
    expect(hooks.handlerCount('context_assemble')).toBe(4);
  });

  it('registers nothing in none mode', () => {
    const hooks = new HookRegistry();
    const fs = createMemoryFs();

    const disposables = registerPromptHandlers({
      hooks,
      agentId: 'agent-1',
      agentName: 'Test',
      agentDir: '/agents/agent-1',
      model: 'gpt-4',
      basePath: '/data',
      fs,
      getTools: () => [],
      skills: [],
      config: { promptMode: 'none', bootstrap: DEFAULT_BOOTSTRAP_CONFIG },
    });

    expect(disposables).toHaveLength(0);
    expect(hooks.handlerCount('context_assemble')).toBe(0);
  });

  it('disposables clean up handlers', () => {
    const hooks = new HookRegistry();
    const fs = createMemoryFs();

    const disposables = registerPromptHandlers({
      hooks,
      agentId: 'agent-1',
      agentName: 'Test',
      agentDir: '/agents/agent-1',
      model: 'gpt-4',
      basePath: '/data',
      fs,
      getTools: () => [],
      skills: [],
      config: { promptMode: 'full', bootstrap: DEFAULT_BOOTSTRAP_CONFIG },
    });

    expect(hooks.handlerCount('context_assemble')).toBe(4);

    for (const d of disposables) {
      d.dispose();
    }

    expect(hooks.handlerCount('context_assemble')).toBe(0);
  });

  it('individual handler dispose does not affect others', () => {
    const hooks = new HookRegistry();
    const fs = createMemoryFs();

    const disposables = registerPromptHandlers({
      hooks,
      agentId: 'agent-1',
      agentName: 'Test',
      agentDir: '/agents/agent-1',
      model: 'gpt-4',
      basePath: '/data',
      fs,
      getTools: () => [],
      skills: [],
      config: { promptMode: 'full', bootstrap: DEFAULT_BOOTSTRAP_CONFIG },
    });

    // Dispose only the first handler
    disposables[0]!.dispose();
    expect(hooks.handlerCount('context_assemble')).toBe(3);
  });

  it('integration: enriched prompt contains all sections in correct order', async () => {
    const hooks = new HookRegistry();
    const fs = createMemoryFs();

    await fs.writeFile('/agents/agent-1/SOUL.md', 'I am the soul.');
    await fs.writeFile('/agents/agent-1/IDENTITY.md', 'My identity.');

    const tools: ToolDefinition[] = [
      { name: 'search', description: 'Search files', inputSchema: {} },
    ];

    registerPromptHandlers({
      hooks,
      agentId: 'agent-1',
      agentName: 'TestBot',
      agentDir: '/agents/agent-1',
      model: 'gpt-4',
      basePath: '/data',
      fs,
      getTools: () => tools,
      skills: [
        { name: 'commit', description: 'Git commit helper', filePath: '/skills/commit/SKILL.md', metadata: {} },
        { name: 'review', description: 'Code review', filePath: '/skills/review/SKILL.md', metadata: {} },
      ] satisfies SkillEntry[],
      config: { promptMode: 'full', bootstrap: DEFAULT_BOOTSTRAP_CONFIG },
    });

    const assembled = makeDefaultAssembled();
    const result = (await hooks.fire('context_assemble', assembled)) as AssembledContext;

    const content = result.messages[0]!.content;

    // All sections present
    expect(content).toContain('You are a test agent.');
    expect(content).toContain('<available-tools>');
    expect(content).toContain('- search: Search files');
    expect(content).toContain('<available-skills>');
    expect(content).toContain('- commit: Git commit helper');
    expect(content).toContain('<runtime-info>');
    expect(content).toContain('model: gpt-4');
    expect(content).toContain('<soul>');
    expect(content).toContain('I am the soul.');
    expect(content).toContain('<identity>');
    expect(content).toContain('My identity.');

    // Verify ordering: tools before skills before runtime before bootstrap
    const toolsIdx = content.indexOf('<available-tools>');
    const skillsIdx = content.indexOf('<available-skills>');
    const runtimeIdx = content.indexOf('<runtime-info>');
    const bootstrapIdx = content.indexOf('<soul>');

    expect(toolsIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(bootstrapIdx);
  });

  it('minimal mode omits skills and reduces bootstrap', async () => {
    const hooks = new HookRegistry();
    const fs = createMemoryFs();

    await fs.writeFile('/agents/agent-1/SOUL.md', 'soul');
    await fs.writeFile('/agents/agent-1/IDENTITY.md', 'identity');
    await fs.writeFile('/agents/agent-1/TOOLS.md', 'tools docs');

    registerPromptHandlers({
      hooks,
      agentId: 'agent-1',
      agentName: 'TestBot',
      agentDir: '/agents/agent-1',
      model: 'gpt-4',
      basePath: '/data',
      fs,
      getTools: () => [{ name: 'read', description: 'Read', inputSchema: {} }],
      skills: [
        { name: 'commit', description: 'Git commit helper', filePath: '/skills/commit/SKILL.md', metadata: {} },
      ] satisfies SkillEntry[],
      config: { promptMode: 'minimal', bootstrap: DEFAULT_BOOTSTRAP_CONFIG },
    });

    const assembled = makeDefaultAssembled();
    const result = (await hooks.fire('context_assemble', assembled)) as AssembledContext;
    const content = result.messages[0]!.content;

    // Tools and runtime still present
    expect(content).toContain('<available-tools>');
    expect(content).toContain('<runtime-info>');

    // Skills omitted in minimal mode
    expect(content).not.toContain('<available-skills>');

    // Only SOUL.md and IDENTITY.md loaded
    expect(content).toContain('<soul>');
    expect(content).toContain('<identity>');
    expect(content).not.toContain('tools docs');
  });
});
