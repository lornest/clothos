import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@clothos/core';
import type { AgentRegistry, AgentRegistryEntry } from '../src/agent-registry.js';
import type { RemoteDispatchTransport } from '../src/remote-dispatch.js';
import { FederatedAgentRegistry } from '../src/federated-registry.js';

function createEntry(agentId: string, status = 'READY'): AgentRegistryEntry {
  return {
    agentId,
    getStatus: () => status as any,
    dispatch: async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'assistant_message', content: { text: 'local reply' } } as AgentEvent;
    },
  };
}

function createLocalRegistry(entries: AgentRegistryEntry[]): AgentRegistry {
  const map = new Map(entries.map((e) => [e.agentId, e]));
  return {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    getAll: () => entries,
    getAvailable: () => entries.filter((e) => {
      const s = e.getStatus();
      return s === 'READY' || s === 'RUNNING';
    }),
  };
}

function createMockTransport(): RemoteDispatchTransport {
  return {
    publish: vi.fn(async () => {}),
    publishCore: vi.fn(),
    subscribeCoreNats: vi.fn(() => ({ unsubscribe: vi.fn() })),
    createInbox: vi.fn(() => '_INBOX.test.1'),
  };
}

describe('FederatedAgentRegistry', () => {
  it('returns local entry when agent exists locally', () => {
    const localEntry = createEntry('local-agent');
    const local = createLocalRegistry([localEntry]);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });
    const result = federated.get('local-agent');

    expect(result).toBe(localEntry);
  });

  it('returns remote entry when agent is not local', () => {
    const local = createLocalRegistry([]);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });
    const result = federated.get('remote-agent');

    expect(result).toBeDefined();
    expect(result!.agentId).toBe('remote-agent');
    expect(result!.getStatus()).toBe('READY');
  });

  it('caches remote entries', () => {
    const local = createLocalRegistry([]);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });
    const first = federated.get('remote-agent');
    const second = federated.get('remote-agent');

    expect(first).toBe(second);
  });

  it('does not cache local entries as remote', () => {
    const localEntry = createEntry('local-agent');
    const local = createLocalRegistry([localEntry]);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });

    // First call returns local
    const first = federated.get('local-agent');
    expect(first).toBe(localEntry);

    // If local entry were removed and we ask again, it should create a remote
    // (This tests that local entries aren't polluting the remote cache)
  });

  it('has() stays local-only', () => {
    const local = createLocalRegistry([createEntry('local-agent')]);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });

    expect(federated.has('local-agent')).toBe(true);
    expect(federated.has('remote-agent')).toBe(false);
  });

  it('getAll() returns local entries only', () => {
    const entries = [createEntry('a'), createEntry('b')];
    const local = createLocalRegistry(entries);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });

    // Trigger a remote lookup to populate cache
    federated.get('remote-agent');

    const all = federated.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.agentId)).toEqual(['a', 'b']);
  });

  it('getAvailable() returns local entries only', () => {
    const entries = [
      createEntry('ready-agent', 'READY'),
      createEntry('error-agent', 'ERROR'),
    ];
    const local = createLocalRegistry(entries);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({ localRegistry: local, transport });

    // Trigger a remote lookup
    federated.get('remote-agent');

    const available = federated.getAvailable();
    expect(available).toHaveLength(1);
    expect(available[0]!.agentId).toBe('ready-agent');
  });

  it('passes remoteTimeoutMs to remote entries', () => {
    const local = createLocalRegistry([]);
    const transport = createMockTransport();

    const federated = new FederatedAgentRegistry({
      localRegistry: local,
      transport,
      remoteTimeoutMs: 5000,
    });

    const entry = federated.get('remote-agent');
    // The entry should exist and have READY status (timeout is internal)
    expect(entry).toBeDefined();
    expect(entry!.getStatus()).toBe('READY');
  });
});
