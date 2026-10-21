import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthFlowError } from './errors.js';

const CALLBACK_PATH = '/oauth2callback';

export interface LoopbackReceiver {
  /** Register this as the OAuth redirect_uri. */
  redirectUri: string;
  /** Resolves with the authorization code once the browser hits the redirect URI. */
  waitForCode(options: { timeoutMs: number; signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">
<h2>${title}</h2><p>${body}</p></body>`;
}

/**
 * Loopback redirect receiver for the desktop OAuth flow (RFC 8252): a one-shot HTTP server on
 * 127.0.0.1 with an OS-assigned port. Requests whose `state` doesn't match are rejected and ignored,
 * so a stray or forged request can't complete or cancel the flow.
 */
export async function startLoopbackReceiver(expectedState: string): Promise<LoopbackReceiver> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  code.catch(() => {}); // Rejections are surfaced through waitForCode.

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    const html = { 'content-type': 'text/html; charset=utf-8', connection: 'close' };
    if (params.get('state') !== expectedState) {
      res.writeHead(400, html).end(page('Invalid request', 'Please retry sign-in from the app.'));
      return;
    }
    const error = params.get('error');
    const authCode = params.get('code');
    if (error || !authCode) {
      res.writeHead(200, html).end(page('Sign-in cancelled', 'You can close this window.'));
      rejectCode(new AuthFlowError(`Google sign-in was not completed: ${error ?? 'no code'}`));
      return;
    }
    res
      .writeHead(200, html)
      .end(page('Signed in', 'You can close this window and return to the app.'));
    resolveCode(authCode);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    waitForCode({ timeoutMs, signal }) {
      return new Promise<string>((resolve, reject) => {
        const fail = (err: Error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        };
        const onAbort = () => fail(new AuthFlowError('Google sign-in was cancelled'));
        const timer = setTimeout(
          () => fail(new AuthFlowError('Google sign-in timed out')),
          timeoutMs,
        );
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        code.then(
          (value) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (err: Error) => fail(err),
        );
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
