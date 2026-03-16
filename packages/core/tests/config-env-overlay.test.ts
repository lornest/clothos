import { describe, it, expect } from 'vitest';
import { applyEnvOverrides } from '../src/config-env-overlay.js';

describe('applyEnvOverrides', () => {
  it('sets a nested path from an env var', () => {
    const config = { gateway: { websocket: { port: 8080 } } };
    applyEnvOverrides(config, {
      CLOTHOS_GATEWAY__WEBSOCKET__PORT: '9999',
    });
    expect(config.gateway.websocket.port).toBe(9999);
  });

  it('sets a top-level path', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CLOTHOS_SOMEFIELD: 'hello',
    });
    expect(config['somefield']).toBe('hello');
  });

  it('coerces numbers', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CLOTHOS_PORT: '3000',
      CLOTHOS_RATIO: '0.75',
      CLOTHOS_NEGATIVE: '-42',
    });
    expect(config['port']).toBe(3000);
    expect(config['ratio']).toBe(0.75);
    expect(config['negative']).toBe(-42);
  });

  it('coerces booleans', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CLOTHOS_ENABLED: 'true',
      CLOTHOS_DISABLED: 'false',
    });
    expect(config['enabled']).toBe(true);
    expect(config['disabled']).toBe(false);
  });

  it('leaves non-numeric strings as strings', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CLOTHOS_NAME: 'my-agent',
    });
    expect(config['name']).toBe('my-agent');
  });

  it('ignores env vars without the prefix', () => {
    const config: Record<string, unknown> = { original: 'value' };
    applyEnvOverrides(config, {
      OTHER_VAR: 'ignored',
      HOME: '/home/user',
      CLOTHOS_ADDED: 'yes',
    });
    expect(config['original']).toBe('value');
    expect(config['added']).toBe('yes');
    expect(config).not.toHaveProperty('other_var');
    expect(config).not.toHaveProperty('home');
  });

  it('creates intermediate objects for deep paths', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CLOTHOS_A__B__C__D: 'deep',
    });
    expect((config as any).a.b.c.d).toBe('deep');
  });

  it('uses process.env by default when no env is provided', () => {
    const config: Record<string, unknown> = {};
    // This test just ensures no error is thrown with default env
    applyEnvOverrides(config);
    // We can't predict process.env contents, just verify it returns
    expect(config).toBeDefined();
  });

  it('converts keys to lowercase', () => {
    const config: Record<string, unknown> = {};
    applyEnvOverrides(config, {
      CLOTHOS_GATEWAY__WEBSOCKET__HOST: 'localhost',
    });
    expect((config as any).gateway.websocket.host).toBe('localhost');
  });

  it('returns the same config reference', () => {
    const config = { a: 1 };
    const result = applyEnvOverrides(config, {});
    expect(result).toBe(config);
  });
});
