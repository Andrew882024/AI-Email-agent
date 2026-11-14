import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  type AgentEvent,
  type ChatAgent,
  type ChatFileStore,
  type MemoryService,
  UnsupportedFileError,
  type Actor,
  type AppEventName,
  type EventBus,
  type GoogleAuthProvider,
  type Logger,
  type Repositories,
  type SecretCipher,
  type SyncScheduler,
  ToolError,
  type ToolErrorCode,
  type ToolRegistry,
} from './core/index.js';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { registerAuthRoutes, requestAccount } from './auth/routes.js';
import { Sessions } from './auth/sessions.js';
import { registerMailboxRoutes } from './mailbox/routes.js';
import { registerSyncRoutes } from './sync/routes.js';
import { HttpError } from './shared/http.js';

export interface ServerDeps {
  repos: Repositories;
  auth: GoogleAuthProvider;
  /** Seals the short-lived sign-in cookie (OAuth state and PKCE verifier). */
  cipher: SecretCipher;
  tools: ToolRegistry;
  events: EventBus;
  scheduler: Pick<SyncScheduler, 'syncNow' | 'addAccount' | 'removeAccount'>;
  logger: Logger;
  /** Embedding model of the semantic index, if indexing is on. */
  indexModel?: string;
  /** The assistant; absent when no LLM is configured. */
  chat?: { agent: ChatAgent; files: ChatFileStore; memory: MemoryService };
}

export interface ServerOptions {
  /** Where users open the app (e.g. http://localhost:5173); its host and origin are allowed. */
  appUrl: string;
  /** Other browser origins allowed to call the API, e.g. the Vite dev server. */
  allowedOrigins: string[];
  /** SSE keep-alive interval. */
  heartbeatMs?: number;
  /** Directory of the built web app to serve at / (production). */
  webRoot?: string;
}

const STATUS: Record<ToolErrorCode, number> = {
  unknown_tool: 404,
  invalid_input: 400,
  not_found: 404,
  reauth_required: 401,
  internal: 500,
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const SSE_EVENTS: AppEventName[] = [
  'message.added',
  'message.updated',
  'message.deleted',
  'labels.changed',
  'todos.changed',
  'sync.status',
  'outbox.failed',
  'index.status',
  'workflow.updated',
];

const chatMessageBody = z.object({
  text: z.string().max(20_000).default(''),
  fileIds: z.array(z.string()).max(10).default([]),
});
const approvalBody = z.object({ approve: z.boolean() });
const uploadBody = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(255).default('application/octet-stream'),
  contentBase64: z.string().min(1),
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
 * The HTTP API the UI talks to. Each request acts as the account of its session cookie. It can
 * send mail, so it only answers trusted callers: Host must be a loopback name or the app's own
 * (defeats DNS rebinding), browser Origins must be the app or allow-listed (with SameSite cookies,
 * defeats CSRF), and bodies must be JSON (no cross-site "simple" form posts).
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

  const appUrl = new URL(options.appUrl);
  const allowedHosts = new Set([...LOCAL_HOSTNAMES, appUrl.hostname]);
  const allowedOrigins = [appUrl.origin, ...options.allowedOrigins];
  const allowedOrigin = (origin: string, hostHeader: string | undefined) => {
    if (allowedOrigins.includes(origin)) return true;
    try {
      const url = new URL(origin);
      return url.host === hostHeader && allowedHosts.has(url.hostname); // same origin
    } catch {
      return false;
    }
  };
  const sessions = new Sessions(repos.sessions, appUrl.protocol === 'https:');
  const access = requestAccount(sessions, repos.accounts);
  const { requireAccount } = access;

  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(hostnameOf(req.headers.host))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Host not allowed' } });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin, req.headers.host)) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Origin not allowed' } });
    }
  });
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !!origin && allowedOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  });
  app.addHook('onRequest', access.hook);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ToolError) {
      const status = STATUS[err.code];
      if (status >= 500) deps.logger.error({ err }, 'tool failed');
      return reply
        .code(status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_input', message: z.prettifyError(err) } });
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

  // ---------- auth ----------
  app.get('/api/health', async () => ({ ok: true }));

  registerAuthRoutes(app, {
    auth,
    cipher: deps.cipher,
    sessions,
    accounts: repos.accounts,
    access,
    appUrl,
    logger: deps.logger,
    onSignedIn: (accountId) => scheduler.addAccount(accountId),
    beforeAccountDelete: async (accountId) => {
      await scheduler.removeAccount(accountId);
      await deps.chat?.files.deleteForAccount(accountId);
      await repos.actionLogs.deleteForAccount(accountId);
    },
  });

  registerMailboxRoutes(app, {
    tools,
    access,
    vectors: repos.vectors,
    indexModel: deps.indexModel,
  });

  // ---------- logs & sync ----------
  app.get('/api/logs', async (req) => {
    const account = await requireAccount(req);
    const q = logQuery.parse(req.query);
    return repos.actionLogs.query({
      ...q,
      accountId: account.id,
      actor: q.actor as Actor | undefined,
    });
  });

  registerSyncRoutes(app, {
    access,
    syncState: repos.syncState,
    outbox: repos.outbox,
    scheduler,
  });

  // ---------- assistant ----------
  function requireChat() {
    if (!deps.chat) {
      throw new HttpError(
        503,
        'assistant_unavailable',
        'The assistant needs GEMINI_API_KEY in the configuration',
      );
    }
    return deps.chat;
  }

  /**
   * Run an agent turn and stream its events as SSE (`data: <json>` per event). Errors before the
   * first event are ordinary JSON errors; later ones become an `error` event. Closing the
   * connection aborts the model request.
   */
  async function streamAgent(
    req: FastifyRequest,
    reply: FastifyReply,
    run: (emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>,
  ) {
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded)
        deps.logger.info({ url: req.url }, 'client disconnected during an assistant turn');
      abort.abort();
    });
    let started = false;
    const write = (event: AgentEvent) => {
      if (reply.raw.writableEnded) return;
      if (!started) {
        started = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
      }
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') reply.raw.end();
    };
    try {
      await run(write, abort.signal);
    } catch (err) {
      if (!started) throw err;
      deps.logger.error({ err }, 'assistant turn failed');
      write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    if (started && !reply.raw.writableEnded) reply.raw.end();
  }

  app.get('/api/chat/sessions', async (req) => {
    const account = await requireAccount(req);
    return repos.chats.listSessions(account.id);
  });

  app.post('/api/chat/sessions', async (req) => {
    const account = await requireAccount(req);
    requireChat();
    return repos.chats.createSession(account.id);
  });

  async function ownSession(req: FastifyRequest, id: string) {
    const account = await requireAccount(req);
    const session = await repos.chats.getSession(id);
    if (!session || session.accountId !== account.id)
      throw new HttpError(404, 'not_found', 'Chat not found');
    return { account, session };
  }

  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req, req.params.id);
    const [messages, awaiting] = await Promise.all([
      repos.chats.listMessages(session.id),
      repos.chats.awaitingToolRuns(session.id),
    ]);
    return { session, messages, awaiting };
  });

  app.patch<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req, req.params.id);
    const { title } = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body);
    await repos.chats.updateSession(session.id, { title });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req, req.params.id);
    await repos.chats.deleteSession(session.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/chat/sessions/:id/messages', async (req, reply) => {
    const chat = requireChat();
    const { account, session } = await ownSession(req, req.params.id);
    const body = chatMessageBody.parse(req.body ?? {});
    await streamAgent(req, reply, (emit, signal) =>
      chat.agent.send(
        account.id,
        session.id,
        { text: body.text, fileIds: body.fileIds },
        emit,
        signal,
      ),
    );
  });

  app.post<{ Params: { id: string; runId: string } }>(
    '/api/chat/sessions/:id/actions/:runId',
    async (req, reply) => {
      const chat = requireChat();
      const { account, session } = await ownSession(req, req.params.id);
      const { approve } = approvalBody.parse(req.body ?? {});
      await streamAgent(req, reply, (emit, signal) =>
        chat.agent.resolve(account.id, session.id, req.params.runId, approve, emit, signal),
      );
    },
  );

  app.post('/api/chat/files', async (req) => {
    const chat = requireChat();
    const account = await requireAccount(req);
    const upload = uploadBody.parse(req.body);
    try {
      const file = await chat.files.save(account.id, {
        filename: upload.filename,
        mimeType: upload.mimeType,
        data: Buffer.from(upload.contentBase64, 'base64'),
      });
      return { id: file.id, filename: file.filename, mimeType: file.mimeType, size: file.size };
    } catch (err) {
      if (err instanceof UnsupportedFileError)
        throw new HttpError(400, 'unsupported_file', err.message);
      throw err;
    }
  });

  app.get('/api/memory', async (req) => {
    const account = await requireAccount(req);
    return requireChat().memory.list(account.id);
  });

  app.patch<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const account = await requireAccount(req);
    const { content } = z.object({ content: z.string().trim().min(1).max(500) }).parse(req.body);
    const item = await requireChat().memory.update(account.id, req.params.id, content);
    if (!item) throw new HttpError(404, 'not_found', 'Memory not found');
    return item;
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const account = await requireAccount(req);
    if (!(await requireChat().memory.remove(account.id, req.params.id)))
      throw new HttpError(404, 'not_found', 'Memory not found');
    return { ok: true };
  });

  // ---------- web app ----------
  if (options.webRoot) {
    await app.register(fastifyStatic, { root: options.webRoot, wildcard: false });
    // Client-side routes (/mail, /login) fall back to index.html; unknown API paths stay JSON 404s.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
    });
  }

  // ---------- server-sent events ----------
  // One subscription per event for the whole server; each event goes to its account's streams.
  const streams = new Map<string, Set<(event: AppEventName, payload: unknown) => void>>();
  const unsubscribers = SSE_EVENTS.map((event) =>
    events.on(event, (payload) => {
      for (const send of streams.get(payload.accountId) ?? []) send(event, payload);
    }),
  );
  app.addHook('onClose', async () => unsubscribers.forEach((off) => off()));

  app.get('/api/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const account = await requireAccount(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // keeps CORS headers set by the plugin
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const send = (event: AppEventName, payload: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    const mine = streams.get(account.id) ?? new Set();
    streams.set(account.id, mine.add(send));
    const heartbeat = setInterval(
      () => reply.raw.write(': ping\n\n'),
      options.heartbeatMs ?? 25_000,
    );
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      mine.delete(send);
      if (mine.size === 0) streams.delete(account.id);
    });
  });

  return app;
}
