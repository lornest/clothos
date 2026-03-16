import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import type {
  ClothosConfig,
  LLMProvider,
  Logger,
} from '@clothos/core';
import { loadConfig, applyEnvOverrides } from '@clothos/core';
import { GatewayServer, GatewayClient } from '@clothos/gateway';
import { ChannelManager } from '@clothos/channels';
import { TelegramAdaptor } from '@clothos/channels-telegram';
import { WhatsAppAdaptor } from '@clothos/channels-whatsapp';
import type { FileSystem, LLMServiceOptions } from '@clothos/agent-runtime';
import {
  AgentRouter,
  AgentScheduler,
  FederatedAgentRegistry,
  agentSpawnToolDefinition,
  createAgentSpawnHandler,
  agentSendToolDefinition,
  createAgentSendHandler,
  supervisorToolDefinition,
  createSupervisorHandler,
  pipelineToolDefinition,
  createPipelineHandler,
  broadcastToolDefinition,
  createBroadcastHandler,
} from '@clothos/orchestrator';
import type { AgentRegistry, RemoteDispatchTransport } from '@clothos/orchestrator';
import { wireAgent } from './agent-wiring.js';
import type { WiredAgent } from './agent-wiring.js';
import { buildAgentRegistry } from './agent-registry-impl.js';

export interface BootstrapOptions {
  configPath: string;
  basePath: string;
  fs: FileSystem;
  logger: Logger;
  /** Override LLM providers (e.g. for testing with a mock). */
  llmProviders?: LLMProvider[];
}

export interface AppServer {
  gateway: GatewayServer;
  channelManager: ChannelManager;
  agents: Map<string, WiredAgent>;
  config: ClothosConfig;
  scheduler: AgentScheduler;
  router: AgentRouter;
  agentRegistry: AgentRegistry;
  shutdown: () => Promise<void>;
}

/**
 * Bootstrap the entire application:
 * 1. Load and validate config
 * 2. Start gateway (NATS + Redis + WebSocket)
 * 3. Wire each configured agent with tools, memory, plugins, skills
 * 4. Wire orchestration: registry, scheduler, router, cross-agent tools
 * 5. Return an AppServer handle for lifecycle management
 */
export async function bootstrap(options: BootstrapOptions): Promise<AppServer> {
  const { configPath, basePath, fs, logger, llmProviders } = options;

  // 1. Load config
  const result = loadConfig(configPath);
  if (!result.valid || !result.config) {
    const errorMessages = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }
  const config = applyEnvOverrides(result.config);

  // 2. Start gateway
  const gateway = new GatewayServer(config.gateway);
  await gateway.start();
  logger.info('Gateway started');

  // 3. Wire agents
  const agents = new Map<string, WiredAgent>();

  const llmServiceOptions: LLMServiceOptions = {
    providers: llmProviders ?? [],
    models: config.models,
    auth: config.auth,
  };

  for (const agentEntry of config.agents.list) {
    try {
      const wired = await wireAgent({
        agentEntry,
        defaults: config.agents.defaults,
        compaction: config.session.compaction,
        basePath,
        fs,
        llmServiceOptions,
        toolsConfig: config.tools,
        sandboxConfig: config.sandbox,
        memoryConfig: config.memory,
        pluginsConfig: config.plugins,
        skillsConfig: config.skills,
        gateway,
        logger,
      });
      agents.set(agentEntry.id, wired);
    } catch (err) {
      logger.error(
        `Failed to wire agent "${agentEntry.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info(`${agents.size} agent(s) wired and ready`);

  // 4. Wire orchestration
  const orchestratorConfig = config.orchestrator ?? {};
  const maxConcurrent = orchestratorConfig.maxConcurrentAgents ?? config.gateway.maxConcurrentAgents;

  // 4a. Build agent registry (federated: local-first with NATS remote fallback)
  const localRegistry = buildAgentRegistry(agents);
  const natsClient = gateway.getNatsClient();
  const natsTransport: RemoteDispatchTransport = {
    publish: (subject, msg) => natsClient.publish(subject, msg),
    publishCore: (subject, msg) => natsClient.publishCore(subject, msg),
    subscribeCoreNats: (subject, handler) => natsClient.subscribeCoreNats(subject, handler),
    createInbox: () => natsClient.createInbox(),
  };
  const agentRegistry = new FederatedAgentRegistry({
    localRegistry,
    transport: natsTransport,
    remoteTimeoutMs: orchestratorConfig.remoteDispatchTimeoutMs,
  });

  // 4b. Create scheduler
  const scheduler = new AgentScheduler({ maxConcurrent });
  for (const [id, wired] of agents) {
    scheduler.registerAgent(id, (msg: string, sid?: string) => wired.manager.dispatch(msg, sid));
  }

  // 4c. Create router
  const router = new AgentRouter({
    bindings: config.bindings,
    registry: agentRegistry,
  });

  // 4d. Register orchestration tools for each agent (if policy allows)
  for (const [id, wired] of agents) {
    const ctx = { agentId: id };
    const spawnOpts = {
      registry: agentRegistry,
      callerAgentId: id,
      defaultTimeoutMs: orchestratorConfig.spawnTimeoutMs,
    };
    const sendOpts = {
      registry: agentRegistry,
      callerAgentId: id,
      defaultReplyTimeoutMs: orchestratorConfig.sendReplyTimeoutMs,
      defaultMaxExchanges: orchestratorConfig.maxExchanges,
    };

    // Register agent_spawn
    if (wired.policyEngine.isAllowed('agent_spawn', ctx)) {
      wired.registry.register(
        agentSpawnToolDefinition,
        createAgentSpawnHandler(spawnOpts),
        'orchestration',
      );
    }

    // Register agent_send
    if (wired.policyEngine.isAllowed('agent_send', ctx)) {
      wired.registry.register(
        agentSendToolDefinition,
        createAgentSendHandler(sendOpts),
        'orchestration',
      );
    }

    // Register orchestration pattern tools
    if (wired.policyEngine.isAllowed('orchestrate', ctx)) {
      wired.registry.register(
        supervisorToolDefinition,
        createSupervisorHandler(spawnOpts),
        'orchestration',
      );
    }

    if (wired.policyEngine.isAllowed('pipeline_execute', ctx)) {
      wired.registry.register(
        pipelineToolDefinition,
        createPipelineHandler(spawnOpts),
        'orchestration',
      );
    }

    if (wired.policyEngine.isAllowed('broadcast', ctx)) {
      wired.registry.register(
        broadcastToolDefinition,
        createBroadcastHandler(spawnOpts),
        'orchestration',
      );
    }

    // Rebuild effective tools after adding orchestration tools
    const effectiveTools = wired.policyEngine.getEffectiveBuiltinTools(ctx);
    const handlerMap = wired.registry.buildHandlerMap(
      effectiveTools.map((t) => t.name),
    );
    wired.manager.setTools(effectiveTools, handlerMap);
  }

  logger.info('Orchestration tools registered');

  // 5. Wire channel adaptors (connect as a regular WebSocket client)
  const channelsConfig = config.channels ?? { adaptors: {} };

  // Auto-provision service key for channel adaptors
  const keysDir = path.join(basePath, 'keys');
  await nodeFs.mkdir(keysDir, { recursive: true });
  const keyFile = path.join(keysDir, 'channels.key');

  let channelKey: string;
  try {
    channelKey = (await nodeFs.readFile(keyFile, 'utf-8')).trim();
  } catch {
    // First run — generate and persist
    channelKey = randomBytes(32).toString('hex');
    await nodeFs.writeFile(keyFile, channelKey, { mode: 0o600 });
    logger.info('Generated channel adaptor service key');
  }

  // Register with gateway so it accepts this key
  gateway.registerServiceKey('channels', channelKey);

  const gatewayClient = new GatewayClient({
    url: `ws://localhost:${config.gateway.websocket.port}/ws`,
    apiKey: channelKey,
    logger,
  });
  await gatewayClient.connect();

  const channelManager = new ChannelManager({
    gateway: gatewayClient,
    bindings: config.bindings,
    channelsConfig,
    logger,
  });

  channelManager.register(new TelegramAdaptor());
  channelManager.register(new WhatsAppAdaptor());

  await channelManager.startAll();
  logger.info('Channel adaptors started');

  // 6. Build shutdown handler
  let shutdownPromise: Promise<void> | null = null;
  let isShutdown = false;

  const shutdown = async () => {
    if (isShutdown) return;
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.info('Shutting down...');
      await channelManager.stopAll();
      await gatewayClient.disconnect();
      logger.info('Channel adaptors stopped');
      for (const [id, wired] of agents) {
        try {
          await wired.cleanup();
          logger.info(`Agent "${id}" shut down`);
        } catch (err) {
          logger.error(
            `Error shutting down agent "${id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await gateway.stop();
      logger.info('Gateway stopped');
    })();

    try {
      await shutdownPromise;
    } finally {
      isShutdown = true;
      shutdownPromise = null;
    }
  };

  return { gateway, channelManager, agents, config, scheduler, router, agentRegistry, shutdown };
}
