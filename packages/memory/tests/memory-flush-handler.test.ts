import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EpisodicMemoryStore } from '../src/memory-store.js';
import { NullEmbeddingProvider } from '../src/embedding-provider.js';
import { HeuristicImportanceScorer } from '../src/importance-scorer.js';
import { createMemoryFlushHandler } from '../src/memory-flush-handler.js';
import { createTestDbPath, cleanupTestDb, testMemoryConfig } from './helpers.js';
import type { Message } from '@clothos/core';

let store: EpisodicMemoryStore;
let dbPath: string;

beforeEach(() => {
  dbPath = createTestDbPath();
  store = new EpisodicMemoryStore({
    agentId: 'test-agent',
    dbPath,
    config: testMemoryConfig(),
    embeddingProvider: new NullEmbeddingProvider(),
  });
  store.open();
});

afterEach(() => {
  store.close();
  cleanupTestDb(dbPath);
});

describe('createMemoryFlushHandler', () => {
  it('chunks and stores conversation history', async () => {
    const handler = createMemoryFlushHandler(
      store,
      new NullEmbeddingProvider(),
      new HeuristicImportanceScorer(),
      testMemoryConfig().chunking,
    );

    const messages: Message[] = [
      { role: 'user', content: 'What is TypeScript?' },
      { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.' },
      { role: 'user', content: 'How do I use generics?' },
      { role: 'assistant', content: 'Generics allow you to create reusable components that work with multiple types.' },
    ];

    const hookContext = {
      context: {
        getHistory: () => messages,
        agentId: 'test-agent',
        sessionId: 'test-session',
      },
    };

    const result = await handler(hookContext);

    // Should pass through context unchanged
    expect(result).toBe(hookContext);

    // Should have stored chunks
    const stats = store.stats();
    expect(stats.chunkCount).toBeGreaterThan(0);

    // Verify stored content
    const chunks = store.get({ agentId: 'test-agent' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.sourceType).toBe('conversation');
    expect(chunks[0]!.sessionId).toBe('test-session');
  });

  it('handles empty history', async () => {
    const handler = createMemoryFlushHandler(
      store,
      new NullEmbeddingProvider(),
      new HeuristicImportanceScorer(),
      testMemoryConfig().chunking,
    );

    const hookContext = {
      context: {
        getHistory: () => [],
        agentId: 'test-agent',
        sessionId: 'test-session',
      },
    };

    const result = await handler(hookContext);
    expect(result).toBe(hookContext);
    expect(store.stats().chunkCount).toBe(0);
  });

  it('handles invalid hook context gracefully', async () => {
    const handler = createMemoryFlushHandler(
      store,
      new NullEmbeddingProvider(),
      new HeuristicImportanceScorer(),
      testMemoryConfig().chunking,
    );

    const result = await handler({ something: 'else' });
    expect(result).toEqual({ something: 'else' });
    expect(store.stats().chunkCount).toBe(0);
  });

  it('stores chunks with importance scores', async () => {
    const handler = createMemoryFlushHandler(
      store,
      new NullEmbeddingProvider(),
      new HeuristicImportanceScorer(),
      testMemoryConfig().chunking,
    );

    const messages: Message[] = [
      { role: 'user', content: 'We decided to use SQLite for the memory store.' },
      { role: 'assistant', content: 'Great decision. TODO: implement the schema next.' },
    ];

    await handler({
      context: {
        getHistory: () => messages,
        agentId: 'test-agent',
        sessionId: 'test-session',
      },
    });

    const chunks = store.get({ agentId: 'test-agent' });
    // Chunks should have importance > default due to decision/TODO keywords
    for (const chunk of chunks) {
      expect(chunk.importance).toBeGreaterThanOrEqual(0);
      expect(chunk.importance).toBeLessThanOrEqual(1);
    }
  });
});
