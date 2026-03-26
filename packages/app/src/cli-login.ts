import { loginOpenAICodex, type OAuthCredentials } from '@clothos/agent-runtime';
import { loadCredentials, saveCredentials, getOAuthProviderForName } from './oauth-manager.js';

/**
 * Run the interactive OAuth login flow for the given provider.
 * Opens a browser for authorization and saves credentials to auth.json.
 */
export async function runLogin(
  providerName: string,
  basePath: string,
): Promise<void> {
  const provider = getOAuthProviderForName(providerName);
  if (!provider) {
    console.error(`OAuth login is not supported for provider "${providerName}".`);
    console.error('Supported providers: openai, openai-codex');
    process.exit(1);
  }

  console.log(`\nLogging in to ${provider.name}...\n`);

  const credentials: OAuthCredentials = await provider.login({
    onAuth: (info) => {
      console.log('Open this URL in your browser:');
      console.log(`  ${info.url}\n`);
      if (info.instructions) {
        console.log(info.instructions);
      }
    },
    onPrompt: async (prompt) => {
      // Fallback: ask user to paste the code manually
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return new Promise<string>((resolve) => {
        rl.question(`${prompt.message}: `, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
    onProgress: (message) => {
      console.log(`  ${message}`);
    },
  });

  // Save credentials
  const stored = await loadCredentials(basePath);
  stored[provider.id] = credentials;
  await saveCredentials(basePath, stored);

  console.log('\nLogin successful! Credentials saved.');
}
