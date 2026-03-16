import { describe, it, expect } from 'vitest';
import type { ToolDefinition, SkillEntry } from '@clothos/core';
import type { AssembledContext } from '../src/types.js';
import { BootstrapLoader } from '../src/bootstrap-loader.js';
import {
  appendToSystemPrompt,
  createToolsHandler,
  createSkillsHandler,
  createRuntimeInfoHandler,
  createBootstrapHandler,
} from '../src/prompt-handlers.js';
import { createMemoryFs } from './helpers.js';

function makeAssembled(systemContent = 'You are helpful.'): AssembledContext {
  return {
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: 'hello' },
    ],
    options: {},
  };
}

describe('appendToSystemPrompt', () => {
  it('appends section text to system message content', () => {
    const assembled = makeAssembled();
    const result = appendToSystemPrompt(assembled, '<test>\ndata\n</test>');
    expect(result.messages[0]!.content).toContain('You are helpful.');
    expect(result.messages[0]!.content).toContain('<test>\ndata\n</test>');
  });

  it('does not mutate the original assembled context', () => {
    const assembled = makeAssembled();
    const original = assembled.messages[0]!.content;
    appendToSystemPrompt(assembled, 'extra');
    expect(assembled.messages[0]!.content).toBe(original);
  });

  it('returns assembled unchanged when section text is empty', () => {
    const assembled = makeAssembled();
    const result = appendToSystemPrompt(assembled, '');
    expect(result).toBe(assembled);
  });

  it('preserves non-system messages', () => {
    const assembled = makeAssembled();
    const result = appendToSystemPrompt(assembled, 'extra');
    expect(result.messages[1]!.content).toBe('hello');
  });
});

describe('createToolsHandler', () => {
  const tools: ToolDefinition[] = [
    { name: 'read', description: 'Read a file', inputSchema: {} },
  ];

  it('injects tools section in full mode', () => {
    const handler = createToolsHandler(() => tools, 'full');
    const result = handler(makeAssembled()) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<available-tools>');
    expect(result.messages[0]!.content).toContain('- read: Read a file');
  });

  it('injects tools section in minimal mode', () => {
    const handler = createToolsHandler(() => tools, 'minimal');
    const result = handler(makeAssembled()) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<available-tools>');
  });

  it('skips in none mode', () => {
    const handler = createToolsHandler(() => tools, 'none');
    const assembled = makeAssembled();
    const result = handler(assembled);
    expect(result).toBe(assembled);
  });

  it('uses getter pattern so tools stay current', () => {
    let currentTools: ToolDefinition[] = [];
    const handler = createToolsHandler(() => currentTools, 'full');

    // Initially no tools
    const result1 = handler(makeAssembled()) as AssembledContext;
    expect(result1.messages[0]!.content).not.toContain('<available-tools>');

    // Update tools
    currentTools = [{ name: 'write', description: 'Write', inputSchema: {} }];
    const result2 = handler(makeAssembled()) as AssembledContext;
    expect(result2.messages[0]!.content).toContain('- write: Write');
  });
});

describe('createSkillsHandler', () => {
  const skills: SkillEntry[] = [
    { name: 'commit', description: 'Git commit helper', filePath: '/skills/commit/SKILL.md', metadata: {} },
    { name: 'review', description: 'Code review assistant', filePath: '/skills/review/SKILL.md', metadata: {} },
  ];

  it('injects skills section in full mode', () => {
    const handler = createSkillsHandler(skills, 'full');
    const result = handler(makeAssembled()) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<available-skills>');
    expect(result.messages[0]!.content).toContain('- commit: Git commit helper');
  });

  it('skips in minimal mode', () => {
    const handler = createSkillsHandler([skills[0]!], 'minimal');
    const assembled = makeAssembled();
    const result = handler(assembled);
    expect(result).toBe(assembled);
  });

  it('skips in none mode', () => {
    const handler = createSkillsHandler([skills[0]!], 'none');
    const assembled = makeAssembled();
    const result = handler(assembled);
    expect(result).toBe(assembled);
  });
});

describe('createRuntimeInfoHandler', () => {
  const info = {
    os: 'linux',
    model: 'gpt-4',
    timezone: 'UTC',
    repoRoot: '/project',
    agentId: 'a1',
    agentName: 'Agent',
  };

  it('injects runtime info section in full mode', () => {
    const handler = createRuntimeInfoHandler(info, 'full');
    const result = handler(makeAssembled()) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<runtime-info>');
    expect(result.messages[0]!.content).toContain('os: linux');
  });

  it('injects runtime info in minimal mode', () => {
    const handler = createRuntimeInfoHandler(info, 'minimal');
    const result = handler(makeAssembled()) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<runtime-info>');
  });

  it('skips in none mode', () => {
    const handler = createRuntimeInfoHandler(info, 'none');
    const assembled = makeAssembled();
    const result = handler(assembled);
    expect(result).toBe(assembled);
  });
});

describe('createBootstrapHandler', () => {
  it('injects bootstrap files in full mode', async () => {
    const fs = createMemoryFs();
    await fs.writeFile('/agent/SOUL.md', 'I am a soul.');
    await fs.writeFile('/agent/TOOLS.md', 'Use tools wisely.');

    const loader = new BootstrapLoader('/agent', fs, {
      fileNames: ['SOUL.md', 'TOOLS.md'],
      maxCharsPerFile: 20_000,
      maxTotalChars: 150_000,
    });

    const handler = createBootstrapHandler(loader, 'full');
    const result = (await handler(makeAssembled())) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<soul>');
    expect(result.messages[0]!.content).toContain('I am a soul.');
    expect(result.messages[0]!.content).toContain('<tools>');
    expect(result.messages[0]!.content).toContain('Use tools wisely.');
  });

  it('in minimal mode only loads SOUL.md and IDENTITY.md', async () => {
    const fs = createMemoryFs();
    await fs.writeFile('/agent/SOUL.md', 'soul');
    await fs.writeFile('/agent/IDENTITY.md', 'identity');
    await fs.writeFile('/agent/TOOLS.md', 'tools');

    const loader = new BootstrapLoader('/agent', fs, {
      fileNames: ['SOUL.md', 'IDENTITY.md', 'TOOLS.md'],
      maxCharsPerFile: 20_000,
      maxTotalChars: 150_000,
    });

    const handler = createBootstrapHandler(loader, 'minimal');
    const result = (await handler(makeAssembled())) as AssembledContext;
    expect(result.messages[0]!.content).toContain('<soul>');
    expect(result.messages[0]!.content).toContain('<identity>');
    expect(result.messages[0]!.content).not.toContain('<tools>');
  });

  it('skips in none mode', async () => {
    const fs = createMemoryFs();
    const loader = new BootstrapLoader('/agent', fs, {
      fileNames: ['SOUL.md'],
      maxCharsPerFile: 20_000,
      maxTotalChars: 150_000,
    });

    const handler = createBootstrapHandler(loader, 'none');
    const assembled = makeAssembled();
    const result = await handler(assembled);
    expect(result).toBe(assembled);
  });
});

describe('handler chaining', () => {
  it('handlers chain correctly without mutating input', () => {
    const tools: ToolDefinition[] = [
      { name: 'read', description: 'Read', inputSchema: {} },
    ];
    const info = {
      os: 'darwin',
      model: 'test',
      timezone: 'UTC',
      repoRoot: '/r',
      agentId: 'a',
      agentName: 'A',
    };

    const toolsHandler = createToolsHandler(() => tools, 'full');
    const runtimeHandler = createRuntimeInfoHandler(info, 'full');

    const original = makeAssembled();
    const afterTools = toolsHandler(original) as AssembledContext;
    const afterRuntime = runtimeHandler(afterTools) as AssembledContext;

    // Original unchanged
    expect(original.messages[0]!.content).toBe('You are helpful.');

    // Both sections present in final result
    expect(afterRuntime.messages[0]!.content).toContain('<available-tools>');
    expect(afterRuntime.messages[0]!.content).toContain('<runtime-info>');
  });
});
