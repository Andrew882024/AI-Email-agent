// Usage: auth [status|logout]   (default: status). Sign in through the app in the browser.
import { AesGcmSecretCipher } from '../core/auth/secret-cipher.js';
import { AUTH_CALLBACK_PATH, GoogleOAuthService } from '../core/auth/google-auth.js';
import { EncryptedTokenStore } from '../core/auth/token-store.js';
import { loadConfig } from '../core/config/env.js';
import { createDb } from '../core/db/connection.js';
import { createPgRepositories } from '../core/db/pg/index.js';

const command = process.argv[2] ?? 'status';
if (!['status', 'logout'].includes(command)) {
  console.error(`Unknown command "${command}". Use: status | logout (sign in through the app)`);
  process.exit(1);
}

const config = loadConfig();
if (!config.appSecretKey) {
  console.error(
    '✗ APP_SECRET_KEY is required to store Google tokens.\n' +
      '  Generate one with `openssl rand -base64 32` and add it to .env.',
  );
  process.exit(1);
}
const db = createDb(config.databaseUrl, { maxConnections: 2 });
const repos = createPgRepositories(db);
const auth = new GoogleOAuthService({
  clientId: config.google.clientId,
  clientSecret: config.google.clientSecret,
  redirectUri: `${config.appUrl}${AUTH_CALLBACK_PATH}`,
  accounts: repos.accounts,
  tokens: new EncryptedTokenStore(repos.oauthTokens, new AesGcmSecretCipher(config.appSecretKey)),
});

try {
  const accounts = await repos.accounts.list();
  if (accounts.length === 0) console.log('No accounts. Sign in through the app.');
  for (const account of accounts) {
    if (command === 'logout') {
      await auth.revoke(account.id);
      console.log(`✓ Signed out ${account.email}`);
      continue;
    }
    try {
      const client = await auth.getClient(account.id);
      const { scopes } = await client.getTokenInfo((await client.getAccessToken()).token!);
      console.log(`✓ ${account.email}: connected (token refreshed OK)`);
      for (const scope of scopes) console.log(`    ${scope}`);
    } catch (err) {
      console.log(`✗ ${account.email}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
