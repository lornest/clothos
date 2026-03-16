import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { AgentEntry, LLMProvider } from '@clothos/core';
import { bootstrap } from '../../../src/bootstrap.js';
import type { AppServer } from '../../../src/bootstrap.js';
import {
  createTempDir,
  cleanupTempDir,
  createNodeFs,
  createTestLogger,
  writeTestConfig,
} from './fixtures.js';
import { MockLLMProvider } from './mock-llm.js';
import type { MockResponse } from './mock-llm.js';
import { WsTestClient } from './ws-client.js';

interface AppHarnessOptions {
  /** Responses the mock LLM will produce, in order. */
  mockResponses?: MockResponse[];
  /** Override agent entries. */
  agents?: AgentEntry[];
  /** Tools to deny. */
  toolsDeny?: string[];
  /** Whether to enable memory. Default: true */
  memoryEnabled?: boolean;
  /** Custom LLM provider (overrides mockResponses). */
  llmProvider?: LLMProvider;
}

/**
 * Test harness that boots the full app stack with mock LLM
 * and provides a WS client for testing.
 *
 * Requires NATS and Redis to be running on localhost.
 */
export class AppHarness {
  private tempDir: string | null = null;
  private app: AppServer | null = null;
  private wsClient: WsTestClient | null = null;
  private mockProvider: MockLLMProvider | null = null;
  private _agentId: string = 'test-agent';

  async start(options: AppHarnessOptions = {}): Promise<void> {
    const {
      mockResponses = [{ text: 'Hello from mock agent!' }],
      agents,
      toolsDeny,
      memoryEnabled = true,
      llmProvider,
    } = options;

    this.tempDir = await createTempDir();
    const basePath = path.join(this.tempDir, 'data');

    // Use a random high port to avoid conflicts between test suites
    const port = 18000 + Math.floor(Math.random() * 2000);

    // Generate unique agent ID per suite to isolate NATS subjects
    const suffix = crypto.randomBytes(4).toString('hex');
    this._agentId = `test-agent-${suffix}`;

    const configPath = await writeTestConfig(this.tempDir, {
      port,
      agents: agents ?? [
        {
          id: this._agentId,
          name: 'Test Agent',
          description: 'Agent for E2E tests',
          persona: 'You are a test assistant. Keep responses short.',
          tools: { allow: ['*'] },
        },
      ],
      toolsDeny,
      memoryEnabled,
    });

    if (llmProvider) {
      this.mockProvider = null;
    } else {
      this.mockProvider = new MockLLMProvider(mockResponses);
    }

    const provider = llmProvider ?? this.mockProvider!;

    this.app = await bootstrap({
      configPath,
      basePath,
      fs: createNodeFs(),
      logger: createTestLogger(),
      llmProviders: [provider],
    });

    // Connect WS client
    this.wsClient = new WsTestClient();
    await this.wsClient.connect({ port, timeout: 5000 });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      await this.wsClient.disconnect();
      this.wsClient = null;
    }
    if (this.app) {
      await this.app.shutdown();
      this.app = null;
    }
    if (this.tempDir) {
      await cleanupTempDir(this.tempDir);
      this.tempDir = null;
    }
  }

  get client(): WsTestClient {
    if (!this.wsClient) throw new Error('Harness not started');
    return this.wsClient;
  }

  get server(): AppServer {
    if (!this.app) throw new Error('Harness not started');
    return this.app;
  }

  get mock(): MockLLMProvider {
    if (!this.mockProvider) throw new Error('No mock provider');
    return this.mockProvider;
  }

  /** The agent ID for this harness instance (unique per suite). */
  get agentId(): string {
    return this._agentId;
  }

  get basePath(): string {
    if (!this.tempDir) throw new Error('Harness not started');
    return path.join(this.tempDir, 'data');
  }
}
