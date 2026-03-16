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
import { AgentManager, LLMService } from '@clothos/agent-runtime';
import type { FileSystem, LLMServiceOptions } from '@clothos/agent-runtime';

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
import { PluginLoader, discoverSkills } from '@clothos/plugins';
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
    registerCommand: (_name, _handler) => {
      // Commands not wired at this level yet
      return { dispose: () => {} };
    },
    getService: <T>(_name: string): T => {
      throw new Error('Service registry not wired yet');
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

  // 7. Subscribe to NATS inbox with response routing

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
    // onBeforeDispatch: apply binding overrides
    (originalMsg: AgentMessage) => {
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
