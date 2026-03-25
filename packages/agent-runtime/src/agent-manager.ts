import type {
  AgentControlBlock,
  AgentEvent,
  AgentMessage,
  AgentSnapshot,
  AgentStatus,
  Disposable,
  Message,
  SkillEntry,
  ToolDefinition,
} from '@clothos/core';
import { now } from '@clothos/core';
import type { NatsClient, Subscription } from '@clothos/gateway';
import { agentLoop } from './agent-loop.js';
import { ContextCompactor } from './context-compactor.js';
import { ConversationContext } from './conversation-context.js';
import { InvalidStateTransitionError } from './errors.js';
import { HookRegistry } from './hook-registry.js';
import { LLMService } from './llm-service.js';
import { createContextPrunerHandler } from './context-pruner.js';
import { registerPromptHandlers } from './prompt-assembler.js';
import type { PromptMode } from './prompt-types.js';
import { DEFAULT_BOOTSTRAP_CONFIG } from './prompt-types.js';
import { SessionStore } from './session-store.js';
import type { ToolHandlerMap } from './tool-executor.js';
import type { AgentManagerOptions, AgentState, FileSystem } from './types.js';

const VALID_TRANSITIONS: Record<string, string[]> = {
  REGISTERED: ['INITIALIZING'],
  INITIALIZING: ['READY'],
  READY: ['RUNNING', 'SUSPENDED', 'TERMINATED'],
  RUNNING: ['READY', 'SUSPENDED', 'TERMINATED', 'ERROR'],
  SUSPENDED: ['READY', 'TERMINATED'],
  ERROR: ['TERMINATED', 'INITIALIZING'],
  TERMINATED: [],
};

export class AgentManager {
  readonly agentId: string;
  private status: AgentStatus = 'REGISTERED' as AgentStatus;
  private llm: LLMService | null = null;
  private hooks = new HookRegistry();
  private sessionStore: SessionStore;
  private compactor: ContextCompactor | null = null;
  private tools: ToolDefinition[] = [];
  private toolHandlers: ToolHandlerMap = new Map();
  private skillEntries: SkillEntry[] = [];
  private context: ConversationContext | null = null;
  private currentSessionId: string | null = null;
  private loopIteration = 0;
  private inboxSubscription: Subscription | null = null;
  private persona = '';
  private promptMode: PromptMode = 'full';
  private promptDisposables: Disposable[] = [];
  private fs: FileSystem;
  private basePath: string;
  private defaults: AgentManagerOptions['defaults'];
  private compaction: AgentManagerOptions['compaction'];
  private agentEntry: AgentManagerOptions['agentEntry'];

  constructor(options: AgentManagerOptions) {
    this.agentId = options.agentEntry.id;
    this.agentEntry = options.agentEntry;
    this.defaults = options.defaults;
    this.compaction = options.compaction;
    this.basePath = options.basePath;
    this.fs = options.fs;
    this.sessionStore = new SessionStore(
      `${options.basePath}/sessions`,
      options.fs,
    );
  }

  async init(llmService: LLMService): Promise<void> {
    this.transition('INITIALIZING' as AgentStatus);
    this.llm = llmService;

    // Create workspace directories
    const agentDir = `${this.basePath}/agents/${this.agentId}`;
    const snapshotsDir = `${agentDir}/snapshots`;
    await this.fs.mkdir(agentDir, { recursive: true });
    await this.fs.mkdir(snapshotsDir, { recursive: true });

    // Load persona
    const soulPath = `${agentDir}/SOUL.md`;
    if (await this.fs.exists(soulPath)) {
      this.persona = await this.fs.readFile(soulPath);
    } else {
      this.persona =
        this.agentEntry.persona ??
        `You are ${this.agentEntry.name}. ${this.agentEntry.description ?? ''}`;
    }

    // Set up compactor
    this.compactor = new ContextCompactor({
      contextWindow: this.defaults.contextWindow,
      reserveTokens: this.compaction.reserveTokens,
    });

    // Register prompt enrichment handlers
    this.promptDisposables = registerPromptHandlers({
      hooks: this.hooks,
      agentId: this.agentId,
      agentName: this.agentEntry.name,
      agentDir,
      model: this.defaults.model,
      basePath: this.basePath,
      fs: this.fs,
      getTools: () => this.tools,
      skills: this.skillEntries,
      config: {
        promptMode: this.promptMode,
        bootstrap: DEFAULT_BOOTSTRAP_CONFIG,
      },
    });

    // Register context pruner (runs after prompt enrichment)
    const prunerDisposable = this.hooks.register(
      'context_assemble',
      createContextPrunerHandler({
        contextWindow: this.defaults.contextWindow,
      }),
      500,
    );
    this.promptDisposables.push(prunerDisposable);

    this.transition('READY' as AgentStatus);
  }

  setTools(tools: ToolDefinition[], handlers: ToolHandlerMap): void {
    this.tools = tools;
    this.toolHandlers = handlers;
  }

  setSkills(skills: SkillEntry[]): void {
    this.skillEntries = skills;
  }

  async *dispatch(
    userMessage: string,
    sessionId?: string,
  ): AsyncGenerator<AgentEvent> {
    this.transition('RUNNING' as AgentStatus);

    try {
      const llm = this.llm!;

      // Create or resume session
      if (!sessionId && this.currentSessionId) {
        sessionId = this.currentSessionId;
      } else if (!sessionId) {
        sessionId = await this.sessionStore.createSession(this.agentId);
      }
      this.currentSessionId = sessionId;
      llm.bindSession(sessionId);

      // Build or restore context
      if (!this.context) {
        let history: Message[] = [];
        try {
          history = await this.sessionStore.getHistory(
            this.agentId,
            sessionId,
          );
        } catch {
          // Session JSONL is corrupt or missing — create a fresh session
          sessionId = await this.sessionStore.createSession(this.agentId);
          this.currentSessionId = sessionId;
          llm.bindSession(sessionId);
        }
        this.context = new ConversationContext({
          agentId: this.agentId,
          sessionId,
          systemPrompt: this.persona,
          messages: history.length > 0 ? history : undefined,
        });
      }

      this.context.addUserMessage(userMessage);
      await this.sessionStore.appendEntry(this.agentId, sessionId, {
        role: 'user',
        content: userMessage,
      });

      // Check compaction
      if (this.compactor && (await this.compactor.needsCompaction(this.context, llm))) {
        await this.compactor.compact(this.context, llm, this.hooks);
      }

      // Run agent loop
      for await (const event of agentLoop(
        llm,
        this.context,
        this.tools,
        this.toolHandlers,
        this.hooks,
        { maxTurns: this.defaults.maxTurns },
      )) {
        this.loopIteration++;

        // Persist events to session JSONL
        if (event.type === 'assistant_message') {
          const msg: Message = {
            role: 'assistant',
            content: event.content.text,
            toolCalls: event.content.toolCalls,
          };
          await this.sessionStore.appendEntry(this.agentId, sessionId, msg);
        } else if (event.type === 'tool_result') {
          await this.sessionStore.appendEntry(this.agentId, sessionId, {
            role: 'tool',
            content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
            toolCallId: event.toolCallId,
          });
        }

        yield event;
      }

      await this.saveState();
      llm.unbindSession();
      this.transition('READY' as AgentStatus);
    } catch (err) {
      this.status = 'ERROR' as AgentStatus;
      throw err;
    }
  }

  async suspend(): Promise<void> {
    this.transition('SUSPENDED' as AgentStatus);

    if (this.context && this.currentSessionId) {
      const snapshot: AgentSnapshot = {
        agentId: this.agentId,
        sessionId: this.currentSessionId,
        messages: this.context.getMessages(),
        loopIteration: this.loopIteration,
        pendingToolCalls: [],
        savedAt: now(),
      };

      const snapshotPath = `${this.basePath}/agents/${this.agentId}/snapshots/${this.currentSessionId}.json`;
      await this.fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    }
  }

  async resume(): Promise<void> {
    if (this.status !== ('SUSPENDED' as AgentStatus)) {
      throw new InvalidStateTransitionError(this.status, 'READY');
    }

    if (this.currentSessionId) {
      const snapshotPath = `${this.basePath}/agents/${this.agentId}/snapshots/${this.currentSessionId}.json`;
      if (await this.fs.exists(snapshotPath)) {
        const raw = await this.fs.readFile(snapshotPath);
        const snapshot = JSON.parse(raw) as AgentSnapshot;
        this.context = new ConversationContext({
          agentId: this.agentId,
          sessionId: snapshot.sessionId,
          systemPrompt: this.persona,
          messages: snapshot.messages,
        });
        this.loopIteration = snapshot.loopIteration;
      }
    }

    this.status = 'READY' as AgentStatus;
  }

  async terminate(): Promise<void> {
    try {
      if (this.context && this.currentSessionId) {
        await this.saveState();
      }
    } catch { /* best-effort */ }

    for (const d of this.promptDisposables) {
      d.dispose();
    }
    this.promptDisposables = [];

    if (this.inboxSubscription) {
      this.inboxSubscription.unsubscribe();
      this.inboxSubscription = null;
    }
    this.transition('TERMINATED' as AgentStatus);
  }

  setPromptMode(mode: PromptMode): void {
    this.promptMode = mode;
  }

  /**
   * Subscribe to the NATS inbox and dispatch incoming messages.
   * The onResponse callback is invoked with each AgentEvent plus the
   * original message, so the app layer can route responses back.
   */
  async subscribeToInbox(
    nats: NatsClient,
    onResponse?: (event: AgentEvent, originalMsg: AgentMessage) => void,
    onDone?: (originalMsg: AgentMessage) => void,
    onBeforeDispatch?: (originalMsg: AgentMessage) => void | Promise<void>,
    onAfterDispatch?: (originalMsg: AgentMessage) => void | Promise<void>,
  ): Promise<Subscription> {
    const subject = `agent.${this.agentId}.inbox`;
    const sub = await nats.subscribe(subject, async (msg) => {
      console.log(`[INBOX] ${this.agentId} received message: type=${msg.type}, replyTo=${msg.replyTo ?? 'none'}`);
      // Extract user text from AgentMessage.data
      const data = msg.data as Record<string, unknown> | string | undefined;
      let userMessage: string;
      if (typeof data === 'string') {
        userMessage = data;
      } else if (data && typeof data === 'object' && typeof data['text'] === 'string') {
        userMessage = data['text'];
      } else {
        console.log(`[INBOX] ${this.agentId} could not extract user message, skipping`);
        return; // Can't extract a user message, skip
      }

      const sessionId = (
        typeof data === 'object' && data !== null
          ? (data['sessionId'] as string | undefined)
          : undefined
      ) ?? undefined;

      console.log(`[INBOX] ${this.agentId} dispatching: "${userMessage.slice(0, 80)}..." (status: ${this.status})`);
      try {
        await onBeforeDispatch?.(msg);
        // Re-read in case onBeforeDispatch mutated data.text
        const postData = msg.data as Record<string, unknown> | string | undefined;
        if (typeof postData === 'object' && postData && typeof postData['text'] === 'string') {
          userMessage = postData['text'];
        }
        for await (const event of this.dispatch(userMessage, sessionId)) {
          console.log(`[INBOX] ${this.agentId} event: type=${event.type}`);
          onResponse?.(event, msg);
        }
        console.log(`[INBOX] ${this.agentId} dispatch complete, calling onDone`);
        onDone?.(msg);
      } catch (err) {
        console.log(`[INBOX] ${this.agentId} dispatch error: ${err instanceof Error ? err.message : String(err)}`);
        onResponse?.(
          { type: 'error', error: err instanceof Error ? err.message : String(err) },
          msg,
        );
      } finally {
        await onAfterDispatch?.(msg);
      }
    });
    this.inboxSubscription = sub;
    return sub;
  }

  getControlBlock(): AgentControlBlock {
    return {
      agentId: this.agentId,
      status: this.status,
      priority: 0,
      loopIteration: this.loopIteration,
      tokenUsage: this.llm?.getSessionTokenUsage() ?? {
        input: 0,
        output: 0,
        total: 0,
      },
      snapshotRef: this.currentSessionId
        ? `${this.basePath}/agents/${this.agentId}/snapshots/${this.currentSessionId}.json`
        : undefined,
      createdAt: now(),
      lastActiveAt: now(),
    };
  }

  getHookRegistry(): HookRegistry {
    return this.hooks;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  async restoreLastSession(): Promise<void> {
    try {
      const statePath = `${this.basePath}/agents/${this.agentId}/state.json`;
      if (!(await this.fs.exists(statePath))) return;

      const raw = await this.fs.readFile(statePath);
      const state = JSON.parse(raw) as AgentState;
      const history = await this.sessionStore.getHistory(
        this.agentId,
        state.currentSessionId,
      );

      if (history.length > 0) {
        this.context = new ConversationContext({
          agentId: this.agentId,
          sessionId: state.currentSessionId,
          systemPrompt: this.persona,
          messages: history,
        });
        this.currentSessionId = state.currentSessionId;
      }
    } catch {
      // Corrupt or missing — start fresh
    }
  }

  getContext(): ConversationContext | null {
    return this.context;
  }

  private async saveState(): Promise<void> {
    if (!this.currentSessionId) return;
    const state: AgentState = {
      currentSessionId: this.currentSessionId,
      lastActiveAt: now(),
    };
    const statePath = `${this.basePath}/agents/${this.agentId}/state.json`;
    await this.fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  private transition(to: AgentStatus): void {
    const allowed = VALID_TRANSITIONS[this.status];
    if (!allowed || !allowed.includes(to)) {
      throw new InvalidStateTransitionError(this.status, to);
    }
    this.status = to;
  }
}
