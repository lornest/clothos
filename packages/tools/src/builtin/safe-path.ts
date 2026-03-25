import { resolve } from 'node:path';

/**
 * Resolve a user-supplied path against the workspace root and guard against
 * path-traversal attacks.  Returns the resolved absolute path or throws.
 */
export function safePath(workspaceRoot: string, userPath: string): string {
  const resolved = resolve(workspaceRoot, userPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return resolved;
}
