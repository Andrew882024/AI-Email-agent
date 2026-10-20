import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  type Account,
  type Actor,
  type AppEventName,
  AuthFlowError,
  type EventBus,
  type GoogleAuthProvider,
  type Logger,
  type Repositories,
  type SyncScheduler,
  ToolError,
  type ToolErrorCode,
  type ToolRegistry,
} from '@ai-email/core';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

export interface ServerDeps {
  repos: Repositories;
  auth: GoogleAuthProvider;
  tools: ToolRegistry;
  events: EventBus;
  scheduler: Pick<SyncScheduler, 'syncNow'>;
  logger: Logger;
}

export interface ServerOptions {
  /** Browser origins (besides the server's own) allowed to call the API, e.g. the Vite dev server. */
  allowedOrigins: string[];
  /** SSE keep-alive interval. */
  heartbeatMs?: number;
  /** Directory of the built web app to serve at / (the desktop app loads it from here). */
  webRoot?: string;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<ToolErrorCode, number> = {
  unknown_tool: 404,
  invalid_input: 400,
  not_found: 404,
  reauth_required: 401,
  internal: 500,
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Attachment types safe to show inline; anything else (HTML, SVG, ...) is forced to download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

const SSE_EVENTS: AppEventName[] = [
  'message.added',
  'message.updated',
  'message.deleted',
  'labels.changed',
  'todos.changed',
  'sync.status',
  'outbox.failed',
];

const listQuery = z.object({
  view: z.string().optional(),
  label: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().optional(),
  cursor: z.string().optional(),
});
const logQuery = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  status: z.enum(['success', 'error']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

function hostnameOf(hostHeader: string | undefined): string {
  return (hostHeader ?? '').replace(/:\d+$/, '').toLowerCase();
}

/**
 * The HTTP API the UI talks to. It can send mail, so it only answers local, trusted callers:
 * Host must be a loopback name (defeats DNS rebinding), browser Origins must be the server itself
 * or allow-listed, and bodies must be JSON (no cross-site "simple" form posts).
 */
export async function buildServer(
  deps: ServerDeps,
  options: ServerOptions,
): Promise<FastifyInstance> {
  const { repos, auth, tools, events, scheduler } = deps;
  // pino's Logger satisfies Fastify's logger contract; typed as the base so the instance type stays default.
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    disableRequestLogging: true,
    // Tool calls may carry base64 attachments (send_email allows 18 MB of files).
    bodyLimit: 32 * 1024 * 1024,
  });
  app.removeContentTypeParser('text/plain');

  const allowedOrigin = (origin: string, hostHeader: string | undefined) => {
    if (options.allowedOrigins.includes(origin)) return true;
    try {
      const url = new URL(origin);
      return url.host === hostHeader && LOCAL_HOSTNAMES.has(url.hostname); // same origin
    } catch {
      return false;
    }
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Host not allowed' } });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin, req.headers.host)) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Origin not allowed' } });
    }
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !!origin && options.allowedOrigins.includes(origin)),
    methods: ['GET', 'POST'],
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ToolError) {
      const status = STATUS[err.code];
      if (status >= 500) deps.logger.error({ err }, 'tool failed');
      return reply
        .code(status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply
        .code(status)
        .send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    deps.logger.error({ err }, 'request failed');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  /** Single-account app: the first (and only) account. */
  async function currentAccount(): Promise<Account | undefined> {
    return (await repos.accounts.list())[0];
  }
  async function requireAccount(): Promise<Account> {
    const account = await currentAccount();
    if (!account) throw new HttpError(401, 'not_connected', 'No Google account connected');
    return account;
  }
  async function invoke(name: string, input: unknown) {
    const account = await requireAccount();
    return tools.invoke(name, { accountId: account.id, actor: 'user' }, input);
  }

  // ---------- auth ----------
  let login: Promise<Account> | undefined;

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/auth/status', async () => {
    const account = await currentAccount();
    return {
      account: account
        ? { id: account.id, email: account.email, displayName: account.displayName }
        : null,
      connected: account ? await auth.isConnected(account.id) : false,
    };
  });

  /** Opens Google consent in the system browser and resolves once the user finishes (≤ 5 min). */
  app.post('/api/auth/login', async () => {
    if (login) throw new HttpError(409, 'login_in_progress', 'A sign-in is already in progress');
    login = auth.startAuth();
    try {
      const account = await login;
      scheduler.syncNow();
      return {
        account: { id: account.id, email: account.email, displayName: account.displayName },
      };
    } catch (err) {
      if (err instanceof AuthFlowError) throw new HttpError(400, 'auth_failed', err.message);
      throw err;
    } finally {
      login = undefined;
    }
  });

  app.post('/api/auth/logout', async () => {
    const account = await requireAccount();
    await auth.revoke(account.id);
    return { ok: true };
  });

  // ---------- tools ----------
  app.get('/api/tools', async () => tools.describe());

  app.post<{ Params: { name: string } }>('/api/tools/:name', async (req) => ({
    result: await invoke(req.params.name, req.body ?? {}),
  }));

  // ---------- REST reads (thin wrappers over the read tools) ----------
  app.get('/api/labels', async () => invoke('list_labels', {}));

  app.get('/api/messages', async (req) => {
    const q = listQuery.parse(req.query);
    const input = { view: q.view, label: q.label, limit: q.limit, cursor: q.cursor };
    return q.q ? invoke('search_emails', { ...input, query: q.q }) : invoke('list_emails', input);
  });

  app.get('/api/threads', async (req) => {
    const q = listQuery.parse(req.query);
    return invoke('list_threads', {
      view: q.view,
      label: q.label,
      query: q.q,
      limit: q.limit,
      cursor: q.cursor,
    });
  });

  app.get<{ Params: { id: string } }>('/api/messages/:id', async (req) =>
    invoke('get_email', { messageId: req.params.id, includeHtml: true }),
  );

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req) =>
    invoke('get_thread', { threadId: req.params.id, includeHtml: true }),
  );

  app.get<{ Params: { id: string; partId: string } }>(
    '/api/messages/:id/attachments/:partId',
    async (req, reply) => {
      const file = (await invoke('get_attachment', {
        messageId: req.params.id,
        partId: req.params.partId,
      })) as {
        filename: string;
        mimeType: string;
        contentBase64: string;
      };
      const inline = INLINE_TYPES.has(file.mimeType.toLowerCase());
      return reply
        .header('content-type', inline ? file.mimeType : 'application/octet-stream')
        .header(
          'content-disposition',
          `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        )
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', 'sandbox')
        .send(Buffer.from(file.contentBase64, 'base64'));
    },
  );

  app.get<{ Querystring: { status?: string } }>('/api/todos', async (req) =>
    invoke('list_todos', req.query.status ? { status: req.query.status } : {}),
  );

  // ---------- logs & sync ----------
  app.get('/api/logs', async (req) => {
    const q = logQuery.parse(req.query);
    return repos.actionLogs.query({ ...q, actor: q.actor as Actor | undefined });
  });

  app.get('/api/sync/status', async () => {
    const account = await requireAccount();
    const [state, pending] = await Promise.all([
      repos.syncState.get(account.id),
      repos.outbox.listActive(account.id),
    ]);
    return {
      historyId: account.historyId,
      lastFullSyncAt: account.lastFullSyncAt,
      fullSync: state.fullSync,
      outboxPending: pending.length,
    };
  });

  app.post('/api/sync/now', async () => {
    scheduler.syncNow();
    return { ok: true };
  });

  // ---------- web app ----------
  if (options.webRoot) {
    await app.register(fastifyStatic, { root: options.webRoot, wildcard: false });
    // Client-side routes fall back to index.html; unknown API paths stay JSON 404s.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
    });
  }

  // ---------- server-sent events ----------
  app.get('/api/events', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // keeps CORS headers set by the plugin
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribers = SSE_EVENTS.map((event) =>
      events.on(event, (payload) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }),
    );
    const heartbeat = setInterval(
      () => reply.raw.write(': ping\n\n'),
      options.heartbeatMs ?? 25_000,
    );
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribers.forEach((off) => off());
    });
  });

  return app;
}
