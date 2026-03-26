import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getOAuthApiKey,
  openaiCodexOAuthProvider,
  anthropicOAuthProvider,
  type OAuthCredentials,
  type OAuthProviderInterface,
} from '@clothos/agent-runtime';

const AUTH_FILE = 'auth.json';

export interface StoredCredentials {
  [providerId: string]: OAuthCredentials;
}

function authFilePath(basePath: string): string {
  return path.join(basePath, AUTH_FILE);
}

export async function loadCredentials(basePath: string): Promise<StoredCredentials> {
  try {
    const raw = await fs.readFile(authFilePath(basePath), 'utf-8');
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return {};
  }
}

export async function saveCredentials(basePath: string, credentials: StoredCredentials): Promise<void> {
  await fs.mkdir(basePath, { recursive: true });
  await fs.writeFile(authFilePath(basePath), JSON.stringify(credentials, null, 2), 'utf-8');
}

/**
 * Resolve a provider name (e.g. "openai") to its pi-ai OAuth provider ID (e.g. "openai-codex").
 */
function resolveOAuthProviderId(providerName: string): string {
  const provider = getOAuthProviderForName(providerName);
  return provider?.id ?? providerName;
}

/**
 * Get a valid API key for the given provider.
 * Automatically refreshes expired tokens and persists updated credentials.
 */
export async function getOrRefreshApiKey(
  providerName: string,
  basePath: string,
): Promise<string | null> {
  const oauthId = resolveOAuthProviderId(providerName);
  const credentials = await loadCredentials(basePath);
  const result = await getOAuthApiKey(oauthId, credentials);
  if (!result) return null;

  // Persist updated credentials (may have been refreshed)
  credentials[oauthId] = result.newCredentials;
  await saveCredentials(basePath, credentials);

  return result.apiKey;
}

/**
 * Get the OAuth provider interface for a given provider name.
 */
export function getOAuthProviderForName(providerName: string): OAuthProviderInterface | null {
  switch (providerName) {
    case 'openai':
    case 'openai-completions':
    case 'openai-responses':
    case 'openai-codex':
      return openaiCodexOAuthProvider;
    case 'anthropic':
      return anthropicOAuthProvider;
    default:
      return null;
  }
}
