import type { Message } from '@clothos/core';
import { generateId, now } from '@clothos/core';
import { chunkText, estimateTokens } from './chunker.js';
import type { ImportanceScorer } from './importance-scorer.js';
import type { EpisodicMemoryStore } from './memory-store.js';
import type { ChunkingConfig, EmbeddingProvider, MemoryChunk } from './types.js';

export interface MemoryFlushContext {
  context: {
    getHistory(): Message[];
    readonly agentId: string;
    readonly sessionId: string;
  };
}

/**
 * Create a hook handler for the memory_flush lifecycle event.
 * When fired by ContextCompactor.compact(), this handler:
 * 1. Extracts conversation history from context
 * 2. Scores importance
 * 3. Chunks the text
 * 4. Embeds chunks
 * 5. Upserts into episodic store
 * 6. Returns context unchanged (pass-through)
 */
export function createMemoryFlushHandler(
  store: EpisodicMemoryStore,
  embeddingProvider: EmbeddingProvider,
  importanceScorer: ImportanceScorer,
  chunkingConfig: ChunkingConfig,
): (context: unknown) => Promise<unknown> {
  return async (hookContext: unknown) => {
    const ctx = hookContext as MemoryFlushContext;
    if (!ctx?.context?.getHistory) return hookContext;

    const history = ctx.context.getHistory();
    if (history.length === 0) return hookContext;

    const agentId = ctx.context.agentId;
    const sessionId = ctx.context.sessionId;

    // Build text from conversation
    const text = history
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n\n');

    // Chunk the text
    const chunkTexts = chunkText(text, chunkingConfig);
    if (chunkTexts.length === 0) return hookContext;

    // Score importance and embed in parallel
    const chunks: MemoryChunk[] = [];

    for (let i = 0; i < chunkTexts.length; i++) {
      const content = chunkTexts[i]!;
      const importance = await importanceScorer.score(content);

      let embedding: number[] | undefined;
      if (embeddingProvider.dimensions > 0) {
        try {
          embedding = await embeddingProvider.embedSingle(content);
        } catch {
          // Continue without embedding — BM25 will still work
        }
      }

      chunks.push({
        id: generateId(),
        agentId,
        sessionId,
        content,
        importance,
        tokenCount: estimateTokens(content),
        sourceType: 'conversation',
        chunkIndex: i,
        createdAt: now(),
        metadata: { flushedAt: now() },
        embedding,
      });
    }

    // Batch embed if provider supports it
    if (embeddingProvider.dimensions > 0) {
      const textsNeedingEmbed = chunks
        .filter((c) => !c.embedding || c.embedding.length === 0)
        .map((c) => c.content);

      if (textsNeedingEmbed.length > 0) {
        try {
          const embeddings = await embeddingProvider.embed(textsNeedingEmbed);
          let embedIdx = 0;
          for (const chunk of chunks) {
            if (!chunk.embedding || chunk.embedding.length === 0) {
              chunk.embedding = embeddings[embedIdx];
              embedIdx++;
            }
          }
        } catch {
          // Proceed without embeddings
        }
      }
    }

    store.upsertChunks(chunks);

    // Pass-through: return context unchanged
    return hookContext;
  };
}
