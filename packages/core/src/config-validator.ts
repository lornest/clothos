import JSON5 from 'json5';
import { readFileSync } from 'node:fs';
import type { ClothosConfig } from './config.js';
import { isRecord } from './utils.js';

/** Sections that must exist at the top level of the config. */
const REQUIRED_SECTIONS = [
  'gateway',
  'agents',
  'bindings',
  'models',
  'auth',
  'session',
  'tools',
  'sandbox',
  'plugins',
] as const;

/** All valid top-level keys (required + optional). */
const VALID_TOP_LEVEL_KEYS = new Set<string>([...REQUIRED_SECTIONS, 'memory', 'skills', 'channels', 'orchestrator']);

export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  config?: ClothosConfig;
}

/**
 * Parse and validate a JSON5 config string.
 * Rejects unknown top-level keys (strict mode).
 */
export function validateConfig(json5String: string): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  const isString = (value: unknown): value is string => typeof value === 'string';
  const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
  const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

  let parsed: unknown;
  try {
    parsed = JSON5.parse(json5String);
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: '', message: `Invalid JSON5: ${String(err)}` }],
    };
  }

  if (!isRecord(parsed)) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Config must be an object' }],
    };
  }

  // Check for unknown top-level keys (strict mode)
  for (const key of Object.keys(parsed)) {
    if (!VALID_TOP_LEVEL_KEYS.has(key)) {
      errors.push({ path: key, message: `Unknown top-level key: "${key}"` });
    }
  }

  // Check for required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in parsed)) {
      errors.push({ path: section, message: `Missing required section: "${section}"` });
    } else if (!isRecord(parsed[section]) && !Array.isArray(parsed[section])) {
      errors.push({
        path: section,
        message: `Section "${section}" must be an object or array`,
      });
    }
  }

  // Shallow type validation for required sections and critical fields
  const root = parsed as Record<string, unknown>;
  const gateway = root.gateway;
  if (isRecord(gateway)) {
    if (!isRecord(gateway.nats) || !isString(gateway.nats.url)) {
      errors.push({ path: 'gateway.nats.url', message: 'Expected string URL' });
    }
    if (!isRecord(gateway.redis) || !isString(gateway.redis.url)) {
      errors.push({ path: 'gateway.redis.url', message: 'Expected string URL' });
    }
    const websocket = gateway.websocket;
    if (!isRecord(websocket)) {
      errors.push({ path: 'gateway.websocket', message: 'Expected object' });
    } else {
      if (!isNumber(websocket.port)) {
        errors.push({ path: 'gateway.websocket.port', message: 'Expected number' });
      }
      if (websocket.allowAnonymous !== undefined && !isBoolean(websocket.allowAnonymous)) {
        errors.push({ path: 'gateway.websocket.allowAnonymous', message: 'Expected boolean' });
      }
      if (websocket.sharedSecret !== undefined && !isString(websocket.sharedSecret)) {
        errors.push({ path: 'gateway.websocket.sharedSecret', message: 'Expected string' });
      }
      if (websocket.jwtSecret !== undefined && !isString(websocket.jwtSecret)) {
        errors.push({ path: 'gateway.websocket.jwtSecret', message: 'Expected string' });
      }
      if (websocket.tokenExpiryMs !== undefined && !isNumber(websocket.tokenExpiryMs)) {
        errors.push({ path: 'gateway.websocket.tokenExpiryMs', message: 'Expected number' });
      }
      if (websocket.responseTtlMs !== undefined && !isNumber(websocket.responseTtlMs)) {
        errors.push({ path: 'gateway.websocket.responseTtlMs', message: 'Expected number' });
      }
    }
    if (!isNumber(gateway.maxConcurrentAgents)) {
      errors.push({ path: 'gateway.maxConcurrentAgents', message: 'Expected number' });
    }
  }

  const agents = root.agents;
  if (isRecord(agents)) {
    const defaults = agents.defaults;
    if (!isRecord(defaults)) {
      errors.push({ path: 'agents.defaults', message: 'Expected object' });
    } else {
      if (!isString(defaults.model)) {
        errors.push({ path: 'agents.defaults.model', message: 'Expected string' });
      }
      if (!isNumber(defaults.contextWindow)) {
        errors.push({ path: 'agents.defaults.contextWindow', message: 'Expected number' });
      }
      if (!isNumber(defaults.maxTurns)) {
        errors.push({ path: 'agents.defaults.maxTurns', message: 'Expected number' });
      }
    }
    if (!isArray(agents.list)) {
      errors.push({ path: 'agents.list', message: 'Expected array' });
    }
  }

  if (root.bindings !== undefined && !isArray(root.bindings)) {
    errors.push({ path: 'bindings', message: 'Expected array' });
  }

  const models = root.models;
  if (isRecord(models)) {
    if (!isArray(models.providers)) {
      errors.push({ path: 'models.providers', message: 'Expected array' });
    }
    if (!isArray(models.fallbacks)) {
      errors.push({ path: 'models.fallbacks', message: 'Expected array' });
    }
  }

  const auth = root.auth;
  if (isRecord(auth)) {
    if (!isArray(auth.profiles)) {
      errors.push({ path: 'auth.profiles', message: 'Expected array' });
    }
  }

  const session = root.session;
  if (isRecord(session)) {
    if (!isNumber(session.idleTimeoutMs)) {
      errors.push({ path: 'session.idleTimeoutMs', message: 'Expected number' });
    }
    if (!isNumber(session.maxHistoryEntries)) {
      errors.push({ path: 'session.maxHistoryEntries', message: 'Expected number' });
    }
    const compaction = session.compaction;
    if (!isRecord(compaction)) {
      errors.push({ path: 'session.compaction', message: 'Expected object' });
    } else {
      if (!isBoolean(compaction.enabled)) {
        errors.push({ path: 'session.compaction.enabled', message: 'Expected boolean' });
      }
      if (!isNumber(compaction.reserveTokens)) {
        errors.push({ path: 'session.compaction.reserveTokens', message: 'Expected number' });
      }
    }
  }

  const tools = root.tools;
  if (isRecord(tools)) {
    if (tools.allow !== undefined && !isArray(tools.allow)) {
      errors.push({ path: 'tools.allow', message: 'Expected array' });
    }
    if (tools.deny !== undefined && !isArray(tools.deny)) {
      errors.push({ path: 'tools.deny', message: 'Expected array' });
    }
    if (tools.mcpServers !== undefined && !isArray(tools.mcpServers)) {
      errors.push({ path: 'tools.mcpServers', message: 'Expected array' });
    }
  }

  const sandbox = root.sandbox;
  if (isRecord(sandbox)) {
    if (!isString(sandbox.mode)) {
      errors.push({ path: 'sandbox.mode', message: 'Expected string' });
    }
    if (!isString(sandbox.scope)) {
      errors.push({ path: 'sandbox.scope', message: 'Expected string' });
    }
    const docker = sandbox.docker;
    if (!isRecord(docker)) {
      errors.push({ path: 'sandbox.docker', message: 'Expected object' });
    } else if (!isString(docker.image)) {
      errors.push({ path: 'sandbox.docker.image', message: 'Expected string' });
    }
  }

  const plugins = root.plugins;
  if (isRecord(plugins)) {
    if (!isArray(plugins.directories)) {
      errors.push({ path: 'plugins.directories', message: 'Expected array' });
    }
    if (!isArray(plugins.enabled)) {
      errors.push({ path: 'plugins.enabled', message: 'Expected array' });
    }
    if (!isArray(plugins.disabled)) {
      errors.push({ path: 'plugins.disabled', message: 'Expected array' });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    config: errors.length === 0 ? (parsed as unknown as ClothosConfig) : undefined,
  };
}

/**
 * Load and validate a JSON5 config file from disk.
 */
export function loadConfig(filePath: string): ConfigValidationResult {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: '', message: `Cannot read config file: ${String(err)}` }],
    };
  }
  return validateConfig(content);
}
