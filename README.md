# ClothOS

An agentic operating system built in TypeScript. ClothOS provides the runtime, messaging, memory, and orchestration layers needed to run autonomous AI agents — with tool use, plugin extensibility, and multi-agent coordination out of the box.

### Why "ClothOS"?

Named after **Clotho** (Κλωθώ, "the spinner") — the Greek Fate who spins the thread of life into being. Just as Clotho decides when threads begin and weaves them into a larger fabric, ClothOS spins up agent threads, orchestrates their lifecycles, and weaves them together into a coordinated system.

## Architecture

ClothOS is a monorepo of composable packages:

| Package | Description |
|---------|-------------|
| `@clothos/core` | Shared types, interfaces, and configuration schema |
| `@clothos/gateway` | Central messaging gateway (NATS JetStream + Redis + WebSocket) |
| `@clothos/agent-runtime` | Agent execution loop, lifecycle management, session handling |
| `@clothos/memory` | Episodic memory subsystem (SQLite + FTS5 + sqlite-vec) |
| `@clothos/tools` | Tool registry, policy engine, Docker sandboxing, MCP integration |
| `@clothos/plugins` | Plugin loader and skill system |
| `@clothos/orchestrator` | Multi-agent routing, scheduling, and orchestration patterns |
| `@clothos/channels` | Channel abstraction layer |
| `@clothos/channels-telegram` | Telegram channel adaptor |
| `@clothos/channels-whatsapp` | WhatsApp channel adaptor |
| `@clothos/app` | Application bootstrap and composition root |
| `@clothos/ui` | Web UI |

## Tech Stack

TypeScript, Node.js >= 22, pnpm workspaces, Turborepo, NATS JetStream, Redis, SQLite (FTS5 + sqlite-vec), Docker.

## Getting Started

```bash
pnpm install
pnpm run build        # or: npx turbo run build
pnpm run test         # or: npx turbo run test
pnpm start            # boot the server
```

## License

Private.
