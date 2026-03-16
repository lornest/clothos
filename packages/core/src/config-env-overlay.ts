const PREFIX = 'CLOTHOS_';
const SEPARATOR = '__';

/**
 * Coerce a string value to a number, boolean, or leave as string.
 */
function coerce(value: string): string | number | boolean {
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Number (integer or float)
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }

  return value;
}

/**
 * Apply environment variable overrides to a config object.
 *
 * Variables must be prefixed with `CLOTHOS_`. Nesting is expressed
 * with double-underscore (`__`). Values are coerced to numbers/booleans
 * where possible.
 *
 * Example: `CLOTHOS_GATEWAY__WEBSOCKET__PORT=9999`
 *   → `config.gateway.websocket.port = 9999`
 *
 * @param config The config object to mutate in-place.
 * @param env    Optional env map (defaults to `process.env`).
 * @returns The mutated config (same reference).
 */
export function applyEnvOverrides<T extends object>(
  config: T,
  env: Record<string, string | undefined> = process.env,
): T {
  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || rawValue === undefined) continue;

    const path = key
      .slice(PREFIX.length)
      .toLowerCase()
      .split(SEPARATOR);

    if (path.length === 0 || path[0] === '') continue;

    setNested(config as unknown as Record<string, unknown>, path, coerce(rawValue));
  }

  return config;
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const next = current[segment];

    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      // Create intermediate object
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }

  current[path[path.length - 1]!] = value;
}
