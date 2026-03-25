import type {
  AgentEntry,
  AgentDefaults,
  AgentEvent,
  AgentMessage,
  BindingOverrides,
  ToolsConfig,
  SandboxConfig,
  PluginsConfig,
  MemoryConfig,
  SkillsConfig,
  Logger,
} from '@clothos/core';
import { generateId, now } from '@clothos/core';
import {
  AgentManager,
  LLMService,
  PlanModeController,
  enterPlanModeToolDefinition,
  createEnterPlanModeHandler,
} from '@clothos/agent-runtime';
import type { FileSystem, LLMServiceOptions, PlanModeConfig, ExitPlanModeResult } from '@clothos/agent-runtime';

import {
  ToolRegistry,
  registerBuiltinTools,
  PolicyEngine,
} from '@clothos/tools';
import {
  EpisodicMemoryStore,
  HeuristicImportanceScorer,
  createMemoryFlushHandler,
  createMemorySearchHandler,
  createMemoryGetHandler,
  memorySearchTool,
  memoryGetTool,
  DEFAULT_MEMORY_CONFIG,
  mergeMemoryConfig,
  resolveEmbeddingProvider,
} from '@clothos/memory';
import { PluginLoader, discoverSkills, CommandRegistry, ServiceRegistry } from '@clothos/plugins';
import type { PluginLoaderCallbacks } from '@clothos/plugins';
import type { GatewayServer } from '@clothos/gateway';
import { ResponseRouter } from './response-router.js';

export interface AgentWiringOptions {
  agentEntry: AgentEntry;
  defaults: AgentDefaults;
  compaction: { enabled: boolean; reserveTokens: number };
  basePath: string;
  fs: FileSystem;
  llmServiceOptions: LLMServiceOptions;
  toolsConfig: ToolsConfig;
  sandboxConfig: SandboxConfig;
  memoryConfig?: MemoryConfig;
  pluginsConfig: PluginsConfig;
  skillsConfig?: SkillsConfig;
  gateway: GatewayServer;
  logger: Logger;
}

export interface WiredAgent {
  manager: AgentManager;
  registry: ToolRegistry;
  policyEngine: PolicyEngine;
  memoryStore?: EpisodicMemoryStore;
  planMode: PlanModeController;
  enterPlanMode: (config: PlanModeConfig) => Promise<void>;
  exitPlanMode: () => Promise<ExitPlanModeResult>;
  commandRegistry: CommandRegistry;
  cleanup: () => Promise<void>;
}

/**
 * Wire up a single agent with all subsystems:
 * tools, memory, plugins, skills, and NATS inbox subscription.
 */
export async function wireAgent(options: AgentWiringOptions): Promise<WiredAgent> {
  const {
    agentEntry,
    defaults,
    compaction,
    basePath,
    fs,
    llmServiceOptions,
    toolsConfig,
    sandboxConfig,
    memoryConfig,
    pluginsConfig,
    skillsConfig,
    gateway,
    logger,
  } = options;

  // 1. Create agent manager + LLM service
  const manager = new AgentManager({ agentEntry, defaults, compaction, basePath, fs });
  const llmService = new LLMService(llmServiceOptions);
  await manager.init(llmService);
  await manager.restoreLastSession();

  // 2. Build tool registry
  const registry = new ToolRegistry();
  const workspaceRoot = `${basePath}/agents/${agentEntry.id}/workspace`;
  await fs.mkdir(workspaceRoot, { recursive: true });

  registerBuiltinTools(registry, {
    workspaceRoot,
    yoloMode: false,
  });

  // 3. Set up memory (if enabled)
  let memoryStore: EpisodicMemoryStore | undefined;
  if (memoryConfig?.enabled !== false) {
    const mergedConfig = mergeMemoryConfig(memoryConfig ?? DEFAULT_MEMORY_CONFIG);
    const dbPath = `${basePath}/agents/${agentEntry.id}/memory.db`;

    const embeddingProvider = resolveEmbeddingProvider(mergedConfig.embedding);

    memoryStore = new EpisodicMemoryStore({
      agentId: agentEntry.id,
      dbPath,
      config: mergedConfig,
      embeddingProvider,
    });
    memoryStore.open();

    // Register memory tools
    registry.register(
      memorySearchTool,
      createMemorySearchHandler(memoryStore, agentEntry.id, embeddingProvider),
      'memory',
    );
    registry.register(
      memoryGetTool,
      createMemoryGetHandler(memoryStore, agentEntry.id),
      'memory',
    );

    // Register memory flush hook
    const importanceScorer = new HeuristicImportanceScorer();
    const flushHandler = createMemoryFlushHandler(
      memoryStore,
      embeddingProvider,
      importanceScorer,
      mergedConfig.chunking,
    );
    manager.getHookRegistry().register('memory_flush', flushHandler);
  }

  // 4. Apply policy engine to filter tools
  const policyEngine = new PolicyEngine(
    toolsConfig,
    [agentEntry],
    sandboxConfig,
    registry,
  );

  const effectiveTools = policyEngine.getEffectiveBuiltinTools({
    agentId: agentEntry.id,
  });
  const handlerMap = registry.buildHandlerMap(
    effectiveTools.map((t) => t.name),
  );
  manager.setTools(effectiveTools, handlerMap);

  // 5. Load plugins
  const hookRegistry = manager.getHookRegistry();
  const commandRegistry = new CommandRegistry();
  const serviceRegistry = new ServiceRegistry();

  const pluginCallbacks: PluginLoaderCallbacks = {
    registerTool: (def, handler) => {
      registry.register(def, handler, 'plugin');
    },
    unregisterTool: (name) => {
      registry.unregister(name);
    },
    registerHook: (event, handler) => {
      return hookRegistry.register(event, handler);
    },
    registerCommand: (name, handler) => {
      return commandRegistry.register(name, handler);
    },
    getService: <T>(name: string): T => {
      return serviceRegistry.get<T>(name);
    },
  };

  if (pluginsConfig.directories.length > 0) {
    const pluginLoader = new PluginLoader({
      directories: pluginsConfig.directories,
      enabled: pluginsConfig.enabled,
      disabled: pluginsConfig.disabled,
      callbacks: pluginCallbacks,
      logger,
    });
    await pluginLoader.loadAll();
  }

  // 6. Discover and set skills
  if (skillsConfig && skillsConfig.directories.length > 0) {
    const skills = await discoverSkills({
      directories: skillsConfig.directories,
      enabled: skillsConfig.enabled,
      disabled: skillsConfig.disabled,
      logger,
    });
    manager.setSkills(skills);
  }

  // 7. Create plan mode controller (before NATS subscription so onBeforeDispatch can use it)
  const agentWorkspacePath = `${basePath}/agents/${agentEntry.id}`;
  const planMode = new PlanModeController({
    agentWorkspacePath,
    fs,
  });

  // Register enter_plan_mode tool (always available — lets agent self-initiate planning)
  registry.register(
    enterPlanModeToolDefinition,
    createEnterPlanModeHandler(
      (config) => enterPlanMode(config),
      () => planMode.getState(),
    ),
    'builtin',
  );

  /**
   * Enter plan mode: registers hooks to enforce read-only constraints,
   * adds plan-mode tools to the agent's tool set.
   */
  const enterPlanMode = async (config: PlanModeConfig) => {
    const {
      exitToolDefinition, exitToolHandler,
      writePlanDefinition, writePlanHandler,
      editPlanDefinition, editPlanHandler,
    } = await planMode.enter(hookRegistry, config);

    // Register plan-mode tools so the agent can call them
    registry.register(exitToolDefinition, exitToolHandler, 'builtin');
    registry.register(writePlanDefinition, writePlanHandler, 'builtin');
    registry.register(editPlanDefinition, editPlanHandler, 'builtin');

    // Rebuild effective tools to include plan-mode tools
    const planTools = policyEngine.getEffectiveBuiltinTools({
      agentId: agentEntry.id,
    });
    const planHandlerMap = registry.buildHandlerMap(
      planTools.map((t) => t.name),
    );
    manager.setTools(planTools, planHandlerMap);

    logger.info(`Agent "${agentEntry.id}" entered plan mode: ${config.slug}`);
  };

  /**
   * Exit plan mode: disposes hooks, removes plan-mode tools,
   * injects plan into context, and restores normal tools.
   */
  const exitPlanMode = async (): Promise<ExitPlanModeResult> => {
    const result = await planMode.exit(hookRegistry);

    // Remove plan-mode tools
    registry.unregister('exit_plan_mode');
    registry.unregister('write_plan');
    registry.unregister('edit_plan');

    // Restore default tools
    const restoredTools = policyEngine.getEffectiveBuiltinTools({
      agentId: agentEntry.id,
    });
    const restoredHandlerMap = registry.buildHandlerMap(
      restoredTools.map((t) => t.name),
    );
    manager.setTools(restoredTools, restoredHandlerMap);

    logger.info(`Agent "${agentEntry.id}" exited plan mode: ${result.planFilePath}`);
    return result;
  };

  // Register plan mode as a service for plugins
  serviceRegistry.register('planMode', {
    enter: (config: PlanModeConfig) => enterPlanMode(config),
    exit: () => exitPlanMode(),
    getState: () => planMode.getState(),
  });

  // Register built-in 'plan' command
  commandRegistry.register('plan', async (args: string) => {
    const parts = args.trim().split(/\s+/);
    const slug = parts[0];
    if (!slug) return 'Usage: /plan <slug> [goal]';
    if (planMode.getState().active) return 'Plan mode is already active.';
    const goal = parts.slice(1).join(' ') || undefined;
    await enterPlanMode({ slug, goal });
    return `Entered plan mode: ${slug}`;
  });

  // 8. Subscribe to NATS inbox with response routing

  // Save default tools for restoration after binding overrides
  const defaultTools = effectiveTools;
  const defaultHandlerMap = handlerMap;

  const natsClient = gateway.getNatsClient();

  const inboxSub = await manager.subscribeToInbox(
    natsClient,
    (event: AgentEvent, originalMsg: AgentMessage) => {
      const correlationId = originalMsg.correlationId ?? originalMsg.id;

      if (event.type === 'assistant_message' && (event.content.text || event.content.finishReason === 'error')) {
        const text = event.content.text || '[The assistant encountered an error processing this message.]';
        const response = ResponseRouter.buildResponseMessage(
          originalMsg,
          agentEntry.id,
          text,
          undefined,
          manager.getCurrentSessionId() ?? undefined,
        );
        gateway.sendResponse(correlationId, response);

        // Cross-node reply-to routing: forward event to the caller's reply inbox
        if (originalMsg.replyTo) {
          try {
            const replyMsg: AgentMessage = {
              id: generateId(),
              specversion: '1.0',
              type: 'task.response',
              source: `agent://${agentEntry.id}`,
              target: originalMsg.source,
              time: now(),
              datacontenttype: 'application/json',
              data: { event },
              correlationId,
              causationId: originalMsg.id,
            };
            natsClient.publishCore(originalMsg.replyTo, replyMsg);
          } catch { /* best-effort — caller may have timed out */ }
        }
      } else if (event.type === 'error') {
        const response: AgentMessage = {
          id: generateId(),
          specversion: '1.0',
          type: 'task.error',
          source: `agent://${agentEntry.id}`,
          target: originalMsg.source,
          time: now(),
          datacontenttype: 'application/json',
          data: { error: event.error },
          correlationId,
          causationId: originalMsg.id,
        };
        gateway.sendResponse(correlationId, response);

        // Cross-node reply-to routing: forward error to the caller's reply inbox
        if (originalMsg.replyTo) {
          try {
            natsClient.publishCore(originalMsg.replyTo, response);
          } catch { /* best-effort */ }
        }
      }
    },
    (originalMsg: AgentMessage) => {
      const correlationId = originalMsg.correlationId ?? originalMsg.id;
      const doneMsg: AgentMessage = {
        id: generateId(),
        specversion: '1.0',
        type: 'task.done',
        source: `agent://${agentEntry.id}`,
        target: originalMsg.source,
        time: now(),
        datacontenttype: 'application/json',
        data: {},
        correlationId,
        causationId: originalMsg.id,
      };
      gateway.sendResponse(correlationId, doneMsg);
      gateway.completePendingResponse(correlationId);

      // Cross-node reply-to routing: signal completion to the caller's reply inbox
      if (originalMsg.replyTo) {
        try {
          natsClient.publishCore(originalMsg.replyTo, doneMsg);
        } catch { /* best-effort */ }
      }
    },
    // onBeforeDispatch: parse /plan command and apply binding overrides
    async (originalMsg: AgentMessage) => {
      // Parse /plan command from message text
      const data = originalMsg.data as Record<string, unknown> | undefined;
      if (data && typeof data['text'] === 'string') {
        const text = data['text'];
        const planMatch = text.match(/^\/plan\s+(\S+)(?:\s+(.+))?$/s);
        if (planMatch && !planMode.getState().active) {
          const slug = planMatch[1]!;
          const goal = planMatch[2]?.trim();
          await enterPlanMode({ slug, goal });
          // Rewrite message so the agent sees the goal, not the raw /plan command
          data['text'] = goal
            ? `Plan the following task: ${goal}`
            : `Explore the codebase and create an implementation plan for: ${slug}`;
        }
      }

      // Check metadata for plan mode signal (from orchestration or UI)
      if (originalMsg.metadata?.['x-plan-mode'] === 'true' && !planMode.getState().active) {
        const slug = originalMsg.metadata['x-plan-slug'] ?? 'remote-plan';
        const goal = data && typeof data['text'] === 'string' ? data['text'] : undefined;
        await enterPlanMode({ slug, goal });
      }

      // Apply binding overrides
      const overridesJson = originalMsg.metadata?.['x-binding-overrides'];
      if (overridesJson) {
        try {
          const overrides = JSON.parse(overridesJson) as BindingOverrides;
          if (overrides.tools) {
            const narrowedTools = policyEngine.getEffectiveBuiltinTools({
              agentId: agentEntry.id,
              bindingTools: overrides.tools,
            });
            const narrowedHandlerMap = registry.buildHandlerMap(
              narrowedTools.map((t) => t.name),
            );
            manager.setTools(narrowedTools, narrowedHandlerMap);
          }
        } catch { /* ignore malformed overrides */ }
      }
    },
    // onAfterDispatch: restore default tools
    () => {
      manager.setTools(defaultTools, defaultHandlerMap);
    },
  );

  gateway.registerSubscription(`agent://${agentEntry.id}`, inboxSub);

  logger.info(`Agent "${agentEntry.name}" (${agentEntry.id}) wired and ready`);

  return {
    manager,
    registry,
    policyEngine,
    memoryStore,
    planMode,
    enterPlanMode,
    exitPlanMode,
    commandRegistry,
    cleanup: async () => {
      if (memoryStore) {
        try {
          const ctx = manager.getContext();
          if (ctx) {
            await hookRegistry.fire('memory_flush', { context: ctx });
          }
        } catch { /* best-effort */ }
      }
      await manager.terminate();
      memoryStore?.close();
    },
  };
}
