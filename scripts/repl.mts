import * as readline from 'node:readline';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  AgentManager,
  LLMService,
  PiMonoProvider,
  getModel,
} from '@clothos/agent-runtime';
import type { FileSystem } from '@clothos/agent-runtime';

// --- Configuration via env vars ---
const PROVIDER = process.env['REPL_PROVIDER'] ?? 'anthropic';
const MODEL_ID = process.env['REPL_MODEL'] ?? 'claude-sonnet-4-20250514';
const PERSONA = process.env['REPL_PERSONA'] ?? 'You are a helpful assistant.';
const BASE_PATH =
  process.env['REPL_BASE_PATH'] ??
  path.join(process.env['HOME'] ?? '~', '.clothos');

// --- FileSystem adapter wrapping node:fs/promises ---
function createNodeFs(): FileSystem {
  return {
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(filePath, 'utf-8');
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      await fs.writeFile(filePath, content, 'utf-8');
    },
    async appendFile(filePath: string, content: string): Promise<void> {
      await fs.appendFile(filePath, content, 'utf-8');
    },
    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(dirPath, { recursive: options?.recursive ?? false });
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async readdir(dirPath: string): Promise<string[]> {
      return fs.readdir(dirPath);
    },
  };
}

function createManager(
  nodeFs: FileSystem,
  contextWindow: number,
): AgentManager {
  return new AgentManager({
    agentEntry: {
      id: 'repl-agent',
      name: 'REPL Agent',
      description: 'Interactive console agent',
      persona: PERSONA,
    },
    defaults: {
      model: 'pi-mono',
      contextWindow,
      maxTurns: 100,
    },
    compaction: {
      enabled: true,
      reserveTokens: 20000,
    },
    basePath: BASE_PATH,
    fs: nodeFs,
  });
}

function createLlmService(model: ReturnType<typeof getModel>): LLMService {
  const provider = new PiMonoProvider({ model, id: 'pi-mono' });
  return new LLMService({
    providers: [provider],
    models: { providers: [], fallbacks: [] },
    auth: { profiles: [] },
  });
}

async function main(): Promise<void> {
  const model = getModel(PROVIDER as any, MODEL_ID as any);
  const nodeFs = createNodeFs();

  let manager = createManager(nodeFs, model.contextWindow);
  await manager.init(createLlmService(model));

  let sessionId: string | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  console.log(`Agent OS REPL — ${PROVIDER}/${MODEL_ID}`);
  console.log('Type /quit to exit, /clear to reset session.\n');
  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '/quit') {
      console.log('Goodbye.');
      await manager.terminate();
      rl.close();
      process.exit(0);
    }

    if (input === '/clear') {
      await manager.terminate();
      manager = createManager(nodeFs, model.contextWindow);
      await manager.init(createLlmService(model));
      sessionId = null;
      console.log('Session cleared.\n');
      rl.prompt();
      return;
    }

    try {
      const gen = manager.dispatch(input, sessionId ?? undefined);
      for await (const event of gen) {
        if (event.type === 'assistant_message') {
          console.log(`assistant> ${event.content.text}`);
          if (event.content.toolCalls) {
            for (const tc of event.content.toolCalls) {
              console.log(`  [tool:${tc.name}] ${tc.arguments}`);
            }
          }
        } else if (event.type === 'tool_result') {
          console.log(`  [tool:${event.name}] → ${JSON.stringify(event.result)}`);
        } else if (event.type === 'tool_blocked') {
          console.log(`  [blocked:${event.name}] ${event.reason}`);
        } else if (event.type === 'error') {
          console.error(`  [error] ${event.error}`);
        }
      }
      sessionId = manager.getCurrentSessionId();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
    }

    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
