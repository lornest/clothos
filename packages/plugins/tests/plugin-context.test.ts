import { describe, it, expect, vi } from 'vitest';
import type { Logger, ToolDefinition, ToolHandler } from '@clothos/core';
import type { PluginLoaderCallbacks } from '../src/types.js';
import { createPluginContext } from '../src/plugin-context-impl.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCallbacks(): PluginLoaderCallbacks & {
  registeredTools: Array<{ def: ToolDefinition; handler: ToolHandler }>;
  registeredHooks: Array<{ event: string }>;
  registeredCommands: Array<{ name: string }>;
} {
  const registeredTools: Array<{ def: ToolDefinition; handler: ToolHandler }> = [];
  const registeredHooks: Array<{ event: string }> = [];
  const registeredCommands: Array<{ name: string }> = [];

  return {
    registeredTools,
    registeredHooks,
    registeredCommands,
    registerTool(def, handler) {
      registeredTools.push({ def, handler });
    },
    unregisterTool: vi.fn(),
    registerHook(event, _handler) {
      registeredHooks.push({ event: event as string });
      return { dispose: vi.fn() };
    },
    registerCommand(name, _handler) {
      registeredCommands.push({ name });
      return { dispose: vi.fn() };
    },
    getService: vi.fn().mockReturnValue('mock-service'),
  };
}

describe('createPluginContext', () => {
  it('delegates registerTool to callbacks and tracks tool names', () => {
    const callbacks = makeCallbacks();
    const { context, registeredTools } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    const handler: ToolHandler = async () => 'result';
    const def: ToolDefinition = { name: 'my-tool', description: 'A tool', inputSchema: {} };
    context.registerTool(def, handler);

    expect(callbacks.registeredTools).toHaveLength(1);
    expect(callbacks.registeredTools[0]!.def.name).toBe('my-tool');
    expect(registeredTools).toEqual(['my-tool']);
  });

  it('delegates registerHook to callbacks and tracks disposables', () => {
    const callbacks = makeCallbacks();
    const { context, hookDisposables } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    context.registerHook('tool_call', async () => ({}));

    expect(callbacks.registeredHooks).toHaveLength(1);
    expect(callbacks.registeredHooks[0]!.event).toBe('tool_call');
    expect(hookDisposables).toHaveLength(1);
  });

  it('delegates registerCommand to callbacks and tracks disposables', () => {
    const callbacks = makeCallbacks();
    const { context, commandDisposables } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    context.registerCommand('hello', () => 'hi');

    expect(callbacks.registeredCommands).toHaveLength(1);
    expect(callbacks.registeredCommands[0]!.name).toBe('hello');
    expect(commandDisposables).toHaveLength(1);
  });

  it('delegates getService to callbacks', () => {
    const callbacks = makeCallbacks();
    const { context } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    const result = context.getService<string>('db');
    expect(result).toBe('mock-service');
  });

  it('prefixes logger messages with plugin name', () => {
    const logger = makeLogger();
    const callbacks = makeCallbacks();
    const { context } = createPluginContext('my-plugin', callbacks, logger, {});

    context.logger.info('hello');
    expect(logger.info).toHaveBeenCalledWith('[plugin:my-plugin] hello');

    context.logger.warn('warning');
    expect(logger.warn).toHaveBeenCalledWith('[plugin:my-plugin] warning');

    context.logger.error('error');
    expect(logger.error).toHaveBeenCalledWith('[plugin:my-plugin] error');

    context.logger.debug('debug');
    expect(logger.debug).toHaveBeenCalledWith('[plugin:my-plugin] debug');
  });

  it('passes config through to context', () => {
    const callbacks = makeCallbacks();
    const config = { apiKey: 'secret', retries: 3 };
    const { context } = createPluginContext('test-plugin', callbacks, makeLogger(), config);

    expect(context.config).toEqual({ apiKey: 'secret', retries: 3 });
  });

  it('tracks multiple tool registrations', () => {
    const callbacks = makeCallbacks();
    const { context, registeredTools } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    context.registerTool({ name: 'tool-a', description: 'A', inputSchema: {} }, async () => 'a');
    context.registerTool({ name: 'tool-b', description: 'B', inputSchema: {} }, async () => 'b');

    expect(registeredTools).toEqual(['tool-a', 'tool-b']);
  });

  it('tracks multiple hook disposables', () => {
    const callbacks = makeCallbacks();
    const { context, hookDisposables } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    context.registerHook('tool_call', async () => ({}));
    context.registerHook('turn_start', async () => ({}));
    context.registerHook('turn_end', async () => ({}));

    expect(hookDisposables).toHaveLength(3);
  });

  it('returns hook disposable from registerHook', () => {
    const callbacks = makeCallbacks();
    const { context } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    const disposable = context.registerHook('tool_call', async () => ({}));
    expect(disposable).toHaveProperty('dispose');
    expect(typeof disposable.dispose).toBe('function');
  });

  it('returns command disposable from registerCommand', () => {
    const callbacks = makeCallbacks();
    const { context } = createPluginContext('test-plugin', callbacks, makeLogger(), {});

    const disposable = context.registerCommand('greet', () => 'hi');
    expect(disposable).toHaveProperty('dispose');
    expect(typeof disposable.dispose).toBe('function');
  });
});
