import type { ToolDefinition } from '@clothos/core';
import type { ToolHandler } from '@clothos/agent-runtime';
import type { EpisodicMemoryStore } from './memory-store.js';
import type { EmbeddingProvider, SearchResult, SourceType } from './types.js';

const MAX_RESULT_CONTENT_CHARS = 2000;

export const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description:
    'Search your episodic memory for relevant past conversations and knowledge. ' +
    'Returns ranked results with content snippets and metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find relevant memories.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10).',
      },
      min_importance: {
        type: 'number',
        description: 'Minimum importance score filter (0-1).',
      },
      date_from: {
        type: 'string',
        description: 'Filter results from this date (ISO 8601).',
      },
      date_to: {
        type: 'string',
        description: 'Filter results up to this date (ISO 8601).',
      },
    },
    required: ['query'],
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export const memoryGetTool: ToolDefinition = {
  name: 'memory_get',
  description:
    'Retrieve specific memory chunks by ID, date, or session. ' +
    'Use this to fetch full content of known memories.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Retrieve a specific chunk by ID.',
      },
      date: {
        type: 'string',
        description: 'Retrieve chunks from a specific date (YYYY-MM-DD).',
      },
      session_id: {
        type: 'string',
        description: 'Retrieve chunks from a specific session.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of chunks to return (default: 100).',
      },
    },
  },
  annotations: {
    readOnly: true,
    riskLevel: 'green',
  },
};

export function createMemorySearchHandler(
  store: EpisodicMemoryStore,
  agentId: string,
  embeddingProvider: EmbeddingProvider,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const query = args['query'] as string;
    if (!query || typeof query !== 'string') {
      return { error: 'Missing required parameter: query' };
    }

    let embedding: number[] | undefined;
    if (embeddingProvider.dimensions > 0) {
      try {
        embedding = await embeddingProvider.embedSingle(query);
      } catch {
        // Fall back to BM25-only
      }
    }

    const results = store.search({
      query,
      agentId,
      embedding,
      maxResults: args['max_results'] as number | undefined,
      minImportance: args['min_importance'] as number | undefined,
      dateFrom: args['date_from'] as string | undefined,
      dateTo: args['date_to'] as string | undefined,
    });

    return formatSearchResults(results);
  };
}

export function createMemoryGetHandler(
  store: EpisodicMemoryStore,
  agentId: string,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const chunks = store.get({
      agentId,
      id: args['id'] as string | undefined,
      date: args['date'] as string | undefined,
      sessionId: args['session_id'] as string | undefined,
      limit: args['limit'] as number | undefined,
    });

    return chunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content.length > MAX_RESULT_CONTENT_CHARS
        ? chunk.content.slice(0, MAX_RESULT_CONTENT_CHARS) + '\n[truncated]'
        : chunk.content,
      importance: chunk.importance,
      sourceType: chunk.sourceType,
      createdAt: chunk.createdAt,
      sessionId: chunk.sessionId,
    }));
  };
}

function formatSearchResults(
  results: SearchResult[],
): Array<{
  id: string;
  content: string;
  score: number;
  importance: number;
  sourceType: SourceType;
  createdAt: string;
  matchType: string;
}> {
  return results.map((r) => ({
    id: r.chunk.id,
    content: r.chunk.content.length > MAX_RESULT_CONTENT_CHARS
      ? r.chunk.content.slice(0, MAX_RESULT_CONTENT_CHARS) + '\n[truncated]'
      : r.chunk.content,
    score: Math.round(r.score * 1000) / 1000,
    importance: r.chunk.importance,
    sourceType: r.chunk.sourceType,
    createdAt: r.chunk.createdAt,
    matchType: r.matchType,
  }));
}
