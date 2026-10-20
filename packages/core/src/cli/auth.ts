// Usage: auth [login|status|logout]   (default: status)
import { AesGcmSecretCipher } from '../auth/secret-cipher.js';
import { GoogleOAuthService } from '../auth/google-auth.js';
import { openInSystemBrowser } from '../auth/open-external.js';
import { EncryptedTokenStore } from '../auth/token-store.js';
import { loadConfig } from '../config/env.js';
import { createDb } from '../db/connection.js';
import { createPgRepositories } from '../db/pg/index.js';

const command = process.argv[2] ?? 'status';
if (!['login', 'status', 'logout'].includes(command)) {
  console.error(`Unknown command "${command}". Use: login | status | logout`);
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
  accounts: repos.accounts,
  tokens: new EncryptedTokenStore(repos.oauthTokens, new AesGcmSecretCipher(config.appSecretKey)),
  openExternal: async (url) => {
    console.log(`Opening your browser for Google sign-in. If it doesn't open, visit:\n${url}\n`);
    await openInSystemBrowser(url);
  },
});

try {
  if (command === 'login') {
    const account = await auth.startAuth();
    console.log(`✓ Signed in as ${account.email}`);
  } else {
    const accounts = await repos.accounts.list();
    if (accounts.length === 0) console.log('No accounts. Run `pnpm auth login`.');
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
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
