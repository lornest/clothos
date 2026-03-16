import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine } from '../src/policy-engine.js';
import { ToolRegistry } from '../src/registry.js';
import type {
  AgentEntry,
  PolicyContext,
  SandboxConfig,
  ToolDefinition,
  ToolHandler,
  ToolsConfig,
} from '@clothos/core';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a minimal valid ToolDefinition. */
function makeDef(name: string, description = `Tool ${name}`): ToolDefinition {
  return { name, description, inputSchema: { type: 'object' } };
}

/** Create a trivial ToolHandler. */
function makeHandler(): ToolHandler {
  return async () => 'ok';
}

/** Default SandboxConfig for tests. */
const defaultSandbox: SandboxConfig = {
  mode: 'off',
  scope: 'session',
  docker: {
    image: 'clothos-sandbox:latest',
    memoryLimit: '512m',
    cpuLimit: '1.0',
    pidsLimit: 100,
    networkMode: 'none',
    readOnlyRoot: true,
    tmpfsSize: '64m',
    timeout: 30_000,
  },
};

/** Default PolicyContext for tests. */
function makeCtx(agentId = 'agent-1'): PolicyContext {
  return { agentId };
}

/**
 * Populate a registry with a standard set of test tools:
 * - builtin: bash, read_file, write_file, edit_file
 * - mcp: mcp_search, mcp_calendar
 * - memory: memory_search, memory_get
 */
function populateRegistry(registry: ToolRegistry): void {
  // builtins
  registry.register(makeDef('bash'), makeHandler(), 'builtin');
  registry.register(makeDef('read_file'), makeHandler(), 'builtin');
  registry.register(makeDef('write_file'), makeHandler(), 'builtin');
  registry.register(makeDef('edit_file'), makeHandler(), 'builtin');

  // MCP
  registry.register(makeDef('mcp_search', 'Search via MCP'), makeHandler(), 'mcp', 'search-srv');
  registry.register(
    makeDef('mcp_calendar', 'Calendar via MCP'),
    makeHandler(),
    'mcp',
    'calendar-srv',
  );

  // memory
  registry.register(makeDef('memory_search'), makeHandler(), 'memory');
  registry.register(makeDef('memory_get'), makeHandler(), 'memory');
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('PolicyEngine', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    populateRegistry(registry);
  });

  // ── allow-all (wildcard) ──────────────────────────────────────────

  describe('allow-all (wildcard)', () => {
    it('allows every tool when global allow is ["*"] and no deny', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      expect(engine.isAllowed('bash', ctx)).toBe(true);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('mcp_search', ctx)).toBe(true);
      expect(engine.isAllowed('memory_search', ctx)).toBe(true);
    });
  });

  // ── agent-level deny ──────────────────────────────────────────────

  describe('agent-level deny', () => {
    it('denies a tool when agent deny list includes it', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', tools: { deny: ['bash'] } },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('write_file', ctx)).toBe(true);
    });
  });

  // ── deny-wins-over-wildcard ───────────────────────────────────────

  describe('deny wins over wildcard', () => {
    it('denies a tool even when global allow is wildcard', () => {
      const tools: ToolsConfig = { allow: ['*'], deny: ['bash'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
    });
  });

  // ── pinned MCP tools in builtin list ──────────────────────────────

  describe('pinned tools in builtin list', () => {
    it('includes pinned MCP tools in getEffectiveBuiltinTools', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', mcpPinned: ['mcp_search'] },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      const builtins = engine.getEffectiveBuiltinTools(ctx);
      const names = builtins.map((d) => d.name);

      // Pinned MCP tool should appear in builtin list
      expect(names).toContain('mcp_search');
      // Non-pinned MCP tool should NOT appear in builtin list
      expect(names).not.toContain('mcp_calendar');
      // Regular builtins should still be present
      expect(names).toContain('bash');
      expect(names).toContain('read_file');
    });
  });

  // ── catalog excludes pinned ───────────────────────────────────────

  describe('catalog excludes pinned', () => {
    it('getEffectiveMcpCatalog skips pinned MCP tools', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', mcpPinned: ['mcp_search'] },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      const catalog = engine.getEffectiveMcpCatalog(ctx);
      const catalogNames = catalog.map((c) => c.name);

      // Pinned tool should be excluded from catalog
      expect(catalogNames).not.toContain('mcp_search');
      // Non-pinned MCP tool should remain in catalog
      expect(catalogNames).toContain('mcp_calendar');
    });
  });

  // ── empty allow = no tools ────────────────────────────────────────

  describe('empty allow = no tools', () => {
    it('allows nothing when global allow is an empty array', () => {
      const tools: ToolsConfig = { allow: [] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(false);
      expect(engine.isAllowed('mcp_search', ctx)).toBe(false);
      expect(engine.isAllowed('memory_search', ctx)).toBe(false);
    });

    it('getEffectiveBuiltinTools returns empty for empty allow', () => {
      const tools: ToolsConfig = { allow: [] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      const builtins = engine.getEffectiveBuiltinTools(ctx);
      expect(builtins).toHaveLength(0);
    });
  });

  // ── group expansion in allow lists ────────────────────────────────

  describe('group expansion in allow lists', () => {
    it('allow: ["group:fs"] expands to read_file, write_file, edit_file', () => {
      const tools: ToolsConfig = { allow: ['group:fs'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('write_file', ctx)).toBe(true);
      expect(engine.isAllowed('edit_file', ctx)).toBe(true);
      // bash is NOT in group:fs
      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('mcp_search', ctx)).toBe(false);
    });
  });

  // ── group expansion in deny lists ─────────────────────────────────

  describe('group expansion in deny lists', () => {
    it('deny: ["group:runtime"] blocks bash', () => {
      const tools: ToolsConfig = { allow: ['*'], deny: ['group:runtime'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      // bash is in group:runtime
      expect(engine.isAllowed('bash', ctx)).toBe(false);
      // Other tools not in group:runtime remain allowed
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('write_file', ctx)).toBe(true);
      expect(engine.isAllowed('mcp_search', ctx)).toBe(true);
    });
  });

  // ── unknown group names passed through as literals ────────────────

  describe('unknown group names passed through as literals', () => {
    it('"group:nonexistent" is treated as a literal string', () => {
      const tools: ToolsConfig = { allow: ['group:nonexistent'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      // The literal string "group:nonexistent" is in the allow set, but no real tool matches
      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(false);
      // But if a tool were actually named "group:nonexistent" it would be allowed
      expect(engine.isAllowed('group:nonexistent', ctx)).toBe(true);
    });
  });

  // ── agent-level allow replaces global allow ───────────────────────

  describe('agent-level allow replaces global allow', () => {
    it('agent allow overrides global allow entirely', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', tools: { allow: ['bash', 'read_file'] } },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      // Only agent-level allow set applies
      expect(engine.isAllowed('bash', ctx)).toBe(true);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      // write_file is NOT in agent allow list
      expect(engine.isAllowed('write_file', ctx)).toBe(false);
      expect(engine.isAllowed('mcp_search', ctx)).toBe(false);
    });
  });

  // ── agent without tools config inherits global ────────────────────

  describe('agent without tools config', () => {
    it('inherits global policy when agent has no tools override', () => {
      const tools: ToolsConfig = { allow: ['bash', 'read_file'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx();

      expect(engine.isAllowed('bash', ctx)).toBe(true);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('write_file', ctx)).toBe(false);
    });
  });

  // ── unknown agent falls back to global policy ─────────────────────

  describe('unknown agent falls back to global', () => {
    it('uses global policy when no matching agent entry exists', () => {
      const tools: ToolsConfig = { allow: ['*'], deny: ['bash'] };
      const agents: AgentEntry[] = [{ id: 'other-agent', name: 'Other' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx = makeCtx('agent-1'); // agent-1 not in agents list

      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
    });
  });

  // ── binding-level overrides ───────────────────────────────────────

  describe('binding-level overrides', () => {
    it('binding deny stacks with agent deny', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', tools: { deny: ['bash'] } },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx: PolicyContext = {
        agentId: 'agent-1',
        bindingTools: { deny: ['write_file'] },
      };

      expect(engine.isAllowed('bash', ctx)).toBe(false);       // agent deny
      expect(engine.isAllowed('write_file', ctx)).toBe(false);  // binding deny
      expect(engine.isAllowed('read_file', ctx)).toBe(true);    // allowed
    });

    it('binding allow narrows agent allow (intersection)', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', tools: { allow: ['bash', 'read_file', 'write_file'] } },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx: PolicyContext = {
        agentId: 'agent-1',
        bindingTools: { allow: ['read_file', 'edit_file'] },
      };

      // Only read_file is in both agent allow and binding allow
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('bash', ctx)).toBe(false);       // not in binding allow
      expect(engine.isAllowed('write_file', ctx)).toBe(false);  // not in binding allow
      expect(engine.isAllowed('edit_file', ctx)).toBe(false);   // not in agent allow
    });

    it('binding allow narrows wildcard to explicit set', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx: PolicyContext = {
        agentId: 'agent-1',
        bindingTools: { allow: ['read_file'] },
      };

      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('write_file', ctx)).toBe(false);
    });

    it('binding deny-only: deny added, allow unchanged', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [{ id: 'agent-1', name: 'Agent 1' }];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx: PolicyContext = {
        agentId: 'agent-1',
        bindingTools: { deny: ['bash'] },
      };

      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('write_file', ctx)).toBe(true);
    });

    it('no binding tools: existing behavior unchanged', () => {
      const tools: ToolsConfig = { allow: ['*'] };
      const agents: AgentEntry[] = [
        { id: 'agent-1', name: 'Agent 1', tools: { deny: ['bash'] } },
      ];
      const engine = new PolicyEngine(tools, agents, defaultSandbox, registry);
      const ctx: PolicyContext = { agentId: 'agent-1' }; // no bindingTools

      expect(engine.isAllowed('bash', ctx)).toBe(false);
      expect(engine.isAllowed('read_file', ctx)).toBe(true);
      expect(engine.isAllowed('write_file', ctx)).toBe(true);
    });
  });
});
