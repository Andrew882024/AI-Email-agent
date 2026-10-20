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
  /** Embedding model of the semantic index, if indexing is on. */
  indexModel?: string;
  /** The assistant; absent when no LLM is configured. */
  chat?: { agent: ChatAgent; files: ChatFileStore; memory: MemoryService };
}

export interface ServerOptions {
  /** Browser origins (besides the server's own) allowed to call the API, e.g. the Vite dev server. */
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
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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

  app.get('/api/index/status', async () => {
    const account = await requireAccount();
    if (!deps.indexModel) return { enabled: false };
    return {
      enabled: true,
      model: deps.indexModel,
      ...(await repos.vectors.stats(account.id, deps.indexModel)),
    };
  });

  app.post('/api/sync/now', async () => {
    scheduler.syncNow();
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

  app.get('/api/chat/sessions', async () => {
    const account = await requireAccount();
    return repos.chats.listSessions(account.id);
  });

  app.post('/api/chat/sessions', async () => {
    const account = await requireAccount();
    requireChat();
    return repos.chats.createSession(account.id);
  });

  async function ownSession(id: string) {
    const account = await requireAccount();
    const session = await repos.chats.getSession(id);
    if (!session || session.accountId !== account.id)
      throw new HttpError(404, 'not_found', 'Chat not found');
    return { account, session };
  }

  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req.params.id);
    const [messages, awaiting] = await Promise.all([
      repos.chats.listMessages(session.id),
      repos.chats.awaitingToolRuns(session.id),
    ]);
    return { session, messages, awaiting };
  });

  app.patch<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req.params.id);
    const { title } = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body);
    await repos.chats.updateSession(session.id, { title });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req.params.id);
    await repos.chats.deleteSession(session.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/chat/sessions/:id/messages', async (req, reply) => {
    const chat = requireChat();
    const { account, session } = await ownSession(req.params.id);
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
      const { account, session } = await ownSession(req.params.id);
      const { approve } = approvalBody.parse(req.body ?? {});
      await streamAgent(req, reply, (emit, signal) =>
        chat.agent.resolve(account.id, session.id, req.params.runId, approve, emit, signal),
      );
    },
  );

  app.post('/api/chat/files', async (req) => {
    const chat = requireChat();
    const account = await requireAccount();
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

  app.get('/api/memory', async () => {
    const account = await requireAccount();
    return requireChat().memory.list(account.id);
  });

  app.patch<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const account = await requireAccount();
    const { content } = z.object({ content: z.string().trim().min(1).max(500) }).parse(req.body);
    const item = await requireChat().memory.update(account.id, req.params.id, content);
    if (!item) throw new HttpError(404, 'not_found', 'Memory not found');
    return item;
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const account = await requireAccount();
    if (!(await requireChat().memory.remove(account.id, req.params.id)))
      throw new HttpError(404, 'not_found', 'Memory not found');
    return { ok: true };
  });

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
