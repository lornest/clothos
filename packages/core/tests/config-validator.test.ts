import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { validateConfig, loadConfig } from '../src/index.js';

const VALID_CONFIG = `{
  gateway: { nats: { url: "nats://localhost:4222" }, redis: { url: "redis://localhost:6379" }, websocket: { port: 18789, allowAnonymous: true }, maxConcurrentAgents: 5 },
  agents: { defaults: { model: "pi-mono", contextWindow: 128000, maxTurns: 100 }, list: [] },
  bindings: [],
  models: { providers: [], fallbacks: [] },
  auth: { profiles: [] },
  session: { idleTimeoutMs: 1800000, maxHistoryEntries: 1000, compaction: { enabled: true, reserveTokens: 20000 } },
  tools: { allow: ["*"], deny: [], mcpServers: [] },
  sandbox: { mode: "off", scope: "session", docker: { image: "sandbox:latest", memoryLimit: "512m", cpuLimit: "1.0", pidsLimit: 256, networkMode: "none", readOnlyRoot: true, tmpfsSize: "100m", timeout: 30 } },
  plugins: { directories: [], enabled: [], disabled: [] },
}`;

describe('config validator', () => {
  it('accepts a valid config', () => {
    const result = validateConfig(VALID_CONFIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.config).toBeDefined();
  });

  it('rejects malformed JSON5', () => {
    const result = validateConfig('{ this is not valid json5 !!!');
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/Invalid JSON5/);
  });

  it('rejects non-object config', () => {
    const result = validateConfig('"just a string"');
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe('Config must be an object');
  });

  it('rejects unknown top-level keys', () => {
    const result = validateConfig(`{
      gateway: {}, agents: { defaults: {}, list: [] }, bindings: [],
      models: {}, auth: {}, session: {}, tools: {}, sandbox: {}, plugins: {},
      unknownKey: "should fail"
    }`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Unknown top-level key'))).toBe(true);
  });

  it('reports missing required sections', () => {
    const result = validateConfig('{}');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(9); // All 9 sections missing
    expect(result.errors.every((e) => e.message.includes('Missing required section'))).toBe(true);
  });

  it('loads and validates the default.json5 file', () => {
    const configPath = resolve(import.meta.dirname, '../../../config/default.json5');
    const result = loadConfig(configPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('handles missing file gracefully', () => {
    const result = loadConfig('/nonexistent/path/config.json5');
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/Cannot read config file/);
  });

  it('supports JSON5 features (comments, trailing commas)', () => {
    const result = validateConfig(`{
      // This is a comment
      gateway: { nats: { url: "nats://localhost:4222" }, redis: { url: "redis://localhost:6379" }, websocket: { port: 18789, allowAnonymous: true, }, maxConcurrentAgents: 5, },
      agents: { defaults: { model: "pi-mono", contextWindow: 128000, maxTurns: 100, }, list: [], },  // trailing comma
      bindings: [],
      models: { providers: [], fallbacks: [], },
      auth: { profiles: [], },
      session: { idleTimeoutMs: 1800000, maxHistoryEntries: 1000, compaction: { enabled: true, reserveTokens: 20000, }, },
      tools: {},
      sandbox: { mode: "off", scope: "session", docker: { image: "sandbox:latest", }, },
      plugins: { directories: [], enabled: [], disabled: [], },
    }`);
    expect(result.valid).toBe(true);
  });

  it('accepts config without sharedSecret when allowAnonymous is false', () => {
    const result = validateConfig(`{
      gateway: { nats: { url: "nats://localhost:4222" }, redis: { url: "redis://localhost:6379" }, websocket: { port: 18789, allowAnonymous: false }, maxConcurrentAgents: 5 },
      agents: { defaults: { model: "pi-mono", contextWindow: 128000, maxTurns: 100 }, list: [] },
      bindings: [],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
      session: { idleTimeoutMs: 1800000, maxHistoryEntries: 1000, compaction: { enabled: true, reserveTokens: 20000 } },
      tools: {},
      sandbox: { mode: "off", scope: "session", docker: { image: "sandbox:latest" } },
      plugins: { directories: [], enabled: [], disabled: [] },
    }`);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates jwtSecret and tokenExpiryMs types', () => {
    const result = validateConfig(`{
      gateway: { nats: { url: "nats://localhost:4222" }, redis: { url: "redis://localhost:6379" }, websocket: { port: 18789, allowAnonymous: true, jwtSecret: 123, tokenExpiryMs: "bad" }, maxConcurrentAgents: 5 },
      agents: { defaults: { model: "pi-mono", contextWindow: 128000, maxTurns: 100 }, list: [] },
      bindings: [],
      models: { providers: [], fallbacks: [] },
      auth: { profiles: [] },
      session: { idleTimeoutMs: 1800000, maxHistoryEntries: 1000, compaction: { enabled: true, reserveTokens: 20000 } },
      tools: {},
      sandbox: { mode: "off", scope: "session", docker: { image: "sandbox:latest" } },
      plugins: { directories: [], enabled: [], disabled: [] },
    }`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'gateway.websocket.jwtSecret')).toBe(true);
    expect(result.errors.some((e) => e.path === 'gateway.websocket.tokenExpiryMs')).toBe(true);
  });
});
