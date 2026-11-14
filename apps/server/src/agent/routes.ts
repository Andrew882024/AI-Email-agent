import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RequestAccount } from '../auth/routes.js';
import { HttpError } from '../shared/http.js';
import type { Logger } from '../shared/logging/system-logger.js';
import type { AgentEvent, ChatAgent } from './agent.js';
import { type ChatFileStore, UnsupportedFileError } from './files.js';
import type { MemoryService } from './memory.js';
import type { ChatRepository } from './repositories.js';

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

export interface AgentRouteDeps {
  access: RequestAccount;
  chats: ChatRepository;
  /** The assistant; absent when no LLM is configured. */
  chat?: { agent: ChatAgent; files: ChatFileStore; memory: MemoryService };
  logger: Logger;
}

/** Chat sessions, assistant turns (streamed as SSE), approvals, uploads and long-term memory. */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { access, chats } = deps;

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
    const account = await access.requireAccount(req);
    return chats.listSessions(account.id);
  });

  app.post('/api/chat/sessions', async (req) => {
    const account = await access.requireAccount(req);
    requireChat();
    return chats.createSession(account.id);
  });

  async function ownSession(req: FastifyRequest, id: string) {
    const account = await access.requireAccount(req);
    const session = await chats.getSession(id);
    if (!session || session.accountId !== account.id)
      throw new HttpError(404, 'not_found', 'Chat not found');
    return { account, session };
  }

  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req, req.params.id);
    const [messages, awaiting] = await Promise.all([
      chats.listMessages(session.id),
      chats.awaitingToolRuns(session.id),
    ]);
    return { session, messages, awaiting };
  });

  app.patch<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req, req.params.id);
    const { title } = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body);
    await chats.updateSession(session.id, { title });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const { session } = await ownSession(req, req.params.id);
    await chats.deleteSession(session.id);
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
    const account = await access.requireAccount(req);
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
    const account = await access.requireAccount(req);
    return requireChat().memory.list(account.id);
  });

  app.patch<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const account = await access.requireAccount(req);
    const { content } = z.object({ content: z.string().trim().min(1).max(500) }).parse(req.body);
    const item = await requireChat().memory.update(account.id, req.params.id, content);
    if (!item) throw new HttpError(404, 'not_found', 'Memory not found');
    return item;
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const account = await access.requireAccount(req);
    if (!(await requireChat().memory.remove(account.id, req.params.id)))
      throw new HttpError(404, 'not_found', 'Memory not found');
    return { ok: true };
  });
}
