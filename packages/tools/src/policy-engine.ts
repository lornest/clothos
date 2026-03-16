import type {
  AgentEntry,
  PolicyContext,
  SandboxConfig,
  ToolDefinition,
  ToolsConfig,
} from '@clothos/core';
import type { ToolRegistry } from './registry.js';
import { expandGroups } from './tool-groups.js';

/**
 * Layered permission resolution: Global -> Agent -> Session -> Sandbox.
 * Deny always wins at every layer.
 */
export class PolicyEngine {
  readonly sandbox: SandboxConfig;

  constructor(
    private readonly globalTools: ToolsConfig,
    private readonly agents: AgentEntry[],
    sandbox: SandboxConfig,
    private readonly registry: ToolRegistry,
  ) {
    this.sandbox = sandbox;
  }

  /**
   * Returns the effective set of built-in + memory tools + use_mcp_tool meta-tool
   * + pinned MCP tools, filtered by policy for the given context.
   */
  getEffectiveBuiltinTools(ctx: PolicyContext): ToolDefinition[] {
    const allEntries = this.registry.getAll();
    const allowed: ToolDefinition[] = [];

    for (const entry of allEntries) {
      // Include builtin, memory, and plugin tools; also include pinned MCP tools
      if (entry.source === 'mcp' && !this.isPinned(entry.definition.name, ctx.agentId)) {
        continue;
      }
      if (this.isAllowed(entry.definition.name, ctx)) {
        allowed.push(entry.definition);
      }
    }

    return allowed;
  }

  /**
   * Returns a compact catalog of allowed MCP tools (excludes pinned ones,
   * since those are already in the builtin list).
   */
  getEffectiveMcpCatalog(
    ctx: PolicyContext,
  ): Array<{ name: string; description: string }> {
    const mcpEntries = this.registry.getBySource('mcp');
    const catalog: Array<{ name: string; description: string }> = [];

    for (const entry of mcpEntries) {
      if (this.isPinned(entry.definition.name, ctx.agentId)) continue;
      if (!this.isAllowed(entry.definition.name, ctx)) continue;
      catalog.push({
        name: entry.definition.name,
        description: entry.definition.description,
      });
    }

    return catalog;
  }

  /** Check if a single tool is allowed for the given context. */
  isAllowed(toolName: string, ctx: PolicyContext): boolean {
    const { allow, deny } = this.resolveEffectivePolicy(ctx);

    // Deny always wins
    if (deny.has(toolName)) return false;

    // If allow is empty (no allow rules), nothing is allowed
    if (allow.size === 0) return false;

    // Wildcard or explicit allow
    return allow.has('*') || allow.has(toolName);
  }

  /** Resolve the effective allow/deny sets by layering global + agent + binding policies. */
  private resolveEffectivePolicy(ctx: PolicyContext): {
    allow: Set<string>;
    deny: Set<string>;
  } {
    // Start with global
    let allow = this.globalTools.allow
      ? new Set(expandGroups(this.globalTools.allow))
      : new Set<string>(['*']);
    const deny = this.globalTools.deny
      ? new Set(expandGroups(this.globalTools.deny))
      : new Set<string>();

    // Layer agent-level overrides
    const agent = this.agents.find((a) => a.id === ctx.agentId);
    if (agent?.tools) {
      if (agent.tools.allow) {
        // Agent allow replaces global allow
        allow.clear();
        for (const name of expandGroups(agent.tools.allow)) {
          allow.add(name);
        }
      }
      if (agent.tools.deny) {
        for (const name of expandGroups(agent.tools.deny)) {
          deny.add(name);
        }
      }
    }

    // Layer binding-level overrides (can only narrow, never expand)
    if (ctx.bindingTools) {
      if (ctx.bindingTools.allow) {
        const bindingAllow = new Set(expandGroups(ctx.bindingTools.allow));
        // Intersect: only keep tools in both sets (or matching wildcard)
        if (!allow.has('*')) {
          // Intersect the two explicit sets
          const intersection = new Set<string>();
          for (const name of allow) {
            if (bindingAllow.has(name) || bindingAllow.has('*')) {
              intersection.add(name);
            }
          }
          allow = intersection;
        } else {
          // Agent/global is wildcard — binding narrows to its explicit set
          allow = bindingAllow;
        }
      }
      if (ctx.bindingTools.deny) {
        for (const name of expandGroups(ctx.bindingTools.deny)) {
          deny.add(name);
        }
      }
    }

    return { allow, deny };
  }

  /** Check if a tool name is in the agent's pinned MCP list. */
  private isPinned(toolName: string, agentId: string): boolean {
    const agent = this.agents.find((a) => a.id === agentId);
    return agent?.mcpPinned?.includes(toolName) ?? false;
  }
}
