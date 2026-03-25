import { describe, it, expect, beforeEach } from 'vitest';
import { HookRegistry } from '../src/hook-registry.js';
import { PlanModeController } from '../src/plan-mode/plan-mode-controller.js';
import { createPlanModeToolCallHook } from '../src/plan-mode/plan-mode-hooks.js';
import { createPlanModePromptHandler, createPlanContextHandler } from '../src/plan-mode/plan-mode-prompt.js';
import { createWritePlanHandler, createEditPlanHandler, createEnterPlanModeHandler } from '../src/plan-mode/plan-mode-tools.js';
import type { PlanModeConfig, PlanModeState } from '../src/plan-mode/plan-mode-types.js';
import type { FileSystem } from '../src/types.js';
import type { ToolCallHookResult, AssembledContext } from '../src/types.js';

/** Minimal mock filesystem for testing. */
function createMockFs(files: Record<string, string> = {}): FileSystem {
  const store = new Map(Object.entries(files));
  return {
    async readFile(path: string) {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async writeFile(path: string, content: string) {
      store.set(path, content);
    },
    async appendFile(path: string, content: string) {
      store.set(path, (store.get(path) ?? '') + content);
    },
    async mkdir(_path: string, _options?: { recursive?: boolean }) {
      // no-op for mock
    },
    async exists(path: string) {
      return store.has(path);
    },
    async readdir(_path: string) {
      return [];
    },
  };
}

function createAssembledContext(systemContent = 'You are an agent.'): AssembledContext {
  return {
    messages: [{ role: 'system' as const, content: systemContent }],
    options: { model: 'test-model' },
  };
}

// ── PlanModeController ──────────────────────────────────────

describe('PlanModeController', () => {
  let hooks: HookRegistry;
  let fs: FileSystem;
  let controller: PlanModeController;

  beforeEach(() => {
    hooks = new HookRegistry();
    fs = createMockFs();
    controller = new PlanModeController({
      agentWorkspacePath: '/workspace/agents/agent-1',
      fs,
    });
  });

  it('enters plan mode, state becomes active', async () => {
    await controller.enter(hooks, { slug: 'test-plan' });

    const state = controller.getState();
    expect(state.active).toBe(true);
    expect(state.slug).toBe('test-plan');
    expect(state.planFilePath).toBe('/workspace/agents/agent-1/plans/test-plan.md');
    expect(state.goal).toBeNull();
  });

  it('enters plan mode with goal', async () => {
    await controller.enter(hooks, { slug: 'test-plan', goal: 'Build auth system' });

    expect(controller.getState().goal).toBe('Build auth system');
  });

  it('creates plan file on enter if it does not exist', async () => {
    await controller.enter(hooks, { slug: 'new-plan' });

    const exists = await fs.exists('/workspace/agents/agent-1/plans/new-plan.md');
    expect(exists).toBe(true);

    const content = await fs.readFile('/workspace/agents/agent-1/plans/new-plan.md');
    expect(content).toContain('# Plan: new-plan');
  });

  it('does not overwrite existing plan file on enter', async () => {
    await fs.mkdir('/workspace/agents/agent-1/plans', { recursive: true });
    await fs.writeFile(
      '/workspace/agents/agent-1/plans/existing.md',
      '# My existing plan\n\nStep 1...',
    );

    await controller.enter(hooks, { slug: 'existing' });

    const content = await fs.readFile('/workspace/agents/agent-1/plans/existing.md');
    expect(content).toBe('# My existing plan\n\nStep 1...');
  });

  it('registers hooks on enter', async () => {
    const toolCallBefore = hooks.handlerCount('tool_call');
    const contextBefore = hooks.handlerCount('context_assemble');

    await controller.enter(hooks, { slug: 'test-plan' });

    expect(hooks.handlerCount('tool_call')).toBe(toolCallBefore + 1);
    expect(hooks.handlerCount('context_assemble')).toBe(contextBefore + 1);
  });

  it('returns all plan-mode tool definitions and handlers', async () => {
    const result = await controller.enter(hooks, { slug: 'test-plan' });

    expect(result.exitToolDefinition.name).toBe('exit_plan_mode');
    expect(typeof result.exitToolHandler).toBe('function');
    expect(result.writePlanDefinition.name).toBe('write_plan');
    expect(typeof result.writePlanHandler).toBe('function');
    expect(result.editPlanDefinition.name).toBe('edit_plan');
    expect(typeof result.editPlanHandler).toBe('function');
  });

  it('throws if entering plan mode when already active', async () => {
    await controller.enter(hooks, { slug: 'test-plan' });

    await expect(
      controller.enter(hooks, { slug: 'second-plan' }),
    ).rejects.toThrow('Plan mode is already active');
  });

  it('exit reads plan content and deactivates', async () => {
    await controller.enter(hooks, { slug: 'test-plan' });

    // Write some plan content
    const planPath = controller.getState().planFilePath!;
    await fs.writeFile(planPath, '# Plan\n\n1. Do the thing\n2. Test it');

    const result = await controller.exit();

    expect(result.exited).toBe(true);
    expect(result.planFilePath).toBe(planPath);
    expect(result.planContent).toContain('Do the thing');
    expect(controller.getState().active).toBe(false);
  });

  it('disposes hooks after exit', async () => {
    const toolCallBefore = hooks.handlerCount('tool_call');
    const contextBefore = hooks.handlerCount('context_assemble');

    await controller.enter(hooks, { slug: 'test-plan' });
    expect(hooks.handlerCount('tool_call')).toBe(toolCallBefore + 1);

    await controller.exit();

    expect(hooks.handlerCount('tool_call')).toBe(toolCallBefore);
    expect(hooks.handlerCount('context_assemble')).toBe(contextBefore);
  });

  it('exit with hooks registry registers post-plan context handler', async () => {
    await controller.enter(hooks, { slug: 'test-plan' });
    const planPath = controller.getState().planFilePath!;
    await fs.writeFile(planPath, '# The Plan\nStep 1');

    const contextBefore = hooks.handlerCount('context_assemble');
    await controller.exit(hooks);

    // Should have one new handler (the post-plan context injector)
    // The plan mode prompt handler was disposed, so net is same count
    expect(hooks.handlerCount('context_assemble')).toBe(contextBefore);
  });

  it('throws if exiting when not active', async () => {
    await expect(controller.exit()).rejects.toThrow('Plan mode is not active');
  });

  it('supports custom plansDir', async () => {
    await controller.enter(hooks, { slug: 'test', plansDir: 'my-plans' });

    expect(controller.getState().planFilePath).toBe(
      '/workspace/agents/agent-1/my-plans/test.md',
    );
  });
});

// ── write_plan handler ──────────────────────────────────────

describe('createWritePlanHandler', () => {
  const planFilePath = '/workspace/agents/agent-1/plans/test-plan.md';

  it('writes content to the plan file', async () => {
    const fs = createMockFs();
    const handler = createWritePlanHandler(planFilePath, fs);

    const result = await handler({ content: '# My Plan\n\nStep 1: Do it' });

    expect(result).toEqual({ written: true, path: planFilePath });
    expect(await fs.readFile(planFilePath)).toBe('# My Plan\n\nStep 1: Do it');
  });

  it('overwrites existing content', async () => {
    const fs = createMockFs({ [planFilePath]: '# Old plan' });
    const handler = createWritePlanHandler(planFilePath, fs);

    await handler({ content: '# New plan' });

    expect(await fs.readFile(planFilePath)).toBe('# New plan');
  });

  it('returns error if content is not a string', async () => {
    const fs = createMockFs();
    const handler = createWritePlanHandler(planFilePath, fs);

    const result = await handler({ content: 123 });

    expect(result).toEqual({ error: 'content must be a string' });
  });
});

// ── edit_plan handler ───────────────────────────────────────

describe('createEditPlanHandler', () => {
  const planFilePath = '/workspace/agents/agent-1/plans/test-plan.md';

  it('performs string replacement on the plan file', async () => {
    const fs = createMockFs({
      [planFilePath]: '# Plan\n\nStep 1: Do the thing\nStep 2: Test it',
    });
    const handler = createEditPlanHandler(planFilePath, fs);

    const result = await handler({
      old_string: 'Do the thing',
      new_string: 'Build the module',
    });

    expect(result).toEqual({ edited: true, path: planFilePath });
    const content = await fs.readFile(planFilePath);
    expect(content).toContain('Build the module');
    expect(content).not.toContain('Do the thing');
  });

  it('returns error on no match', async () => {
    const fs = createMockFs({ [planFilePath]: '# Plan\n\nSome content' });
    const handler = createEditPlanHandler(planFilePath, fs);

    const result = await handler({
      old_string: 'nonexistent text',
      new_string: 'replacement',
    });

    expect(result).toEqual({ error: 'No match found' });
  });

  it('provides case-insensitive hint on no exact match', async () => {
    const fs = createMockFs({ [planFilePath]: '# Plan\n\nBuild the Module' });
    const handler = createEditPlanHandler(planFilePath, fs);

    const result = await handler({
      old_string: 'build the module',
      new_string: 'replacement',
    }) as { error: string };

    expect(result.error).toContain('case-insensitive match');
  });

  it('returns error on multiple matches without replace_all', async () => {
    const fs = createMockFs({
      [planFilePath]: '# Plan\n\nStep: TODO\nStep: TODO\nStep: TODO',
    });
    const handler = createEditPlanHandler(planFilePath, fs);

    const result = await handler({
      old_string: 'TODO',
      new_string: 'DONE',
    }) as { error: string };

    expect(result.error).toContain('Multiple matches found (3 occurrences)');
  });

  it('replaces all occurrences with replace_all: true', async () => {
    const fs = createMockFs({
      [planFilePath]: '# Plan\n\nStep: TODO\nStep: TODO\nStep: TODO',
    });
    const handler = createEditPlanHandler(planFilePath, fs);

    const result = await handler({
      old_string: 'TODO',
      new_string: 'DONE',
      replace_all: true,
    });

    expect(result).toEqual({ edited: true, replacements: 3, path: planFilePath });
    const content = await fs.readFile(planFilePath);
    expect(content).not.toContain('TODO');
    expect(content.match(/DONE/g)).toHaveLength(3);
  });

  it('returns error if old_string is not a string', async () => {
    const fs = createMockFs({ [planFilePath]: '# Plan' });
    const handler = createEditPlanHandler(planFilePath, fs);

    const result = await handler({ old_string: 123, new_string: 'x' });

    expect(result).toEqual({ error: 'old_string must be a string' });
  });
});

// ── enter_plan_mode handler ─────────────────────────────────

describe('createEnterPlanModeHandler', () => {
  it('enters plan mode and returns confirmation', async () => {
    let enterCalled = false;
    let enterConfig: PlanModeConfig | null = null;
    const enterFn = async (config: PlanModeConfig) => {
      enterCalled = true;
      enterConfig = config;
    };
    const state: PlanModeState = {
      active: false,
      planFilePath: null,
      slug: null,
      goal: null,
    };
    const getState = () => state;

    const handler = createEnterPlanModeHandler(enterFn, getState);
    // Simulate entering (enterFn would normally set planFilePath on the state)
    const result = await handler({ slug: 'my-plan', goal: 'Build auth' });

    expect(enterCalled).toBe(true);
    expect(enterConfig).toEqual({ slug: 'my-plan', goal: 'Build auth' });
    expect(result).toMatchObject({ entered: true, slug: 'my-plan' });
  });

  it('rejects when plan mode is already active', async () => {
    const enterFn = async () => {};
    const getState = (): PlanModeState => ({
      active: true,
      planFilePath: '/some/path.md',
      slug: 'existing',
      goal: null,
    });

    const handler = createEnterPlanModeHandler(enterFn, getState);
    const result = await handler({ slug: 'new-plan' });

    expect(result).toEqual({ error: 'Plan mode is already active' });
  });

  it('rejects when slug is missing', async () => {
    const enterFn = async () => {};
    const getState = (): PlanModeState => ({
      active: false,
      planFilePath: null,
      slug: null,
      goal: null,
    });

    const handler = createEnterPlanModeHandler(enterFn, getState);
    const result = await handler({});

    expect(result).toEqual({ error: 'slug must be a non-empty string' });
  });

  it('works without goal parameter', async () => {
    let enterConfig: PlanModeConfig | null = null;
    const enterFn = async (config: PlanModeConfig) => { enterConfig = config; };
    const getState = (): PlanModeState => ({
      active: false,
      planFilePath: null,
      slug: null,
      goal: null,
    });

    const handler = createEnterPlanModeHandler(enterFn, getState);
    await handler({ slug: 'quick-plan' });

    expect(enterConfig).toEqual({ slug: 'quick-plan', goal: undefined });
  });
});

// ── Tool call hook ──────────────────────────────────────────

describe('createPlanModeToolCallHook', () => {
  let hook: ReturnType<typeof createPlanModeToolCallHook>;

  beforeEach(() => {
    hook = createPlanModeToolCallHook();
  });

  // --- Always-allowed tools ---

  it.each([
    'read_file',
    'grep_search',
    'glob_find',
    'list_directory',
    'git_status',
    'git_diff',
    'exit_plan_mode',
    'write_plan',
    'edit_plan',
  ])('allows tool: %s', (toolName) => {
    const ctx = { name: toolName, arguments: {} };
    const result = hook(ctx);
    expect(result).toBe(ctx);
  });

  // --- Write tools are blocked unconditionally ---

  it.each([
    'write_file',
    'edit_file',
  ])('blocks general write tool: %s', (toolName) => {
    const ctx = { name: toolName, arguments: {} };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('not available during planning');
  });

  // --- Bash commands ---

  it.each([
    'ls -la',
    'cat src/index.ts',
    'head -20 package.json',
    'grep -r "pattern" src/',
    'git status',
    'git diff',
    'git log --oneline -10',
    'git branch -a',
    'pwd',
    'wc -l src/*.ts',
    'find . -name "*.ts"',
  ])('allows read-only bash command: %s', (command) => {
    const ctx = { name: 'bash', arguments: { command } };
    const result = hook(ctx);
    expect(result).toBe(ctx);
  });

  it('allows bash with JSON string arguments', () => {
    const ctx = { name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) };
    const result = hook(ctx);
    expect(result).toBe(ctx);
  });

  it('blocks bash with redirect >', () => {
    const ctx = { name: 'bash', arguments: { command: 'echo hello > file.txt' } };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('redirects');
  });

  it('blocks bash with append redirect >>', () => {
    const ctx = { name: 'bash', arguments: { command: 'echo hello >> file.txt' } };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('redirects');
  });

  it('blocks bash with pipe to tee', () => {
    const ctx = { name: 'bash', arguments: { command: 'cat foo | tee output.txt' } };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('redirects');
  });

  it('blocks bash with git push', () => {
    const ctx = { name: 'bash', arguments: { command: 'git push origin main' } };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('git push');
  });

  it('blocks bash with git commit', () => {
    const ctx = { name: 'bash', arguments: { command: 'git commit -m "msg"' } };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('git commit');
  });

  it('blocks bash with npm install', () => {
    const ctx = { name: 'bash', arguments: { command: 'npm install lodash' } };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('not allowed during planning');
  });

  it('blocks bash with no command argument', () => {
    const ctx = { name: 'bash', arguments: {} };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('requires a command');
  });

  // --- Other blocked tools ---

  it.each([
    'agent_spawn',
    'agent_send',
    'use_mcp_tool',
    'memory_search',
    'git_commit',
    'create_pr',
  ])('blocks non-read tool: %s', (toolName) => {
    const ctx = { name: toolName, arguments: {} };
    const result = hook(ctx) as ToolCallHookResult;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('not available during planning');
  });
});

// ── Prompt handlers ─────────────────────────────────────────

describe('createPlanModePromptHandler', () => {
  it('injects <plan-mode> section into system prompt', () => {
    const handler = createPlanModePromptHandler();
    const ctx = createAssembledContext();

    const result = handler(ctx) as AssembledContext;
    const systemContent = result.messages[0]!.content as string;

    expect(systemContent).toContain('<plan-mode>');
    expect(systemContent).toContain('write_plan');
    expect(systemContent).toContain('edit_plan');
    expect(systemContent).toContain('exit_plan_mode');
    expect(systemContent).toContain('</plan-mode>');
  });

  it('includes goal when provided', () => {
    const handler = createPlanModePromptHandler('Build auth system');
    const ctx = createAssembledContext();

    const result = handler(ctx) as AssembledContext;
    const systemContent = result.messages[0]!.content as string;

    expect(systemContent).toContain('Build auth system');
    expect(systemContent).toContain('## Goal');
  });

  it('omits goal section when not provided', () => {
    const handler = createPlanModePromptHandler();
    const ctx = createAssembledContext();

    const result = handler(ctx) as AssembledContext;
    const systemContent = result.messages[0]!.content as string;

    expect(systemContent).not.toContain('## Goal');
  });
});

describe('createPlanContextHandler', () => {
  it('injects <implementation-plan> section into system prompt', () => {
    const handler = createPlanContextHandler('Step 1: Do the thing\nStep 2: Test it');
    const ctx = createAssembledContext();

    const result = handler(ctx) as AssembledContext;
    const systemContent = result.messages[0]!.content as string;

    expect(systemContent).toContain('<implementation-plan>');
    expect(systemContent).toContain('Step 1: Do the thing');
    expect(systemContent).toContain('</implementation-plan>');
  });
});

// ── Integration tests ───────────────────────────────────────

describe('PlanModeController integration with HookRegistry', () => {
  it('tool_call hook blocks general writes during plan mode', async () => {
    const hooks = new HookRegistry();
    const fs = createMockFs();
    const controller = new PlanModeController({
      agentWorkspacePath: '/workspace/agents/agent-1',
      fs,
    });

    await controller.enter(hooks, { slug: 'test-plan' });

    // write_file is blocked
    const writeResult = (await hooks.fire('tool_call', {
      name: 'write_file',
      arguments: { file_path: '/workspace/src/main.ts', content: 'bad' },
    })) as ToolCallHookResult;
    expect(writeResult.blocked).toBe(true);

    // write_plan passes through
    const planWriteResult = (await hooks.fire('tool_call', {
      name: 'write_plan',
      arguments: { content: '# Plan' },
    })) as { name: string };
    expect(planWriteResult.name).toBe('write_plan');

    // read_file passes through
    const readResult = (await hooks.fire('tool_call', {
      name: 'read_file',
      arguments: { file_path: '/workspace/src/main.ts' },
    })) as { name: string };
    expect(readResult.name).toBe('read_file');
  });

  it('context_assemble hook injects plan mode prompt', async () => {
    const hooks = new HookRegistry();
    const fs = createMockFs();
    const controller = new PlanModeController({
      agentWorkspacePath: '/workspace/agents/agent-1',
      fs,
    });

    await controller.enter(hooks, { slug: 'test-plan', goal: 'Build feature X' });

    const ctx = createAssembledContext();
    const result = (await hooks.fire('context_assemble', ctx)) as AssembledContext;
    const systemContent = result.messages[0]!.content as string;

    expect(systemContent).toContain('<plan-mode>');
    expect(systemContent).toContain('Build feature X');
  });

  it('full lifecycle: enter → write_plan → exit → plan in context', async () => {
    const hooks = new HookRegistry();
    const fs = createMockFs();
    const controller = new PlanModeController({
      agentWorkspacePath: '/workspace/agents/agent-1',
      fs,
    });

    // Enter
    const { exitToolHandler, writePlanHandler } = await controller.enter(hooks, {
      slug: 'feature-x',
      goal: 'Implement feature X',
    });

    // Write plan via the dedicated tool
    const writeResult = await writePlanHandler({ content: '# Plan\n\n1. Create module\n2. Add tests' });
    expect(writeResult).toMatchObject({ written: true });

    // Exit via tool handler
    const exitResult = await exitToolHandler({ summary: 'Plan to implement feature X' });
    expect(exitResult).toMatchObject({
      exited: true,
      planContent: expect.stringContaining('Create module'),
    });

    // After exit, state is inactive
    expect(controller.getState().active).toBe(false);

    // Hooks should be disposed
    expect(hooks.handlerCount('tool_call')).toBe(0);
    expect(hooks.handlerCount('context_assemble')).toBe(0);
  });
});
