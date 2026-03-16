import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { MemoryChunk, MemoryConfig } from '../src/types.js';
import { DEFAULT_MEMORY_CONFIG } from '../src/config.js';

export function createTestDbPath(): string {
  const dir = join(tmpdir(), 'clothos-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.sqlite');
}

export function cleanupTestDb(dbPath: string): void {
  try {
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

export function testMemoryConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    ...DEFAULT_MEMORY_CONFIG,
    embedding: {
      ...DEFAULT_MEMORY_CONFIG.embedding,
      provider: 'none',
      dimensions: 3,
    },
    ...overrides,
  };
}

export function makeChunk(overrides?: Partial<MemoryChunk>): MemoryChunk {
  return {
    id: randomUUID(),
    agentId: 'test-agent',
    sessionId: 'test-session',
    content: 'This is test content for memory chunk.',
    importance: 0.5,
    tokenCount: 10,
    sourceType: 'conversation',
    chunkIndex: 0,
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}
