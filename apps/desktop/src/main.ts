// Electron main process: owns the window, the keychain and the system browser. The API server runs
// in a separate utility process (crash-isolated, restarted automatically) and serves the UI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { buildServerEnv, type EmbeddedConfig, USER_CONFIG_FILE } from './config';
import { allowNavigation, classifyOpen } from './navigation';
import { statusPageUrl } from './pages';
import type { FromServer, ToServer } from './protocol';
import { loadOrCreateKey } from './secret-key';

declare const __EMBEDDED_CONFIG__: EmbeddedConfig;

/** Set to load the Vite dev server instead of the bundled UI (the API then uses port 4317). */
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const RETRY_MS = 3000;

let win: BrowserWindow | undefined;
let server: UtilityProcess | undefined;
let appOrigin: string | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let quitting = false;

function showStatus(page: Parameters<typeof statusPageUrl>[0]): void {
  appOrigin = undefined;
  void win?.loadURL(statusPageUrl(page));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'AI Email Agent',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win?.show());
  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    const action = classifyOpen(url, appOrigin);
    if (action.kind === 'download') webContents.downloadURL(action.url);
    if (action.kind === 'external') void shell.openExternal(action.url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (allowNavigation(url, appOrigin)) return;
    event.preventDefault();
    const action = classifyOpen(url, appOrigin);
    if (action.kind === 'external') void shell.openExternal(action.url);
  });
  win.on('closed', () => (win = undefined));
  showStatus({ title: 'Starting…', message: 'Connecting to your mailbox.', busy: true });
}

function serverEnvAndKey() {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, USER_CONFIG_FILE);
  const { env, importKey } = buildServerEnv({
    embedded: __EMBEDDED_CONFIG__,
    userConfigText: existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined,
    dataDir,
  });
  const keyPath = join(dataDir, 'token-key.bin');
  const { key, source } = loadOrCreateKey(
    {
      read: () => (existsSync(keyPath) ? readFileSync(keyPath) : undefined),
      write: (data) => writeFileSync(keyPath, data, { mode: 0o600 }),
    },
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    },
    importKey,
  );
  if (source !== 'keychain') console.log(`Token key ${source} and stored in the keychain`);
  return { env, key, configPath };
}

function scheduleRestart(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(startServerProcess, RETRY_MS);
}

function startServerProcess(): void {
  if (quitting) return;
  let setup;
  try {
    setup = serverEnvAndKey();
  } catch (err) {
    showStatus({
      title: 'Cannot start',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const child = utilityProcess.fork(join(__dirname, 'server-child.mjs'), [], {
    serviceName: 'AI Email Agent Server',
    stdio: 'inherit',
  });
  server = child;

  child.on('message', (message: FromServer) => {
    switch (message.type) {
      case 'ready': {
        appOrigin = devServerUrl
          ? new URL(devServerUrl).origin
          : `http://127.0.0.1:${message.port}`;
        void win?.loadURL(devServerUrl ?? `${appOrigin}/`);
        break;
      }
      case 'startup-error': {
        if (message.reason === 'database') {
          showStatus({
            title: 'Waiting for the database…',
            message: 'Start Docker Desktop and the app database; this page retries automatically.',
            detail: `${message.message}\n\nIn the project folder:  pnpm db:up`,
            busy: true,
          });
        } else {
          showStatus({
            title: message.reason === 'config' ? 'Configuration problem' : 'Something went wrong',
            message: `Fix it in ${setup.configPath}, then the app retries automatically.`,
            detail: message.message,
          });
        }
        child.kill();
        break;
      }
      case 'open-external': {
        if (/^https?:\/\//.test(message.url)) void shell.openExternal(message.url);
        break;
      }
    }
  });

  child.on('exit', (code) => {
    if (server === child) server = undefined;
    if (quitting) return;
    if (code !== 0 && appOrigin) {
      showStatus({
        title: 'Restarting…',
        message: 'The mail service stopped unexpectedly and is restarting.',
        busy: true,
      });
    }
    scheduleRestart();
  });

  const start: ToServer = {
    type: 'start',
    env: setup.env,
    secretKey: setup.key,
    port: devServerUrl ? 4317 : 0,
    webRoot: join(__dirname, '..', 'web'),
  };
  child.postMessage(start);
}

/** Let the server finish in-flight work (sync, outbox) before quitting. */
async function stopServer(): Promise<void> {
  const child = server;
  if (!child) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: 'stop' } satisfies ToServer);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  void app.whenReady().then(() => {
    createWindow();
    startServerProcess();
    app.on('activate', () => {
      if (!win) {
        createWindow();
        if (appOrigin) void win!.loadURL(devServerUrl ?? `${appOrigin}/`);
      }
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    clearTimeout(retryTimer);
    event.preventDefault();
    void stopServer().finally(() => app.quit());
  });
}
