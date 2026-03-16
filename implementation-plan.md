# Agentic Operating System — Phased Implementation Plan

> **Stack:** TypeScript · Node.js ≥ 22 · pnpm · Turborepo · pi-mono · NATS JetStream · Redis · SQLite (FTS5 + sqlite-vec) · Docker
> **Guiding principle:** Every phase delivers a working, testable system. Each phase extends — never rewrites — the previous one.

---

## Phase 0 — Project Scaffold & Core Contracts (Week 1–2) ✅ COMPLETE

### Goal
Establish the monorepo, define every shared type and interface that downstream phases will code against, and verify the toolchain.

### What we build

**Monorepo structure** using pnpm workspaces + Turborepo:

```
clothos/
├── packages/
│   ├── core/               # Shared types, interfaces, utilities
│   ├── gateway/            # Central messaging gateway
│   ├── agent-runtime/      # Agent loop & lifecycle
│   ├── memory/             # Episodic memory subsystem (SQLite + FTS5 + sqlite-vec)
│   ├── tools/              # Tool registry, sandboxing, MCP
│   ├── plugins/            # Plugin loader & skill system
│   ├── orchestrator/       # Multi-agent routing
│   └── typescript-config/  # Shared tsconfig.json presets
├── config/
│   └── default.json5       # Master configuration schema
├── scripts/                # Dev tooling, Docker helpers
├── docker/                 # Dockerfiles, compose files
├── pnpm-workspace.yaml     # Workspace package globs
├── turbo.json              # Turborepo task pipeline
├── package.json            # Root: turbo devDep, workspace scripts
└── pnpm-lock.yaml          # Single lockfile for all packages
```

**Why pnpm + Turborepo over npm workspaces.** pnpm's content-addressable store hard-links every dependency file exactly once on disk, delivering ~4× faster installs and ~75% less disk usage than npm. Its non-flat `node_modules/` structure prevents phantom dependencies — if a package doesn't declare a dependency in its own `package.json`, the import fails immediately rather than silently succeeding via hoisting. Turborepo layers on top as a build orchestrator (not a package manager): it reads the pnpm lockfile to understand the dependency graph, topologically sorts tasks, runs independent tasks in parallel, and caches outputs by content hash. Cached rebuilds complete in milliseconds instead of seconds.

**`pnpm-workspace.yaml`:**
```yaml
packages:
  - "packages/*"
```

**`turbo.json` — task pipeline:**
```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "check-types": {
      "dependsOn": ["^check-types"]
    },
    "test": {
      "dependsOn": ["build"],
      "inputs": ["src/**/*.ts", "tests/**/*.ts"],
      "outputs": ["coverage/**"]
    },
    "lint": {},
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

The `^` prefix in `dependsOn` means "run this task in my dependency packages first" — so `packages/gateway` (which depends on `packages/core`) will always see `core` built before its own build starts. Independent tasks like `lint` across packages run in parallel across all CPU cores.

**Internal package references** use the pnpm workspace protocol. Every `package.json` that depends on `@clothos/core` declares:
```json
{ "dependencies": { "@clothos/core": "workspace:*" } }
```
pnpm links the local package during development and substitutes the real published version on `pnpm publish`.

**`packages/core` — the type authority.** Every other package imports from here; nothing imports the other direction. Define:

```typescript
// Message envelope (CloudEvents v1.0 + agent extensions)
interface AgentMessage {
  id: string;                    // UUIDv7
  specversion: "1.0";
  type: string;                  // e.g. "task.request", "tool.invoke"
  source: string;                // "agent://{id}" | "gateway://{nodeId}"
  target: string;                // "agent://{id}" | "topic://{name}"
  time: string;                  // RFC 3339
  datacontenttype: string;
  data: unknown;
  correlationId?: string;
  causationId?: string;
  replyTo?: string;
  idempotencyKey?: string;
  sequenceNumber?: number;
  ttl?: number;
  traceContext?: { traceId: string; spanId: string; traceFlags: number };
  metadata?: Record<string, string>;
}

// Agent lifecycle
enum AgentStatus {
  REGISTERED, INITIALIZING, READY, RUNNING, SUSPENDED, TERMINATED, ERROR
}

// Agent Control Block
interface AgentControlBlock {
  agentId: string;
  status: AgentStatus;
  priority: number;
  currentTaskId?: string;
  loopIteration: number;
  tokenUsage: { input: number; output: number; total: number };
  snapshotRef?: string;
  createdAt: string;
  lastActiveAt: string;
}

// Plugin contract
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  dependencies?: Record<string, string>;
  capabilities?: ("tools" | "hooks" | "commands" | "skills")[];
}

interface Plugin {
  manifest: PluginManifest;
  onLoad(ctx: PluginContext): Promise<void>;
  onUnload(): Promise<void>;
}

interface PluginContext {
  registerTool(def: ToolDefinition): void;
  registerHook(event: LifecycleEvent, handler: HookHandler): Disposable;
  registerCommand(name: string, handler: CommandHandler): Disposable;
  getService<T>(name: string): T;
  logger: Logger;
  config: Record<string, unknown>;
}

// Tool definition (MCP-compatible)
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    riskLevel: "green" | "yellow" | "red" | "critical";
  };
}

// LLM provider contract (provider-agnostic — implementations in Phase 2)
interface LLMProvider {
  id: string;
  streamCompletion(
    messages: Message[],
    tools: ToolDefinition[],
    options: CompletionOptions
  ): AsyncIterable<StreamChunk>;
  countTokens(messages: Message[]): Promise<number>;
  supportsPromptCaching: boolean;
}

// Lifecycle hook events
type LifecycleEvent =
  | "input" | "before_agent_start" | "agent_start"
  | "turn_start" | "context_assemble"
  | "tool_call" | "tool_execution_start" | "tool_execution_end" | "tool_result"
  | "turn_end" | "agent_end"
  | "memory_flush" | "session_compact";
```

**Master configuration schema** (`config/default.json5`) — JSON5 format following OpenClaw's model. Define sections for `gateway`, `agents`, `bindings`, `models`, `auth`, `session`, `tools`, `sandbox`, and `plugins`. Use JSON Schema for validation, with strict-mode rejecting unknown keys.

**Toolchain:** TypeScript 5.x with strict mode, Vitest for testing, ESLint + Prettier, `tsup` for builds. pnpm as package manager (enforce via `corepack enable && corepack prepare pnpm@latest --activate` and a root `"packageManager": "pnpm@10.x.x"` field). Turborepo as task orchestrator (`pnpm add -Dw turbo`). Every package exposes a clean `index.ts` barrel.

### How to verify
- `turbo run build` compiles the full workspace in dependency order with zero errors.
- `turbo run test` runs type-level tests confirming all interfaces are importable cross-package.
- `turbo run check-types` passes with no TypeScript errors across all packages.
- Running `turbo run build` a second time with no changes completes in <1 second (cache hit).
- The config validator rejects malformed JSON5 and unknown keys.

---

## Phase 1 — Central Messaging Gateway (Week 3–5) ✅ COMPLETE

### Goal
Stand up the message bus so every subsequent component has a communication backbone from day one.

### What we build

**NATS JetStream server** via Docker Compose. Define three persistent streams:

| Stream | Subjects | Retention | Purpose |
|--------|----------|-----------|---------|
| `AGENT_TASKS` | `agent.*.inbox` | WorkQueue | Direct agent-to-agent commands |
| `AGENT_EVENTS` | `events.agent.>` | Interest | Pub/sub broadcasts |
| `SYSTEM` | `system.>` | Limits (7d) | Heartbeats, config reload, DLQ |

Configure `max_deliver: 3`, `ack_wait: 30s`, and a dead-letter republish rule that moves failed messages to `system.dlq.>` with failure metadata headers.

**Gateway server** (`packages/gateway`) — a Node.js process that:

1. **Connects to NATS** on startup, creates/verifies the three streams.
2. **Opens a WebSocket** on a configurable port (default `18789`). Incoming connections authenticate via a bearer token from the config.
3. **Implements a Lane Queue** — a per-session serial execution queue. Key sessions by `{agentId}:{channelId}:{userId}`. Only one message processes per lane at a time; others queue in order. This prevents race conditions in agent state.
4. **Routes messages** by inspecting `AgentMessage.target`:
   - `agent://{id}` → publish to `agent.{id}.inbox`
   - `topic://{name}` → publish to `events.agent.{name}`
5. **Exposes four messaging patterns** through helper functions:
   - `publish(msg)` — fire-and-forget onto a NATS subject.
   - `request(msg, timeoutMs)` — uses NATS native request/reply with `_INBOX` subjects. Returns the correlated response or throws on timeout.
   - `fanOut(msgs[], timeoutMs)` — publishes N messages with a shared `correlationId`, collects responses with a deadline, returns partial results on timeout.
   - `subscribe(subject, queueGroup?, handler)` — registers a push or pull consumer.
6. **Idempotency layer** — on message publish, set the `Nats-Msg-Id` header to `msg.idempotencyKey ?? msg.id` for JetStream server-side dedup (2-minute window). On message consume, check Redis `SETNX agentos:idem:{idempotencyKey} 1 EX 86400` before processing.
7. **Circuit breaker** per downstream target — tracks failure counts, transitions CLOSED → OPEN (after 5 failures in 60s) → HALF_OPEN (after 30s cooldown). When open, **pause the NATS consumer** (don't reject to DLQ) so messages accumulate in the stream and drain naturally on recovery.

**Redis** via Docker Compose for idempotency keys, session state caching, and presence tracking.

**Health & readiness endpoints** — HTTP `/health` and `/ready` that verify NATS and Redis connectivity.

### How to verify
- Integration test: two test clients connect via WebSocket, one publishes a `task.request` message targeting the other, and the second receives it within 100ms.
- Request/reply test: client A sends a request, client B responds, client A receives the correlated reply.
- Idempotency test: publish the same message ID twice; the handler fires exactly once.
- Circuit breaker test: simulate 5 consecutive consumer failures; verify the consumer pauses and resumes after cooldown.
- DLQ test: publish a message that NAKs 3 times; verify it appears on `system.dlq.>`.

---

## Phase 2 — Agent Runtime & Lifecycle (Week 6–9) ✅ COMPLETE

### Goal
Build the agent execution engine — the loop that calls the LLM, executes tools, and manages agent state transitions.

### What we build

**LLM abstraction layer** — define a provider-agnostic `LLMProvider` interface in `@clothos/core` that any backend must implement:

```typescript
interface LLMProvider {
  id: string;
  streamCompletion(
    messages: Message[],
    tools: ToolDefinition[],
    options: CompletionOptions
  ): AsyncIterable<StreamChunk>;
  countTokens(messages: Message[]): Promise<number>;
  supportsPromptCaching: boolean;
}
```

The default implementation, `PiMonoProvider`, wraps `@mariozechner/pi-ai` from pi-mono. Alternative providers (e.g., Vercel AI SDK, direct HTTP) can be swapped in by implementing the same interface — no other code changes required.

The `LLMService` class orchestrates providers:
- Reads provider credentials from the config's `auth` section.
- Accepts a `LLMProvider[]` and selects the active provider based on config and availability.
- Implements **auth profile rotation**: try profiles in order within a provider, then fall back across providers using the `models.fallbacks` array. Session-sticky profile selection (same profile for the lifetime of a session, reset on new session or compaction).
- Exposes `streamCompletion(messages, tools, options)` returning an async iterable of chunks (delegates to the active provider).
- Tracks token usage per call and cumulative per session.

**Agent loop** (`packages/agent-runtime`) — an async generator following pi-mono's pattern:

```typescript
interface AgentLoopOptions {
  maxTurns?: number;  // Default: 100. Hard ceiling to prevent runaway loops.
}

async function* agentLoop(
  llm: LLMService,
  context: ConversationContext,
  tools: ToolDefinition[],
  hooks: HookRegistry,
  options: AgentLoopOptions = {}
): AsyncGenerator<AgentEvent> {

  const maxTurns = options.maxTurns ?? 100;
  let turnCount = 0;

  await hooks.fire("before_agent_start", context);

  while (true) {
    if (++turnCount > maxTurns) {
      yield { type: "max_turns_reached", turns: turnCount - 1 };
      break;
    }

    await hooks.fire("turn_start", context);

    // Let plugins modify context before LLM call
    const assembled = await hooks.fire("context_assemble", context);

    const response = await llm.streamCompletion(
      assembled.messages, tools, assembled.options
    );

    yield { type: "assistant_message", content: response };

    if (!response.toolCalls?.length) break;  // Agent decided it's done

    for (const call of response.toolCalls) {
      const allowed = await hooks.fire("tool_call", call);
      if (allowed.blocked) {
        yield { type: "tool_blocked", name: call.name, reason: allowed.reason };
        continue;
      }

      await hooks.fire("tool_execution_start", call);
      const result = await executeToolCall(call, context);
      await hooks.fire("tool_execution_end", call, result);

      yield { type: "tool_result", name: call.name, result };
      context.messages.push(/* assistant msg + tool result */);
    }

    await hooks.fire("turn_end", context);
  }

  await hooks.fire("agent_end", context);
}
```

**Agent lifecycle state machine** — the `AgentManager` class tracks each agent's `AgentControlBlock` and enforces valid transitions:

```
REGISTERED ──init()──→ INITIALIZING ──loaded──→ READY
                           │                       │
                       error/timeout          dispatch()
                           ↓                       ↓
                         ERROR ←──fatal──── RUNNING
                           │                  │   │
                      cleanup()          suspend  done
                           ↓              ↓       ↓
                      TERMINATED ←──── SUSPENDED  TERMINATED
                                           │
                                      resume()──→ READY
```

On `init()`: load agent config, allocate workspace directory, load persona files (`SOUL.md`, `AGENTS.md`, `USER.md`), bind to an LLM provider, restore snapshot if one exists. On `dispatch()`: pop a message from the agent's lane queue, set status to RUNNING, invoke the agent loop. On `suspend()`: serialize the `AgentSnapshot` (messages, loop iteration, pending tool calls, workspace git hash) to disk as JSON, set status to SUSPENDED. On `resume()`: deserialize the snapshot, restore context, set status to READY.

**Session management** — each session is a JSONL file under `~/.clothos/sessions/{agentId}/{sessionId}.jsonl`. First line is the session header (ID, created timestamp, agent ID, channel). Subsequent lines are entries with `id`, `parentId` (for branching), `role`, `content`, and `timestamp`. Implement `createSession()`, `appendEntry()`, `getHistory()`, and `forkSession()`.

**Context compaction** — when total tokens exceed `contextWindow - reserveTokens` (default reserve: 20,000):
1. Fire `memory_flush` hook — triggers the memory subsystem (Phase 3) to persist durable state.
2. Summarize the conversation using a dedicated LLM call with a compaction prompt.
3. Replace the message history with: system prompt + compaction summary + last 3 exchanges.
4. Fire `session_compact` hook.
5. Full transcript remains in the JSONL file for later retrieval.

**Gateway integration** — each `AgentManager` instance subscribes to `agent.{agentId}.inbox` via the gateway. Incoming messages enter the lane queue and trigger `dispatch()`.

### How to verify
- Unit test: the agent loop with a mock LLM that returns a text response terminates after one turn.
- Unit test: the agent loop with a mock LLM that returns a tool call, then text, runs exactly two turns.
- Unit test: the agent loop with a mock LLM that always returns tool calls hits `maxTurns` and yields `max_turns_reached` instead of looping forever.
- Integration test: send a message via the gateway to a registered agent; receive a response routed back through the gateway.
- Lifecycle test: init → dispatch → suspend → resume → dispatch → terminate. Verify snapshot round-trips correctly.
- Compaction test: feed 100 messages into a session, trigger compaction, verify the context shrinks while the JSONL file retains everything.

---

## Phase 3 — Memory Subsystem (Week 10–13) ✅ COMPLETE

### Goal
Give agents persistent episodic memory across sessions using SQLite-only storage (no new infrastructure dependencies), with agent-initiated memory tools rather than auto-injection.

### Design decisions (simplified from original plan)

After comparing our original design against OpenClaw (SQLite-only, agent-initiated search, proven in production) and Claude Code (pure filesystem, no vector search), we simplified Phase 3:

- **SQLite-only** storage (sqlite-vec + FTS5) instead of Qdrant + Redis — zero new infrastructure.
- **Agent-initiated memory tools** (`memory_search`, `memory_get`) instead of auto-injecting context every turn via `context_assemble` hooks.
- **Deferred knowledge graph** (entities, relationships, bi-temporal edges) to a later phase.
- **Skipped Redis working memory** — `ConversationContext` + `SessionStore` from Phase 2 already cover working memory needs.

### What we built

**Package:** `packages/memory/` (`@clothos/memory`) — 13 source files, 83 tests across 9 test suites.

**SQLite schema** — one database per agent. WAL mode + `busy_timeout=5000` for concurrency:

```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  token_count INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'conversation',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  CHECK (importance >= 0.0 AND importance <= 1.0)
);
-- Indexes on agent_id, session_id, created_at, importance, source_type

-- FTS5 for BM25 keyword search (synced via INSERT/UPDATE/DELETE triggers)
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='rowid');

-- sqlite-vec for vector similarity search (created only if extension loads)
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[{dimensions}]);

CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

**`EpisodicMemoryStore`** (`memory-store.ts`) — the core store class:
- Constructor: `{ agentId, dbPath, config, embeddingProvider }`
- `open()` — loads sqlite-vec (graceful fallback if unavailable), creates tables, enables WAL. Tracks `hasVectorSupport: boolean` flag.
- `close()` — closes db connection.
- `upsertChunks(chunks[])` — inserts into all three tables (chunks, FTS5, vec) within a transaction.
- `search(options: SearchOptions)` — hybrid search pipeline (BM25 + vector → fusion → temporal decay → MMR).
- `get(options: GetOptions)` — retrieve by ID, date, or session.
- `updateImportance(chunkIds[], importance)` — update scores (clamped to [0, 1]).
- `stats()` — chunk count, db size, vector support status.

**Hybrid search pipeline** (`hybrid-search.ts`) — pure math, no I/O:
1. Vector search + BM25 search fetch `maxResults × 4` candidates each.
2. Normalize scores to [0, 1] via min-max normalization.
3. Union merge with weighted fusion: `0.7 × vectorScore + 0.3 × bm25Score`.
4. Temporal decay: `score *= 2^(-(daysSinceCreation / halfLifeDays))` (default 30-day half-life).
5. MMR re-ranking for diversity (lambda=0.6, Jaccard similarity for content distance).
6. Return top-K results.
7. Falls back to BM25-only when embeddings unavailable.

**Memory tools** (`memory-tools.ts`) — two `ToolDefinition` objects + `ToolHandler` functions:
- **`memory_search`** — `{ query, max_results?, min_importance?, date_from?, date_to? }` — runs hybrid search, returns formatted results.
- **`memory_get`** — `{ id?, date?, session_id?, limit? }` — retrieves specific chunks or daily log content.
- Both are `readOnly`, `riskLevel: 'green'`. Handler type matches `ToolHandler = (args) => Promise<unknown>` from `agent-runtime/tool-executor.ts`.

**Memory flush handler** (`memory-flush-handler.ts`) — registered on the `memory_flush` lifecycle event. When `ContextCompactor.compact()` fires the hook:
1. Extracts conversation history from context.
2. Scores importance via `HeuristicImportanceScorer`.
3. Chunks the conversation text.
4. Embeds chunks (batch, with graceful failure).
5. Upserts into episodic store.
6. Returns context unchanged (pass-through).

**Chunker** (`chunker.ts`) — sentence-aligned text chunking:
- Splits text at sentence boundaries (`.!?` followed by whitespace).
- Accumulates to ~400 tokens per chunk with 80-token overlap.
- Token estimation: `Math.ceil(text.length / 4)` (matches existing `PiMonoProvider` heuristic).
- Handles oversized single sentences by emitting them as standalone chunks.

**Importance scorer** (`importance-scorer.ts`) — heuristic-based (LLM-based scorer can replace it):
- Boosts: decisions (+0.15), action items (+0.1), Q&A content (+0.05), code (+0.1).
- Penalizes very short content (-0.1).
- Clamps result to [0, 1].

**Embedding providers:**
- `NullEmbeddingProvider` (`embedding-provider.ts`) — returns empty arrays (BM25-only fallback). `dimensions = 0`.
- `OpenAIEmbeddingProvider` (`openai-embedding-provider.ts`) — direct `fetch()` to OpenAI API (no SDK dependency). Supports `text-embedding-3-large` at 1024 dims, batched at 64 texts per request.

**Daily log helpers** (`daily-log.ts`) — `readDailyLog()`, `listDailyLogs()`, `appendDailyLog()` for reading/writing `memory/YYYY-MM-DD.md` files.

### Integration with existing code

**No circular dependencies:** `@clothos/memory` depends on `@clothos/core` and `@clothos/agent-runtime`. Neither depends back on memory. Wiring happens at the application level via existing public APIs:
- `AgentManager.getHookRegistry()` → register `memory_flush` handler.
- `AgentManager.setTools()` → add memory tools + handlers.

**Files modified:**
- `packages/core/src/config.ts` — added `MemoryConfig` interface and optional `memory?` field to `ClothosConfig`.
- `packages/core/src/config-validator.ts` — added `'memory'` to `VALID_TOP_LEVEL_KEYS` (separate from `REQUIRED_SECTIONS`).
- `packages/core/src/index.ts` — exported `MemoryConfig` type.
- `config/default.json5` — added `memory` section with defaults (embedding, search weights, chunking, importance scoring, daily log).
- `knip.json` — added `packages/memory` workspace entry.
- `package.json` — added `better-sqlite3` to `pnpm.onlyBuiltDependencies`.

**Dependencies:** `better-sqlite3` (native SQLite bindings), `sqlite-vec` (vector extension, optional), `@types/better-sqlite3`. No OpenAI SDK.

### Configuration

Added to `config/default.json5`:
```json5
memory: {
  enabled: true,
  embedding: {
    provider: 'openai',           // 'openai' | 'none'
    dimensions: 1024,
    model: 'text-embedding-3-large',
    apiKeyEnv: 'OPENAI_API_KEY',
    batchSize: 64,
  },
  search: {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    decayHalfLifeDays: 30,
    mmrLambda: 0.6,
    defaultMaxResults: 10,
  },
  chunking: {
    targetTokens: 400,
    overlapTokens: 80,
    maxChunkTokens: 600,
  },
  importanceScoring: {
    enabled: true,
    defaultImportance: 0.5,
  },
  dailyLog: {
    enabled: true,
    directory: 'memory',
  },
},
```

The `memory` section is optional — when absent, all memory initialization is skipped.

### Deferred to future phases
- **Knowledge graph** (entities, relationships, bi-temporal edges) — deferred until semantic memory queries justify the complexity.
- **Redis working memory** — `ConversationContext` + `SessionStore` already cover this.
- **Auto-injection via `context_assemble` hook** — replaced with agent-initiated `memory_search` tool for simpler, more predictable behavior.
- **LLM-based importance scoring** — using heuristic scorer for now; LLM-based scorer can be swapped in via the `ImportanceScorer` interface.

### How to verify
- `turbo run build` — compiles all packages including memory.
- `turbo run check-types` — no TypeScript errors.
- `turbo run test` — all 83 memory tests pass across 9 test files:
  - Chunker: correct chunk sizes, sentence alignment, overlap, oversized sentence handling.
  - Hybrid search: normalization, fusion math, temporal decay curve, cosine similarity, MMR diversity.
  - Memory store: upsert/search/get round-trips with real SQLite, BM25 search, importance updates, metadata preservation, limit enforcement.
  - Memory tools: valid search returns results, missing query returns error, respects max_results, retrieval by ID/session/date.
  - Memory flush: conversation is chunked and stored, handles empty history, invalid context, importance scores applied.
  - Schema: table creation, index creation, FTS5 triggers sync, constraint enforcement, WAL/busy_timeout pragmas.
  - Embedding providers: NullEmbeddingProvider returns empty arrays, correct dimensions.
  - Importance scorer: default scores, decision/action/code boosts, short content penalty, clamping.
  - Daily log: read/write/list/append operations, non-existent file handling.
  - Graceful degradation: works without sqlite-vec (BM25-only).
- `npx knip` — no unused exports or dependencies.

---

## Phase 4 — Tool System & Sandboxing (Week 14–17) ✅ COMPLETE

### Goal
Build a secure, extensible tool execution layer with Docker sandboxing and MCP-based tool registration.

### Design decisions

- **`ToolHandler`/`ToolHandlerMap` moved to core** — these pure type aliases are imported by both `memory` and `tools`. Moving them to `core/src/tools.ts` avoids a `tools → agent-runtime` dependency. Re-exported from `agent-runtime` for backward compatibility.
- **Docker via CLI, not dockerode** — shells out to the `docker` CLI using Node's `child_process.execFile`. Matches the project's minimal-dependency philosophy. Scope limited to `create`/`start`/`exec`/`stop`/`rm`.
- **MCP via `@modelcontextprotocol/sdk`** — official SDK, only new external dependency.
- **No changes to agent-runtime** — the tool registry + policy engine produce `ToolDefinition[]` + `ToolHandlerMap` that plug directly into the existing `AgentManager.setTools()` API. Application-level wiring connects them.
- **Tool groups for policy config** — OpenClaw-inspired shorthand (`group:fs`, `group:runtime`, etc.) expanded during policy resolution. Cleaner config for multi-agent setups in Phase 6.

### What we built

**Package:** `packages/tools/` (`@clothos/tools`) — 22 source files, 108 tests across 11 test suites.

**Core type extensions** (`packages/core/src/tools.ts`) — added types shared across packages:

```typescript
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
type ToolHandlerMap = Map<string, ToolHandler>;
type ToolSource = 'builtin' | 'mcp' | 'plugin' | 'memory';

interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  source: ToolSource;
  mcpServer?: string;
}

interface PolicyContext {
  agentId: string;
  sessionId?: string;
  sandboxMode?: 'off' | 'non-main' | 'all';
}
```

`agent-runtime/src/tool-executor.ts` now imports `ToolHandler`/`ToolHandlerMap` from core instead of defining locally. `agent-runtime/src/index.ts` re-exports from core for backward compatibility — the `memory` package (which imports `ToolHandler` from `agent-runtime`) continues to work unchanged.

**Tool registry** (`registry.ts`) — central in-memory registry, single source of truth for all tool registrations:
- `register(definition, handler, source, mcpServer?)` — throws `ToolConflictError` on duplicate name.
- `unregister(name)`, `get(name)`, `has(name)`, `getAll()`, `getBySource(source)`.
- `buildHandlerMap(names?)` — returns `ToolHandlerMap` compatible with `executeToolCall()`.
- `getDefinitions(names?)` — returns `ToolDefinition[]` for LLM context.
- `clear()`, `size`.

**Error classes** (`errors.ts`) — `ToolConflictError`, `ToolNotFoundError`, `ToolValidationError`, `SandboxError`, `McpConnectionError`.

**Tool groups** (`tool-groups.ts`) — static group definitions for policy shorthand:

```typescript
const TOOL_GROUPS: Record<string, string[]> = {
  'group:runtime': ['bash'],
  'group:fs':      ['read_file', 'write_file', 'edit_file'],
  'group:fs_read': ['read_file'],
  'group:fs_write': ['write_file', 'edit_file'],
  'group:memory':  ['memory_search', 'memory_get'],
  'group:mcp':     ['use_mcp_tool'],
};
```

`expandGroups(entries)` expands `group:*` entries into constituent tool names. Unknown group names pass through as literals.

**Layered tool policy engine** (`policy-engine.ts`) — resolves effective permissions for any `(agent, tool, context)` tuple. The policy chain narrows permissions top-to-bottom; deny always wins:

```
Global Policy (config.tools.allow / deny)
  → Agent Policy (agents.list[].tools)
```

Each layer can only remove tools from the set, never add ones denied by a parent layer. Group expansion (`group:fs`, `group:runtime`, etc.) is applied before matching. The engine exposes three methods:
- `getEffectiveBuiltinTools(ctx: PolicyContext): ToolDefinition[]` — returns built-in + memory + `use_mcp_tool` meta-tool + pinned MCP tools, filtered by policy.
- `getEffectiveMcpCatalog(ctx: PolicyContext): { name, description }[]` — returns compact catalog of allowed MCP tools (excludes pinned).
- `isAllowed(toolName, ctx): boolean` — check a single tool.

**Built-in tools** (`builtin/`) — the foundational four:

*Risk classifier* (`risk-classifier.ts`):
- `classifyCommandRisk(command): RiskAssessment` — splits chained commands (`&&`, `||`, `;`, `|`), classifies each segment, highest risk wins:
  - CRITICAL (always block): `rm -rf /`, `dd if=`, fork bombs, `shutdown`, `reboot`, `mkfs`, `init 0`
  - RED (confirmation required): `rm`, `curl`, `wget`, `docker`, `sudo`, `pip install`, `npm publish`, `chmod`, `chown`
  - YELLOW (log + execute): `git`, `grep`, `find`, `npm`, `node`, `python`, `make`, `cargo`, `go`
  - GREEN (auto-approve): `ls`, `pwd`, `cat`, `echo`, `head`, `tail`, `wc`, `date`, `whoami`, `env`, `which`, `true`, `false`, `test`, `printf`
  - Unknown commands default to YELLOW.
- `sanitizeArguments(command): string | null` — blocks `$()`, backticks, `LD_PRELOAD=`, `LD_LIBRARY_PATH=`, `PATH=` at start, `--exec`/`-exec` on find/git, `--upload-pack`, `--post-checkout` on git. Returns null if safe.

*Bash tool* (`bash-tool.ts`, `bash-handler.ts`):
- `bashToolDefinition` — ToolDefinition with `riskLevel: 'red'`, accepts `command` (string, required) and `timeout` (number, optional).
- `createBashHandler(options): ToolHandler` — flow: classify risk → if CRITICAL, block → sanitize args → if blocked, error → if RED and not yoloMode, error → execute via sandbox or direct `child_process.execFile` → return `{ stdout, stderr, exitCode }`.

*File tools* (`file-tools.ts`):
- `readFileToolDefinition` (`riskLevel: 'green'`) — supports `path`, `offset`, `limit`.
- `writeFileToolDefinition` (`riskLevel: 'yellow'`) — creates parent directories, writes content.
- `editFileToolDefinition` (`riskLevel: 'yellow'`) — unique string replacement (0 matches = error, >1 matches = error).
- All paths resolved relative to `workspaceRoot`. Path traversal (`../` escape) blocked.

*Registration helper* (`register.ts`):
- `registerBuiltinTools(registry, options)` — creates all handlers via factory functions, registers all 4 built-in tools with `source: 'builtin'`.

**Docker sandboxing** (`sandbox/`) — container lifecycle management via Docker CLI:

*Exec utility* (`exec-util.ts`) — promise wrapper for `child_process.execFile` with timeout. Always resolves (never rejects) so callers can inspect stdout/stderr/exitCode.

*Docker CLI wrappers* (`docker-cli.ts`):
- `dockerCreate(options)` — builds `docker create` with full security hardening: `--memory`, `--cpus`, `--pids-limit`, `--network`, `--read-only` (if configured), `--tmpfs /tmp:rw,noexec,nosuid`, `--security-opt no-new-privileges`, `--cap-drop ALL`, `--user 1000:1000`, workspace bind mount.
- `dockerStart(id)`, `dockerExec(id, command, timeout)`, `dockerRemove(id)`, `dockerInfo()`.

*Sandbox manager* (`sandbox-manager.ts`) — higher-level manager:
- `getOrCreate(scopeKey, workspaceDir)` — reuses containers per scope key (named `agentic-sandbox-{scopeKey}`).
- `exec(containerId, command, timeout)`, `destroy(scopeKey)`, `destroyAll()`, `isDockerAvailable()`.

*Dockerfile* (`docker/Dockerfile.sandbox`) — minimal image based on `node:22-slim` with git, curl, python3. Non-root `sandbox` user (UID/GID 1000). Runs `sleep infinity` to stay alive for `docker exec`.

**MCP integration** (`mcp/`) — MCP client with lazy tool loading using `@modelcontextprotocol/sdk`:

*Client connection* (`mcp-client-connection.ts`) — wraps a single MCP server:
- `connect()` — `StdioClientTransport` for stdio, `StreamableHTTPClientTransport` for http-sse.
- `listTools()` — discovers tools, maps to `McpToolInfo`.
- `callTool(name, args)` — routes to backend, handles errors.
- `onToolsChanged(callback)` — listens for `notifications/tools/list_changed` for hot-reload.
- `disconnect()`.

*Client manager* (`mcp-client-manager.ts`) — manages connections to multiple MCP servers:
- `connectAll()` — connects all configured servers in parallel (`Promise.allSettled`), tolerates partial failures.
- `connect(config)` — connects one server, discovers tools, namespaces as `{serverName}__{toolName}`, registers in ToolRegistry with `source: 'mcp'`, sets up hot-reload.
- `disconnect(serverName)` — unregisters all tools from server.
- `callTool(namespacedName, args)` — routes to correct backend, strips namespace.
- `getAllTools()` — returns all discovered MCP tools.
- `getToolSchema(namespacedName)` — returns input schema for validation.

*Schema validator* (`schema-validator.ts`) — lightweight JSON Schema validation for MCP tool args:
- `validateToolArgs(args, schema): ValidationResult` — checks `required` fields and `properties` type matching (`string`, `number`, `integer`, `boolean`, `object`, `array`).
- `formatValidationErrors(errors, schema): string` — readable string with schema hints for LLM self-correction.

*Meta-tool* (`use-mcp-tool.ts`):
- `useMcpToolDefinition` — `name: 'use_mcp_tool'`, accepts `tool_name` (string) and `arguments` (object), `riskLevel: 'yellow'`.
- `createUseMcpToolHandler(mcpManager, policyEngine, getContext): ToolHandler` — checks policy → validates args against schema → routes via mcpManager → returns result. On validation failure, includes schema fields in error message for self-correction.

*Catalog* (`catalog.ts`):
- `buildMcpCatalog(allTools, pinnedNames)` — compact `{ name, description }[]` excluding pinned tools.
- `getPinnedToolDefinitions(pinnedNames, getDefinition)` — full ToolDefinitions for pinned MCP tools.
- `formatMcpCatalog(catalog)` — XML string (`<available-mcp-tools>`) for system prompt injection.

**Prompt integration** (`prompt-integration.ts`):
- `createMcpCatalogPromptHandler(getCatalogText): HookHandler` — `context_assemble` hook handler that injects the MCP catalog into the system prompt. Follows the same `appendToSystemPrompt` pattern from `agent-runtime/src/prompt-handlers.ts`.

### Integration with existing code

**No circular dependencies:** `@clothos/tools` depends on `@clothos/core` and `@modelcontextprotocol/sdk`. Neither `core` nor `agent-runtime` depends back on tools. Wiring happens at the application level via existing public APIs:
- `AgentManager.setTools()` — accepts `ToolDefinition[]` + `ToolHandlerMap` produced by `ToolRegistry.getDefinitions()` + `ToolRegistry.buildHandlerMap()`.
- `AgentManager.getHookRegistry()` → register `context_assemble` handler for MCP catalog injection.

**Files modified:**
- `packages/core/src/tools.ts` — added `ToolHandler`, `ToolHandlerMap`, `ToolSource`, `ToolRegistryEntry`, `PolicyContext`.
- `packages/core/src/index.ts` — exported new types.
- `packages/agent-runtime/src/tool-executor.ts` — imports `ToolHandler`/`ToolHandlerMap` from core, re-exports.
- `packages/agent-runtime/src/index.ts` — re-exports `ToolHandler`/`ToolHandlerMap` from core.
- `packages/tools/package.json` — added `@modelcontextprotocol/sdk` dependency.
- `knip.json` — removed `ignoreDependencies: ["@clothos/core"]` for tools workspace (now actively used).

**Dependencies:** `@modelcontextprotocol/sdk` (official MCP SDK). No other new dependencies.

### Deferred to future phases
- **Exposing the aggregated tool set as a single MCP server endpoint** for external clients — deferred until Phase 8 (Integration & DX).
- **Session-level and sandbox-level policy layers** — the policy engine currently resolves Global → Agent. Session and sandbox layers will be added in Phase 7 (Security Hardening).

### How to verify
- `turbo run build` — compiles all packages including tools.
- `turbo run check-types` — no TypeScript errors.
- `turbo run test` — all 108 tools tests pass across 11 test files:
  - Registry: register/get, conflict detection, unregister, source filtering, handler map building, definitions.
  - Policy engine: allow-all wildcard, agent-level deny, deny-wins-over-wildcard, pinned tools in builtin list, catalog excludes pinned, empty allow = no tools, group expansion in allow/deny lists, unknown groups as literals.
  - Risk classifier: GREEN/YELLOW/RED/CRITICAL classification, chain classification (highest wins), injection blocking ($(), backticks, LD_PRELOAD, --upload-pack).
  - Bash handler: execute green command, block critical, block injection, block RED without yolo, allow RED with yolo, sandbox routing, timeout handling.
  - File tools: read/write/edit operations, line range support, path traversal blocked, unique match enforcement (0 matches = error, >1 matches = error).
  - Docker CLI: command construction verification with security flags, exec/remove/info.
  - Sandbox manager: getOrCreate, container reuse, exec delegation, destroy/destroyAll, Docker availability check.
  - Schema validator: valid args pass, missing required fails, wrong type fails, multiple errors collected, format includes hints.
  - MCP client manager: connectAll discovery, tool namespacing, call routing, disconnect unregisters, getAllTools.
  - use_mcp_tool: valid call routing, policy denial, missing args, validation errors with schema hints.
- `npx knip` — no unused exports or dependencies.
- All existing tests still pass (especially memory package which imports `ToolHandler` from agent-runtime).

---

## Phase 5 — Plugin & Skills System (Week 18–20) ✅ COMPLETE

### Goal
Enable extensibility without modifying core code — plugins for deep system integration, skills for agent-level knowledge injection.

### Design decisions (simplified from original plan)

- **`@clothos/plugins` depends only on `@clothos/core`** — receives HookRegistry, ToolRegistry, etc. via constructor-injected callbacks. No dependency on agent-runtime or tools packages. Application-level wiring connects them.
- **`PluginContext.registerTool` gained a `handler` param** — changed from `registerTool(def: ToolDefinition): void` to `registerTool(def: ToolDefinition, handler: ToolHandler): void` so plugins can provide implementations alongside definitions.
- **`SkillEntry` type added to core** — `formatSkillsSummary` and `createSkillsHandler` updated from `string[]` to `SkillEntry[]` (with `name`, `description`, `filePath`, `metadata`). The prompt section becomes `- skillName: description (path: filePath)` (~24 tokens/skill).
- **New top-level `skills` config section** — separate from `plugins` config since skills and plugins have different lifecycles (files vs code modules).
- **Native `fs.watch` for hot-reload** — Node 22 supports `{ recursive: true }` on macOS and Linux. Avoids adding chokidar dependency.
- **`yaml` + `semver` as new dependencies** — `yaml` for robust SKILL.md frontmatter parsing, `semver` for plugin dependency version checking.
- **Deferred `PromptCompiler` class** — the existing `registerPromptHandlers()` system from Phase 2 already handles layered prompt assembly via hook priorities. No separate compiler needed.

### What we built

**Package:** `packages/plugins/` (`@clothos/plugins`) — 12 source files, 96 tests across 10 test suites.

**Core type extensions** (`packages/core/src/`):
- New `skills.ts` — `SkillEntry`, `SkillMetadata`, `SkillsConfig` types.
- Updated `plugins.ts` — `registerTool` now accepts `(def: ToolDefinition, handler: ToolHandler)`.
- Updated `config.ts` — added optional `skills?: SkillsConfig` to `ClothosConfig`.
- Updated `config-validator.ts` — added `'skills'` to `VALID_TOP_LEVEL_KEYS`.
- Updated `index.ts` — exported `SkillEntry`, `SkillMetadata`, `SkillsConfig`.

**Agent-runtime prompt updates** (`packages/agent-runtime/src/`):
- `formatSkillsSummary(skills: SkillEntry[])` — formats as `- name: description (path: filePath)` per skill.
- `createSkillsHandler(skills: SkillEntry[], mode)` — injects `<available-skills>` section.
- `RegisterPromptHandlersParams.skills` changed to `SkillEntry[]`.
- `AgentManager` gained `setSkills(skills: SkillEntry[])` method, passes skills to `registerPromptHandlers()`.

**Error classes** (`errors.ts`):
- `PluginLoadError(pluginName, cause?)` — failed to load a plugin.
- `PluginDependencyError(message)` — unsatisfied dependency.
- `CyclicDependencyError(cycle: string[])` — circular dependency detected.
- `SkillGatingError(skillName, reason)` — skill requirements not met.

**Dependency resolver** (`dependency-resolver.ts`):
- `resolveDependencyOrder(plugins: DiscoveredPlugin[]): DiscoveredPlugin[]` — topological sort using Kahn's algorithm.
- Validates all dependencies exist and semver constraints are satisfied.
- Throws `CyclicDependencyError` on cycles, `PluginDependencyError` on missing/incompatible deps.

**Service & command registries:**
- `ServiceRegistry` — simple `Map<string, unknown>` with `register<T>`, `get<T>`, `has`. Application layer registers core services before plugins load.
- `CommandRegistry` — `Map<string, CommandHandler>` with `register` (returns `Disposable`), `execute`, `has`, `getAll`, `clear`.

**Plugin context** (`plugin-context-impl.ts`):
- `createPluginContext(pluginName, callbacks, logger, config)` — factory function returning `{ context, registeredTools[], hookDisposables[], commandDisposables[] }`.
- Delegates all registrations to application-level callbacks and tracks what was registered for cleanup.
- Logger prefixed with `[plugin:{name}]`.

**Plugin discovery** (`plugin-discovery.ts`):
- Scans directories for subdirectories containing `package.json` with `clothos` field.
- `clothos` field structure: `{ entry: string, manifest: PluginManifest }`.
- `isPluginEnabled(name, enabled, disabled)` — disabled takes precedence; empty enabled = all.

**Plugin loader** (`plugin-loader.ts`) — main orchestrator:
- `loadAll()` — discover → resolve dependency order → load each in order.
- `loadPlugin(name, entryPath, directory)` — `import(entryPath + '?v=' + Date.now())` → call `onLoad(ctx)`.
- `unloadPlugin(name)` — `onUnload()` → dispose hooks/commands → unregister tools.
- `reloadPlugin(name, entryPath, directory)` — unload → re-import → load.
- `unloadAll()` — reverse order. `enableHotReload()` / `disableHotReload()`.
- Error handling: wraps `onLoad` in try/catch, logs error, skips plugin, continues.

**Skill parser** (`skill-parser.ts`):
- `parseSkillFile(content, filePath): SkillEntry` — extract YAML frontmatter via `yaml` package.
- `extractFrontmatter(content)` — parse `---` delimited YAML.
- Falls back to directory name for `name` if frontmatter missing.

**Skill gating** (`skill-gating.ts`):
- `checkSkillRequirements(skill): SkillCheckResult` — check binaries (`which`), env vars, OS platform.
- `filterAvailableSkills(skills, logger): SkillEntry[]` — filters and logs warnings for skipped skills.
- `isBinaryAvailable(name)`, `isEnvVarSet(name)` — low-level checks.

**Skill discovery** (`skill-discovery.ts`):
- `discoverSkills(options): Promise<SkillEntry[]>` — scan, parse, gate, merge.
- `mergeSkillSources(...sources)` — later sources override by name (workspace > user > bundled).
- `filterByConfig(skills, enabled, disabled)` — disabled wins; empty enabled = all.

**File watcher** (`file-watcher.ts`):
- `FileWatcher` class wrapping `fs.watch` with `{ recursive: true }`.
- 250ms debounce by default. Coalesces rapid events into single callback.
- `watch(directory, callback)`, `close()`.

### Integration with existing code

**No circular dependencies:** `@clothos/plugins` depends only on `@clothos/core`. Application-level wiring connects plugins to the runtime via existing public APIs:
- `AgentManager.setSkills()` → inject discovered skills into prompt handlers.
- `AgentManager.getHookRegistry()` → pass to plugin context callbacks.
- `AgentManager.setTools()` → register plugin-provided tools.

**Files modified:**
- `packages/core/src/plugins.ts` — `registerTool` signature adds `handler` param.
- `packages/core/src/config.ts` — add `skills?: SkillsConfig` to `ClothosConfig`.
- `packages/core/src/config-validator.ts` — add `'skills'` to `VALID_TOP_LEVEL_KEYS`.
- `packages/core/src/index.ts` — export `SkillEntry`, `SkillMetadata`, `SkillsConfig`.
- `packages/core/src/skills.ts` — new file with skill types.
- `packages/agent-runtime/src/prompt-section-builder.ts` — `formatSkillsSummary` takes `SkillEntry[]`.
- `packages/agent-runtime/src/prompt-handlers.ts` — `createSkillsHandler` takes `SkillEntry[]`.
- `packages/agent-runtime/src/prompt-assembler.ts` — `RegisterPromptHandlersParams.skills` → `SkillEntry[]`.
- `packages/agent-runtime/src/agent-manager.ts` — add `setSkills()`, pass skills to prompt handlers.
- `packages/agent-runtime/tests/prompt-section-builder.test.ts` — updated for `SkillEntry[]`.
- `packages/agent-runtime/tests/prompt-handlers.test.ts` — updated for `SkillEntry[]`.
- `packages/agent-runtime/tests/prompt-assembler.test.ts` — updated for `SkillEntry[]`.
- `packages/plugins/package.json` — add `semver`, `yaml`, `@types/semver`.
- `packages/plugins/src/index.ts` — full barrel export.
- `config/default.json5` — add `skills` section.
- `knip.json` — remove `ignoreDependencies` for plugins.

**Dependencies:** `semver` (plugin version checks), `yaml` (SKILL.md frontmatter parsing), `@types/semver`. No chokidar (using native `fs.watch`).

### How to verify
- `turbo run build` — compiles all packages including plugins, no errors.
- `turbo run check-types` — no TypeScript errors across all packages.
- `turbo run test` — all 96 plugins tests pass + all existing tests still pass (479 total):
  - Dependency resolver: linear chain, diamond, cycle detection, missing dep, semver match/mismatch, no deps, empty input, three-node cycle.
  - Plugin context: tool/hook/command registration delegation, disposable tracking, logger prefixing, config passthrough, multiple registrations.
  - Plugin discovery: valid/invalid dirs, enabled/disabled lists, manifest parsing, non-existent dir handling, multiple directories, entry path resolution.
  - Plugin loader: loadAll order, loadPlugin/unloadPlugin lifecycle, unloadAll, error handling, disabled list, tool registration via context, tool unregistration on unload.
  - Skill parser: full/minimal frontmatter, arrays, missing frontmatter defaults, invalid YAML, non-string filtering, Windows line endings.
  - Skill gating: no requirements, missing/available binary, missing/set env var, OS check, filterAvailableSkills with logging.
  - Skill discovery: multi-dir scan, precedence merge, enabled/disabled, gating, empty dirs, non-existent dirs, non-directory entries, missing SKILL.md.
  - Command registry: register/execute/dispose, unknown command, getAll, clear, async handlers.
  - Service registry: register/get, unknown service, has, overwrite, type preservation.
  - File watcher: callback on change, debounce, close stops watching, missing dir, idempotent close.
- `npx knip` — no unused exports or dependencies.
- Existing `packages/memory` tests pass unchanged (imports `ToolHandler` from agent-runtime, which re-exports from core).

---

## Phase 5.5 — Single-Agent End-to-End Integration (Week 20–21) ✅ COMPLETE

### Goal
Wire all completed subsystems (gateway, agent-runtime, memory, tools, plugins) into a runnable application server and validate the full message path: WebSocket client → Gateway → NATS → Agent Runtime → LLM + Tools + Memory → response back to client.

### Why this phase exists

Phases 0–5 built well-tested libraries, but no code connected them into a running system. The REPL (`scripts/repl.mts`) bypasses the gateway entirely — it calls `AgentManager.dispatch()` directly with no NATS, no WebSocket, no tools, no memory. Before Phase 6 (multi-agent), we needed to prove a single agent works end-to-end through the real infrastructure.

### What we built

**Package:** `packages/app/` (`@clothos/app`) — 4 source files, 7 unit tests + 6 E2E test files (Docker-dependent).

**Application bootstrap** (`bootstrap.ts`) — the composition root that wires everything together:
1. Loads and validates config from JSON5.
2. Starts the `GatewayServer` (NATS + Redis + WebSocket).
3. For each agent in `config.agents.list`, calls `wireAgent()` which:
   - Creates `AgentManager` + `LLMService`
   - Builds `ToolRegistry` with built-in tools (bash, read_file, write_file, edit_file)
   - Initializes `EpisodicMemoryStore` (SQLite + FTS5) per agent
   - Registers `memory_search` + `memory_get` tools
   - Registers `memory_flush` lifecycle hook
   - Applies `PolicyEngine` to filter effective tools per agent
   - Loads plugins via `PluginLoader`
   - Discovers skills via `discoverSkills()`
   - Subscribes to NATS inbox with response routing
4. Returns `AppServer` handle with `shutdown()` for graceful cleanup.

**Agent wiring** (`agent-wiring.ts`) — per-agent setup encapsulating tool registry, memory store, plugin loader, policy engine, and NATS inbox subscription into a single `wireAgent()` function.

**Response routing** (`response-router.ts`) — tracks which WS session initiated each request (via correlationId) and routes agent responses back to the correct client.

**Main entry point** (`main.ts`) — reads config, sets up the real `PiMonoProvider`, bootstraps the app, handles SIGINT/SIGTERM.

### Changes to existing packages

**`packages/agent-runtime/src/agent-manager.ts`:**
- `subscribeToInbox(nats, onResponse?)` — previously had an empty handler. Now extracts user text from `AgentMessage.data` (supports `string` or `{ text: string }` payloads), calls `dispatch()`, and invokes the `onResponse` callback with each `AgentEvent` plus the original message for response routing.
- Added `AgentMessage` to imports.

**`packages/gateway/src/gateway-server.ts`:**
- Added `pendingResponses` and `sourceToSession` maps for correlationId → WS session tracking.
- `handleIncomingMessage()` now accepts and tracks `wsSessionId`.
- Added `sendResponse(correlationId, response)` — routes responses to originating WS clients.
- Added `completePendingResponse(correlationId)` — cleanup after final response.
- Added `getWebSocketServer()` accessor.

**`packages/gateway/src/websocket-server.ts`:**
- `onMessage` callback signature changed from `MessageHandler` (1 arg) to `WsMessageHandler` (2 args: msg + sessionId).
- Connection handler now passes `sessionId` to `onMessage`.
- Exported `WsMessageHandler` type.

**`config/default.json5`:**
- Uncommented the default agent entry (id: `assistant`, persona: "You are a helpful assistant.").
- Uncommented the default binding (channel: `default` → agent: `assistant`).

### E2E test infrastructure

**Mock LLM provider** (`tests/e2e/helpers/mock-llm.ts`):
- `MockLLMProvider` implements `LLMProvider` with deterministic responses.
- Supports text-only and tool-call responses.
- Configurable response sequence (round-robins through the list).
- `callCount` and `reset()` for test assertions.

**WS test client** (`tests/e2e/helpers/ws-client.ts`):
- `WsTestClient` connects via WebSocket with bearer token auth.
- `sendToAgent(agentId, text)` — builds and sends an `AgentMessage` envelope.
- `waitForResponse(correlationId, timeout)` — waits for a specific correlated response.
- Connection timeout handling, message buffering, clean disconnect.

**Test fixtures** (`tests/e2e/helpers/fixtures.ts`):
- `writeTestConfig()` — generates a complete JSON5 config with configurable agent entries, ports, tool deny lists, and memory settings.
- `createNodeFs()`, `createTestLogger()`, temp directory helpers.

**App harness** (`tests/e2e/helpers/app-harness.ts`):
- `AppHarness` — boots the full stack (gateway + agents + tools + memory) with mock LLM.
- Manages temp directories, WS client lifecycle, and cleanup.

### Test suites

**Unit tests** (`tests/bootstrap.test.ts` — runs via `turbo run test`):
- ResponseRouter: track/route/untrack, unknown correlationId, response message building.
- MockLLMProvider: ordered responses, tool call emission, call counting.
- **7 tests total.**

**E2E tests** (`tests/e2e/*.test.ts` — require Docker, run via `pnpm test:e2e`):
1. **Conversation round-trip** — send message via WS, receive response with correct correlationId and agent source.
2. **Tool execution** — LLM requests `read_file`, agent executes it, response contains file content.
3. **Session continuity** — 3 sequential messages, 3 sequential responses, LLM called 3 times.
4. **Tool policy enforcement** — deny `bash` in config, verify agent still produces a response (not a crash).
5. **Health check** — WS connected, agents wired, agent in READY state.
6. **Graceful shutdown** — verify clean disconnect and TERMINATED state.

### Integration with existing code

**No circular dependencies.** `@clothos/app` depends on all other packages (core, gateway, agent-runtime, memory, tools, plugins). No other package depends back on app. This is the composition root.

**Files modified:**
- `packages/agent-runtime/src/agent-manager.ts` — enhanced `subscribeToInbox()`.
- `packages/gateway/src/gateway-server.ts` — response routing, WS session tracking.
- `packages/gateway/src/websocket-server.ts` — `WsMessageHandler` type, session ID in callback.
- `packages/gateway/src/index.ts` — exported `WsMessageHandler`.
- `config/default.json5` — uncommented agent + binding.
- `knip.json` — added `packages/app` workspace entry.
- `package.json` — added `start` script.

**Dependencies:** None new. `ws` and `@types/ws` as devDependencies (test client only).

### How to verify
- `turbo run build` — compiles all packages including app, no errors.
- `turbo run check-types` — no TypeScript errors across all packages.
- `turbo run test` — all 486 tests pass (479 existing + 7 new app unit tests).
- `npx knip` — no unused exports or dependencies.
- All existing package tests pass unchanged.
- E2E tests (`pnpm -F @clothos/app test:e2e`) validate the full WS → NATS → agent → tools → memory → response path (requires Docker for NATS + Redis).
- `pnpm start` boots the server with a real LLM provider.

---

## Pre-Phase 6 — Configuration System Refactoring ✅ COMPLETE

### Goal
Address config gaps identified by comparing with OpenClaw before starting Phase 6. Our config was agent-centric and channel-poor where it needed to be session-aware and channel-rich.

### What we built

Six changes shipped as a single refactoring pass:

1. **Deduplicated `reserveTokens`** — removed from `AgentDefaults`, kept only in `session.compaction`. `AgentManagerOptions` now requires a `compaction: { enabled: boolean; reserveTokens: number }` field. Reserve tokens is a compaction concern, not a model default.

2. **Enriched bindings** — `Binding` gained `overrides?: BindingOverrides` and `priority?: number`. `BindingOverrides` allows per-route `model`, `sandbox`, `tools`, and `workspace` customization. `resolveAgent()` now returns `ResolvedBinding { agentId, binding }` instead of a plain string. Priority is used as a base score before specificity points in the scoring algorithm.

3. **Promoted channel config** — `ChannelAdaptorConfig` gained `allowlist?: string[]`, `dm?: ChannelSessionPolicy`, and `group?: ChannelSessionPolicy`. Allowlist enforcement is wired into the `sendMessage` path (rejects unauthorized peers). DM/group policy fields are defined but enforcement is deferred to Phase 6.

4. **Embedding auto-selection** — provider type expanded to `'auto' | 'openai' | 'none'`. New `resolveEmbeddingProvider(config)` auto-detects OpenAI when the API key env var is set, falls back to `NullEmbeddingProvider`. Default changed from `'openai'` to `'auto'`. Agent wiring uses the resolver instead of hardcoding `NullEmbeddingProvider`.

5. **Env var config overrides** — `applyEnvOverrides(config)` reads `CLOTHOS_`-prefixed env vars and applies nested overrides (`__` separates levels). Type coercion for numbers and booleans. Called in `bootstrap.ts` after `loadConfig()`, kept separate from `validateConfig()` to avoid env pollution in tests.

6. **PolicyEngine binding layer** — `PolicyContext` gained `bindingTools?: { allow?: string[]; deny?: string[] }`. `resolveEffectivePolicy()` now resolves Global → Agent → Binding (3 layers). Binding allow intersects (can only narrow, never expand), binding deny stacks (additive). Threading binding overrides through the message handling path is Phase 6 wiring.

### New types exported from `@clothos/core`

- `BindingOverrides` — per-binding model/sandbox/tools/workspace overrides
- `ResolvedBinding` — `{ agentId: string; binding: Binding }`
- `ChannelSessionPolicy` — `{ enabled: boolean; defaultAgent?: string; maxSessions?: number }`
- `applyEnvOverrides()` — env var config overlay utility

### Impact on later phases

- Phase 6: `resolveAgent()` already returns `ResolvedBinding` with the full binding including overrides. Wire `binding.overrides.tools` into `PolicyContext.bindingTools` during message dispatch. Use `binding.overrides.model` and `binding.overrides.sandbox` when configuring spawned agent sessions.
- Phase 7: Policy engine already has 3 layers (Global → Agent → Binding). Session-level policy is the remaining layer. Full session-type taxonomy (`dm | group | spawn | cron`) is Phase 7 scope. Channel allowlist is already enforced.
- Phase 8: Docker/CI deployments can override any config value via `CLOTHOS_*` env vars without editing config files. Embedding auto-detection reduces setup friction.

### How to verify
- `turbo run build` — 10/10 packages pass.
- `check-types` — all backend packages pass (UI has pre-existing error unrelated to this work).
- `turbo run test` — 407 tests pass across 6 packages (0 failures), including ~30 new tests.
- `npx knip` — zero unused exports or dependencies.
- `config/default.json5` loads and validates correctly.

---

## Phase 6 — Multi-Agent Orchestration (Week 22–24) ✅ COMPLETE

### Goal
Support multiple agents running concurrently with configurable routing, cross-agent communication, and orchestration patterns.

### Design decisions

1. **Agent Router lives in `packages/orchestrator/`** — the binding resolver in channels is pure scoring. The router adds runtime concerns (availability, circuit breaking) that need agent status. Channels stays stateless.
2. **Binding override wiring at the app layer** — `wireAgent()` propagates `ResolvedBinding.binding.overrides` via message metadata (`x-binding-overrides`), then recomputes tools per-request in the inbox handler. `setTools()` is called before dispatch with narrowed tools and restored after. No race condition because dispatch is serialized per agent via the lane queue.
3. **Cross-agent tools call `dispatch()` directly** — `agent_spawn` and `agent_send` use an `AgentRegistry` (read-only lookup of wired agents) injected at bootstrap. No NATS hop for in-process agent-to-agent calls. NATS-based cross-node is future scope.
4. **Scheduler wraps the dispatch path** — sits between message arrival and `dispatch()`. Manages a concurrency-limited priority queue. Wired at bootstrap.
5. **Orchestration patterns are tools, not plugins** — Supervisor/Pipeline/Broadcast are `ToolDefinition` + handler factories registered via `ToolRegistry`, same as memory tools. They compose `agent_spawn` internally. No PluginLoader involvement.

### What we built

**Package:** `packages/orchestrator/` (`@clothos/orchestrator`) — 11 source files, 68 tests across 8 test suites.

**Core type extensions** (`packages/core/src/orchestration.ts`):
- `TaskPriority` enum (`USER=1`, `DELEGATION=2`, `BACKGROUND=3`).
- `ScheduledTask` — queued task with id, agentId, message, priority, enqueuedAt.
- `AgentHealthInfo` — per-agent circuit state tracking.
- `OrchestratorConfig` — `maxConcurrentAgents`, `spawnTimeoutMs`, `sendReplyTimeoutMs`, `maxExchanges`.
- Added `orchestrator?: OrchestratorConfig` to `ClothosConfig`.
- Added `'orchestration'` to `ToolSource` union.
- Added `'orchestrator'` to config validator's `VALID_TOP_LEVEL_KEYS`.
- Added `'group:orchestration': ['agent_spawn', 'agent_send']` to tool groups.

**Agent registry** (`agent-registry.ts`) — read-only interface for looking up wired agents:
```typescript
interface AgentRegistryEntry {
  agentId: string;
  getStatus(): AgentStatus;
  dispatch(message: string, sessionId?: string): AsyncGenerator<AgentEvent>;
}

interface AgentRegistry {
  get(agentId: string): AgentRegistryEntry | undefined;
  has(agentId: string): boolean;
  getAll(): AgentRegistryEntry[];
  getAvailable(): AgentRegistryEntry[];  // status === READY or RUNNING
}
```
Concrete implementation in `packages/app/src/agent-registry-impl.ts` via `buildAgentRegistry(agents)`.

**Agent router** (`agent-router.ts`) — wraps static binding resolution with availability checks and per-agent circuit breaking:
- Scores all bindings for a channel/sender/conversation (same algorithm as `resolveAgent()`).
- Checks if resolved agent is available (READY/RUNNING) and healthy (circuit closed or half-open).
- Falls back to alternate bindings if top candidate is unavailable.
- Per-agent failure tracking: 5 failures in 60s → circuit open, 30s cooldown → half-open.
- `recordSuccess(agentId)`, `recordFailure(agentId)`, `isAgentHealthy(agentId)`.

**Agent scheduler** (`agent-scheduler.ts`) — concurrency-limited priority queue:
- Below concurrency limit → execute immediately.
- At limit → insert into sorted array by priority (lower number = higher priority), FIFO within same priority.
- On completion → drain next queued item.
- Callbacks: `onEvent(task, event)`, `onDone(task)`, `onError(task, error)`.
- `registerAgent(agentId, dispatchFn)`, `unregisterAgent(agentId)`.
- `enqueue(task, onEvent?, onDone?, onError?): string` — synchronous, returns task ID.

**Binding override wiring** — threads `ResolvedBinding.binding.overrides` through the message path:
1. `ChannelManager.sendMessage()` serializes `binding.overrides` into `agentMsg.metadata['x-binding-overrides']` as JSON.
2. `AgentManager.subscribeToInbox()` gained `onBeforeDispatch` and `onAfterDispatch` callbacks.
3. `wireAgent()` uses `onBeforeDispatch` to extract overrides, recompute tools via `policyEngine.getEffectiveBuiltinTools({ bindingTools: overrides.tools })`, and call `manager.setTools()` with narrowed tools. `onAfterDispatch` restores defaults.
4. `WiredAgent` interface now exposes `policyEngine: PolicyEngine`.

**Cross-agent communication tools** — two tool definitions + handler factories:

`agent_spawn` (`riskLevel: 'yellow'`) — input: `{ targetAgent, task, context?, timeout? }`:
- Looks up target in `AgentRegistry`, validates availability.
- Calls `entry.dispatch(formattedMessage)` with `[Delegated from {callerAgentId}]` prefix.
- Collects final `assistant_message` text with configurable timeout.
- Returns `{ agent, response }` or `{ error }`.

`agent_send` (`riskLevel: 'yellow'`) — input: `{ targetAgent, message, waitForReply?, maxExchanges? }`:
- Fire-and-forget mode: dispatch async, return `{ sent: true }`.
- Wait-for-reply mode: dispatch sync, collect response, return `{ agent, reply }`.

**Orchestration pattern tools** — higher-level compositions, all optional:

1. `orchestrate` (supervisor) — decomposes task across workers (parallel via `Promise.allSettled` or sequential `for-of` loop), returns `{ mode, results[] }`.
2. `pipeline_execute` — sequential chain where each output feeds next input, returns `{ steps[], finalOutput }`. Halts on error with partial results.
3. `broadcast` — fan-out same message to multiple agents, collect all responses via `Promise.allSettled`, returns `{ responses[] }`.

**Bootstrap integration** (`packages/app/src/bootstrap.ts`):
1. After wiring all agents, builds `AgentRegistry` via `buildAgentRegistry(agents)`.
2. Creates `AgentScheduler` with `config.orchestrator.maxConcurrentAgents ?? config.gateway.maxConcurrentAgents`.
3. Registers each agent's dispatch function with scheduler.
4. Creates `AgentRouter` with bindings + registry.
5. For each agent: registers `agent_spawn`, `agent_send`, `orchestrate`, `pipeline_execute`, `broadcast` if policy allows.
6. Rebuilds effective tools after adding orchestration tools.
7. Exposes `scheduler`, `router`, and `agentRegistry` on `AppServer`.

### Files created (16)

| File | Purpose |
|------|---------|
| `packages/core/src/orchestration.ts` | `TaskPriority`, `ScheduledTask`, `AgentHealthInfo`, `OrchestratorConfig` |
| `packages/orchestrator/src/agent-registry.ts` | `AgentRegistry` + `AgentRegistryEntry` interfaces |
| `packages/orchestrator/src/agent-router.ts` | `AgentRouter` with availability + circuit breaking |
| `packages/orchestrator/src/agent-scheduler.ts` | Concurrency-limited priority queue |
| `packages/orchestrator/src/tools/agent-spawn-tool.ts` | `agent_spawn` tool definition + handler factory |
| `packages/orchestrator/src/tools/agent-send-tool.ts` | `agent_send` tool definition + handler factory |
| `packages/orchestrator/src/tools/index.ts` | Tools barrel export |
| `packages/orchestrator/src/tools/supervisor-tool.ts` | `orchestrate` tool (parallel/sequential decomposition) |
| `packages/orchestrator/src/tools/pipeline-tool.ts` | `pipeline_execute` tool (sequential chain) |
| `packages/orchestrator/src/tools/broadcast-tool.ts` | `broadcast` tool (fan-out/collect) |
| `packages/app/src/agent-registry-impl.ts` | `buildAgentRegistry()` backed by wired agents |
| `packages/orchestrator/tests/agent-router.test.ts` | 14 tests |
| `packages/orchestrator/tests/agent-scheduler.test.ts` | 14 tests |
| `packages/orchestrator/tests/agent-spawn-tool.test.ts` | 7 tests |
| `packages/orchestrator/tests/agent-send-tool.test.ts` | 8 tests |
| `packages/app/tests/binding-overrides.test.ts` | 5 tests |

### Files modified (14)

| File | Change |
|------|--------|
| `packages/core/src/config.ts` | Added `orchestrator?: OrchestratorConfig` |
| `packages/core/src/tools.ts` | Added `'orchestration'` to `ToolSource` |
| `packages/core/src/index.ts` | Export orchestration types |
| `packages/core/src/config-validator.ts` | Added `'orchestrator'` to `VALID_TOP_LEVEL_KEYS` |
| `packages/tools/src/tool-groups.ts` | Added `group:orchestration` |
| `config/default.json5` | Added orchestrator section |
| `packages/orchestrator/src/index.ts` | Full barrel export |
| `packages/channels/src/channel-manager.ts` | Propagate overrides via metadata |
| `packages/agent-runtime/src/agent-manager.ts` | Added `onBeforeDispatch`/`onAfterDispatch` to `subscribeToInbox` |
| `packages/app/src/agent-wiring.ts` | Expose `policyEngine`, handle binding overrides |
| `packages/app/src/bootstrap.ts` | Registry, scheduler, router, orchestration tool registration |
| `packages/app/package.json` | Added orchestrator dependency |
| `knip.json` | Updated orchestrator entry |
| `packages/orchestrator/package.json` | Package metadata |

### Deferred to future phases

- **NATS-based cross-node agent_send** — both tools call `dispatch()` directly in-process. NATS routing for distributed deployments is Phase 8+.
- **DM/group session policy enforcement** — types exist but enforcement deferred to Phase 7.
- **Model/sandbox binding overrides consumption** — metadata propagation is wired but only `tools` overrides are consumed. Model and sandbox override consumption requires LLMService and SandboxManager changes, deferred to Phase 7.

### How to verify
- `turbo run build` — all 10 packages compile including orchestrator.
- `turbo run check-types` — no TypeScript errors (9/10 pass; UI has pre-existing error).
- `turbo run test` — all existing tests pass + 68 new orchestrator tests + 5 new binding override tests + 3 new channel-manager override tests:
  - Agent router: availability filtering, fallback, circuit breaking (trip, reset, cooldown to half-open), health info, failure window pruning.
  - Agent scheduler: concurrency limiting, priority ordering (USER > DELEGATION > BACKGROUND), FIFO within same priority, drain-on-complete, register/unregister, callbacks, error handling.
  - agent_spawn: successful delegation, context in message, unknown agent, unavailable agent, timeout, dispatch error.
  - agent_send: fire-and-forget, wait-for-reply, unknown/unavailable agent, caller prefix, dispatch error, timeout.
  - Supervisor: parallel/sequential modes, unavailable/unknown agents, empty subtasks, result shape.
  - Pipeline: chained output, finalOutput, halt on error, unknown agent, single step, empty steps, unavailable agent.
  - Broadcast: fan-out/collect, mixed success/failure, empty agents, caller prefix, dispatch errors.
  - Binding overrides: serialization, round-trip, missing overrides, malformed JSON, metadata propagation.
- `npx knip` — no unused exports or dependencies.

---

## Phase 7 — Observability & Security Hardening (Week 25–27)

### Goal
Instrument the entire system for production visibility, and harden security across all layers.

### Prerequisites from Pre-Phase 6 and Phase 6

The following security infrastructure is already in place:
- **PolicyEngine** has 3 layers: Global → Agent → Binding. Binding-level tool restrictions (allow narrows via intersection, deny stacks additively) are already functional. Session-level policy is the remaining layer to add.
- **Channel allowlists** enforce peer authorization in `ChannelManager.sendMessage()`.
- **`ChannelSessionPolicy`** type exists with `enabled`, `defaultAgent`, `maxSessions` fields. DM/group enforcement may have been wired in Phase 6.
- **Binding-level sandbox overrides** (`BindingOverrides.sandbox`) are typed and available for per-route sandbox customization.

### What we build

**OpenTelemetry integration** — instrument every component with the OTel Node.js SDK:

- **Traces**: create spans at each major boundary:
  - `gateway.route` — from message receipt to agent dispatch.
  - `agent.invoke` — wraps the full agent loop execution.
  - `agent.llm_call` — each LLM completion, with attributes: `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason`.
  - `agent.tool_execute` — each tool invocation, with `gen_ai.tool.name` and `duration_ms`.
  - `memory.search` — each memory retrieval, with `memory.store_type` and `result_count`.
- **Cross-agent trace propagation**: inject W3C `traceparent` into `AgentMessage.traceContext` on publish. Extract on consume to create child spans. This gives end-to-end traces across multi-agent workflows.
- **Metrics** (via OTel Metrics SDK):
  - `agent.llm.latency` — histogram by model, p50/p95/p99.
  - `agent.llm.tokens` — counter by model, token type (input/output).
  - `agent.llm.cost` — counter by agent, model (USD).
  - `agent.tool.duration` — histogram by tool name.
  - `agent.tool.errors` — counter by tool name, error type.
  - `gateway.message.throughput` — counter by subject pattern.
  - `gateway.dlq.depth` — gauge.
- **Export**: OTel Collector sidecar routing traces to Jaeger/Tempo, metrics to Prometheus, logs to Loki.

**Append-only audit log** — every state-changing event writes to an immutable event store:

```typescript
interface AuditEvent {
  eventId: string;          // UUIDv7
  eventType: string;        // e.g., "agent.tool.executed"
  sequenceNumber: number;   // Monotonic per source
  timestamp: string;
  traceId?: string;
  spanId?: string;
  actor: { type: "agent" | "user" | "system"; id: string };
  data: Record<string, unknown>;
  checksum: string;         // SHA-256(prev_checksum + JSON(this_event))
}
```

Storage: PostgreSQL table with triggers preventing UPDATE and DELETE. Chained checksums provide tamper evidence. Key event types: `agent.llm.called`, `agent.tool.executed`, `agent.tool.blocked`, `agent.state.changed`, `security.command.blocked`, `security.access.denied`, `config.changed`.

**Security hardening:**

1. **Shell command security** — the bash tool's risk classifier and argument sanitization were implemented in Phase 4. In this phase, harden with additional layers:
   - Regex-based pattern matching for obfuscated dangerous commands (e.g., base64-encoded payloads, hex-escaped characters).
   - Environment variable injection prevention: reject commands that set sensitive env vars (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH` overrides).
   - Allowlist mode: optionally restrict agents to a pre-approved set of commands rather than relying solely on the deny-based classifier.

2. **Session-level policy layer** — add the 4th layer to the PolicyEngine:
   - PolicyEngine currently resolves: Global → Agent → Binding (3 layers, implemented in Pre-Phase 6).
   - Add session-level policy as the 4th layer: Global → Agent → Binding → Session.
   - Session-type taxonomy: `dm | group | spawn | cron`. Each session type carries default policy constraints (e.g., `spawn` sessions inherit the parent's narrowed scope, `cron` sessions may have restricted tool access).
   - `PolicyContext` gains `sessionType?: 'dm' | 'group' | 'spawn' | 'cron'` and `sessionTools?: { allow?: string[]; deny?: string[] }`.
   - Session-level policy follows the same narrowing rules as binding-level: allow intersects, deny stacks.

3. **Access control** — implement a Policy Decision Point (PDP):
   - Agent identity carries: `agentId`, `ownerId`, `roles[]`, `scopes[]`, session JWT.
   - Tool-level permissions: each tool definition includes `requiredScopes[]`. The PDP checks `agent.scopes ⊇ tool.requiredScopes` before execution.
   - Delegation chain: when Agent A spawns Agent B, B's JWT includes a `delegation_chain` field and B's scopes are constrained to the intersection of A's allowed scopes and B's configured scopes (narrowing only). This aligns with the binding-level narrowing pattern already in the PolicyEngine.

4. **Secrets management** — secrets from config are loaded into memory only, never passed as environment variables to sandboxed containers. API keys for LLM providers are resolved at the `LLMService` layer, never exposed to agent code. Sandboxed tools that need credentials use a `secrets_proxy` that injects auth headers server-side. Note: `applyEnvOverrides()` runs after config load — ensure sensitive env vars with the `CLOTHOS_` prefix cannot override auth credentials (add a deny-list for `auth__profiles__*__apikey` paths).

5. **Sandbox hardening** — upgrade the Docker sandbox with:
   - Per-binding sandbox overrides (`BindingOverrides.sandbox`) are already typed. Wire them into `SandboxManager` so public-facing bindings can enforce stricter limits than internal ones.
   - Seccomp profile: custom profile extending Docker's default, additionally blocking `ptrace`, `process_vm_readv/writev`, `personality`.
   - No capability escalation: `--security-opt=no-new-privileges`.
   - Filesystem: read-only root, writable workspace only, `/tmp` as noexec tmpfs.
   - Resource limits: PID limit (256), ulimit for open files (1024), 30-second hard timeout via `timeout` command.

### How to verify
- Trace: send a message through the gateway → agent → LLM → tool → response. Verify a complete trace with all spans appears in Jaeger.
- Cross-agent trace: Agent A spawns Agent B; verify both appear as child spans under the same trace.
- Metrics: generate load; verify histograms and counters appear in Prometheus.
- Audit: execute 10 tool calls; verify 10 events in PostgreSQL with valid chained checksums. Attempt UPDATE; verify trigger rejection.
- Shell security hardening: attempt obfuscated dangerous command (e.g., base64-encoded `rm -rf /`); verify blocked. Attempt `LD_PRELOAD=/evil.so ls`; verify env injection blocked. Enable allowlist mode; verify unlisted commands are rejected.
- Session-level policy: create a `spawn` session with narrowed tools. Verify the child session cannot access tools denied at the session level. Verify `cron` sessions respect their default tool restrictions.
- Delegation: Agent A (scopes: `["bash", "read", "write"]`) spawns Agent B (configured scopes: `["bash", "web"]`). Verify B's effective scopes are `["bash"]` (intersection).
- Env var security: verify that `CLOTHOS_AUTH__PROFILES__0__APIKEY=evil` is blocked by the deny-list.

---

## Phase 8 — Integration Testing & Developer Experience (Week 28–29)

### Goal
End-to-end integration tests, a CLI for operators, and documentation that makes the system usable.

### What we build

**CLI tool** (`clothos`) for system management:

```bash
clothos init                    # Scaffold config + directories
clothos start                   # Launch gateway + all agents
clothos stop                    # Graceful shutdown
clothos status                  # Show agent states, queue depths, health
clothos agent list              # List registered agents
clothos agent create <name>     # Scaffold a new agent
clothos plugin install <path>   # Install a plugin
clothos skill add <path>        # Add a skill
clothos config validate         # Validate configuration (applies env overrides, shows effective config)
clothos config show             # Show effective config after env overrides
clothos logs <agentId>          # Tail agent logs
clothos replay <sessionId>      # Replay a session from audit log
```

Note: `config validate` should apply `applyEnvOverrides()` after loading and show the effective config (with env overrides applied), so operators can verify what Docker/CI env vars produce.

**Docker Compose stack** — single `docker-compose.yml` that launches:
- NATS server (with JetStream enabled)
- Redis
- PostgreSQL (audit log)
- The gateway process
- OTel Collector → Jaeger + Prometheus + Grafana

One `docker compose up` gets the entire system running. All config values can be overridden via `CLOTHOS_*` environment variables in the compose file (e.g., `CLOTHOS_GATEWAY__WEBSOCKET__PORT=9999`), following the 12-factor convention. No config file editing required for standard deployments.

Embedding provider auto-detection (`provider: 'auto'`) means the compose stack works out of the box: set `OPENAI_API_KEY` to enable vector search, or leave it unset for BM25-only mode.

**End-to-end test suite:**
- **Scenario 1 — Single agent conversation**: send 5 messages to an agent via WebSocket, verify coherent responses, verify session JSONL file is correct.
- **Scenario 2 — Tool execution**: ask an agent to create a file, verify the file exists in the workspace, verify the tool execution audit event.
- **Scenario 3 — Memory persistence**: have a conversation, terminate the session, start a new session, ask about the previous conversation, verify memory retrieval surfaces the relevant context.
- **Scenario 4 — Multi-agent delegation**: configure a supervisor + worker, send a task to the supervisor, verify it delegates and synthesizes correctly.
- **Scenario 5 — Plugin hot-reload**: start the system, add a plugin that registers a new tool, verify the tool is usable without restart.
- **Scenario 6 — Security**: attempt a CRITICAL shell command; verify it's blocked, logged in audit, and an OTel span records the denial.
- **Scenario 7 — Resilience**: kill the NATS server, verify the circuit breaker activates, restart NATS, verify messages drain and processing resumes.
- **Scenario 8 — Env var overrides**: start with `CLOTHOS_GATEWAY__WEBSOCKET__PORT=9999`; verify the gateway binds to port 9999. Start with `CLOTHOS_SESSION__COMPACTION__RESERVETOKENS=5000`; verify compaction uses the overridden value.
- **Scenario 9 — Binding overrides**: configure a binding with `overrides: { tools: { deny: ["bash"] } }`; send a message matching that binding; verify bash is denied. Send via a different binding; verify bash is allowed.

**Documentation:**
- `README.md` — quickstart (clone → configure → `docker compose up` → chat). Note env var overrides for zero-config deployment.
- `docs/architecture.md` — this HLD distilled into a living doc.
- `docs/configuration.md` — annotated config reference. Document:
  - Env var override format (`CLOTHOS_` prefix, `__` nesting, type coercion)
  - Binding overrides (`overrides.model`, `overrides.sandbox`, `overrides.tools`, `overrides.workspace`)
  - Channel session policies (`allowlist`, `dm`, `group`)
  - Embedding auto-detection (`provider: 'auto'`)
  - `reserveTokens` lives in `session.compaction`, not in `agents.defaults`
- `docs/plugin-guide.md` — how to write and publish plugins.
- `docs/skill-guide.md` — how to create skills.
- Per-package `README.md` files with API reference.

### How to verify
- All 9 E2E scenarios pass in CI.
- `docker compose up` from a clean checkout reaches healthy state in <60 seconds.
- CLI commands complete without errors on a running system.
- `clothos config validate` shows effective config with env overrides applied.

---

## Timeline Summary

| Phase | Focus | Weeks | Cumulative |
|-------|-------|-------|------------|
| 0 | Scaffold & Contracts | 1–2 | 2 weeks |
| 1 | Messaging Gateway | 3–5 | 5 weeks |
| 2 | Agent Runtime | 6–9 | 9 weeks |
| 3 | Memory Subsystem | 10–13 | 13 weeks |
| 4 | Tool System & Sandbox | 14–17 | 17 weeks |
| 5 | Plugins & Skills | 18–20 | 20 weeks |
| 5.5 | Single-Agent E2E Integration | 20–21 | 21 weeks |
| Pre-6 | Config System Refactoring | 21–22 | 22 weeks |
| 6 | Multi-Agent Orchestration | 22–24 | 24 weeks |
| 7 | Observability & Security | 25–27 | 27 weeks |
| 8 | Integration & DX | 28–29 | **29 weeks** |

Each phase produces a testable, working system. Phase 1-2 gives you a single agent talking through the gateway. Phase 3 adds memory. Phase 4 adds tools. Phase 5 makes it extensible. Phase 5.5 proves the full single-agent path end-to-end. Pre-Phase 6 refactors config for session-awareness and channel richness. Phase 6 makes it multi-agent. Phase 7 makes it production-grade. Phase 8 makes it usable by others.
