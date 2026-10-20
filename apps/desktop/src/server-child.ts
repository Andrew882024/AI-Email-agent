// Runs in an Electron utility process: the API server, isolated from the window.
import { AesGcmSecretCipher, ConfigError, parseConfig } from '@ai-email/core';
import { type RunningServer, StartupError, startServer } from '@ai-email/server';
import type { FromServer, ToServer } from './protocol';

const parent = process.parentPort;
const post = (message: FromServer) => parent.postMessage(message);
let server: RunningServer | undefined;

parent.on('message', (event) => {
  const message = event.data as ToServer;
  if (message.type === 'start') void start(message);
  if (message.type === 'stop') void stop();
});

async function start(message: Extract<ToServer, { type: 'start' }>): Promise<void> {
  try {
    const config = parseConfig(message.env);
    server = await startServer(
      config,
      {
        // The main process owns the system browser; ask it to open the consent page.
        openExternal: async (url) => post({ type: 'open-external', url }),
        cipher: new AesGcmSecretCipher(message.secretKey),
      },
      { port: message.port, webRoot: message.webRoot },
    );
    post({ type: 'ready', port: server.port });
  } catch (err) {
    post({
      type: 'startup-error',
      reason:
        err instanceof StartupError
          ? err.reason
          : err instanceof ConfigError
            ? 'config'
            : 'unknown',
      message: err instanceof Error ? err.message : String(err),
      hint: err instanceof StartupError ? err.hint : undefined,
    });
  }
}

async function stop(): Promise<void> {
  try {
    await server?.close();
  } finally {
    post({ type: 'stopped' });
    process.exit(0);
  }
}
