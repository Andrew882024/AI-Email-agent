import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import {
  type Account,
  type AgentEvent,
  type ChatAgent,
  type ChatFileStore,
  type MemoryService,
  UnsupportedFileError,
  type Actor,
  type AppEventName,
  AuthFlowError,
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
import { SESSION_COOKIE, Sessions } from './session.js';

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
/** Holds the OAuth state and PKCE verifier between leaving for Google and coming back. */
const SIGN_IN_COOKIE = 'sign_in';
const SIGN_IN_MS = 10 * 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in account of this request's session, if any. */
    accountId?: string;
  }
}

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
  'index.status',
  'workflow.updated',
];

const listQuery = z.object({
  view: z.string().optional(),
  label: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().optional(),
  cursor: z.string().optional(),
});
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
  app.addHook('onRequest', async (req, reply) => {
    req.accountId = await sessions.accountOf(req, reply);
  });

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

  /** The account this request's browser is signed in as. */
  async function currentAccount(req: FastifyRequest): Promise<Account | undefined> {
    return req.accountId ? repos.accounts.getById(req.accountId) : undefined;
  }
  async function requireAccount(req: FastifyRequest): Promise<Account> {
    const account = await currentAccount(req);
    if (!account) throw new HttpError(401, 'not_signed_in', 'Sign in to continue');
    return account;
  }
  async function invoke(req: FastifyRequest, name: string, input: unknown) {
    const account = await requireAccount(req);
    return tools.invoke(name, { accountId: account.id, actor: 'user' }, input);
  }

  // ---------- auth ----------
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/auth/status', async (req) => {
    const account = await currentAccount(req);
    return {
      account: account
        ? { id: account.id, email: account.email, displayName: account.displayName }
        : null,
      connected: account ? await auth.isConnected(account.id) : false,
    };
  });

  const signInCookie = { path: '/api/auth', httpOnly: true, sameSite: 'lax' as const };
  const signInState = z.object({ state: z.string(), codeVerifier: z.string() });

  /** Sign in: off to Google, which comes back to /api/auth/callback. `?consent=1` asks for every permission again. */
  app.get<{ Querystring: { consent?: string } }>('/api/auth/google', async (req, reply) => {
    const request = await auth.beginAuth({ consent: req.query.consent === '1' });
    const sealed = await deps.cipher.encrypt(
      JSON.stringify({ state: request.state, codeVerifier: request.codeVerifier }),
    );
    reply.setCookie(SIGN_IN_COOKIE, sealed, {
      ...signInCookie,
      secure: appUrl.protocol === 'https:',
      maxAge: SIGN_IN_MS / 1000,
    });
    return reply.redirect(request.url);
  });

  /** Google sends the browser back here; on success it is signed in and lands on the mail page. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/callback',
    async (req, reply) => {
      const sealed = req.cookies[SIGN_IN_COOKIE];
      reply.clearCookie(SIGN_IN_COOKIE, { path: signInCookie.path });
      const fail = (message: string) =>
        reply.redirect(`/login#error=${encodeURIComponent(message)}`);
      if (req.query.error)
        return fail(
          req.query.error === 'access_denied'
            ? 'Sign-in was cancelled.'
            : `Google sign-in failed (${req.query.error}).`,
        );
      const saved = sealed
        ? await deps.cipher
            .decrypt(sealed)
            .then((json) => signInState.parse(JSON.parse(json)))
            .catch(() => undefined)
        : undefined;
      if (!saved || !req.query.code || saved.state !== req.query.state)
        return fail('That sign-in expired or was started in another tab. Try again.');

      let result;
      try {
        result = await auth.finishAuth({ code: req.query.code, codeVerifier: saved.codeVerifier });
      } catch (err) {
        if (err instanceof AuthFlowError) return fail(err.message);
        deps.logger.error({ err }, 'sign-in failed');
        return fail('Sign-in failed. Try again.');
      }
      if ('consentRequired' in result) return reply.redirect('/api/auth/google?consent=1');
      await sessions.end(req, reply); // a previous account's session in this browser
      await sessions.create(reply, result.account.id);
      scheduler.addAccount(result.account.id);
      return reply.redirect('/mail');
    },
  );

  /** Sign this browser out. Background sync and workflows keep running. */
  app.post('/api/auth/logout', async (req, reply) => {
    await sessions.end(req, reply);
    return { ok: true };
  });

  /**
   * Delete the account: revoke Google access and erase everything this app keeps for it (mail
   * copy, index, chats, memory, workflows, uploads, logs). Gmail and Drive are not touched.
   */
  app.delete('/api/account', async (req, reply) => {
    const account = await requireAccount(req);
    await auth.revoke(account.id);
    await scheduler.removeAccount(account.id);
    await deps.chat?.files.deleteForAccount(account.id);
    await repos.actionLogs.deleteForAccount(account.id);
    await repos.accounts.delete(account.id); // the rest goes with it (ON DELETE CASCADE)
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------- tools ----------
  app.get('/api/tools', async () => tools.describe());

  app.post<{ Params: { name: string } }>('/api/tools/:name', async (req) => ({
    result: await invoke(req, req.params.name, req.body ?? {}),
  }));

  // ---------- REST reads (thin wrappers over the read tools) ----------
  app.get('/api/labels', async (req) => invoke(req, 'list_labels', {}));

  app.get('/api/messages', async (req) => {
    const q = listQuery.parse(req.query);
    const input = { view: q.view, label: q.label, limit: q.limit, cursor: q.cursor };
    return q.q
      ? invoke(req, 'search_emails', { ...input, query: q.q })
      : invoke(req, 'list_emails', input);
  });

  app.get('/api/threads', async (req) => {
    const q = listQuery.parse(req.query);
    return invoke(req, 'list_threads', {
      view: q.view,
      label: q.label,
      query: q.q,
      limit: q.limit,
      cursor: q.cursor,
    });
  });

  app.get<{ Params: { id: string } }>('/api/messages/:id', async (req) =>
    invoke(req, 'get_email', { messageId: req.params.id, includeHtml: true }),
  );

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req) =>
    invoke(req, 'get_thread', { threadId: req.params.id, includeHtml: true }),
  );

  app.get<{ Params: { id: string; partId: string } }>(
    '/api/messages/:id/attachments/:partId',
    async (req, reply) => {
      const file = (await invoke(req, 'get_attachment', {
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
    invoke(req, 'list_todos', req.query.status ? { status: req.query.status } : {}),
  );

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

  app.get('/api/sync/status', async (req) => {
    const account = await requireAccount(req);
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

  app.get('/api/index/status', async (req) => {
    const account = await requireAccount(req);
    if (!deps.indexModel) return { enabled: false };
    return {
      enabled: true,
      model: deps.indexModel,
      ...(await repos.vectors.stats(account.id, deps.indexModel)),
    };
  });

  app.post('/api/sync/now', async (req) => {
    scheduler.syncNow((await requireAccount(req)).id);
    return { ok: true };
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
