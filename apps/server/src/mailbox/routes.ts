import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RequestAccount } from '../auth/index.js';
import type { ToolRegistry } from '../shared/tool-registry.js';
import type { VectorStore } from './repositories.js';

/** Attachment types safe to show inline; anything else (HTML, SVG, ...) is forced to download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

const listQuery = z.object({
  view: z.string().optional(),
  label: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().optional(),
  cursor: z.string().optional(),
});

export interface MailboxRouteDeps {
  tools: ToolRegistry;
  access: RequestAccount;
  vectors: VectorStore;
  /** Embedding model of the semantic index, if indexing is on. */
  indexModel?: string;
}

/** The tool endpoint and the REST reads of mail, labels and todos (thin wrappers over the tools). */
export function registerMailboxRoutes(app: FastifyInstance, deps: MailboxRouteDeps): void {
  const { tools, access } = deps;

  async function invoke(req: FastifyRequest, name: string, input: unknown) {
    const account = await access.requireAccount(req);
    return tools.invoke(name, { accountId: account.id, actor: 'user' }, input);
  }

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

  app.get('/api/index/status', async (req) => {
    const account = await access.requireAccount(req);
    if (!deps.indexModel) return { enabled: false };
    return {
      enabled: true,
      model: deps.indexModel,
      ...(await deps.vectors.stats(account.id, deps.indexModel)),
    };
  });
}
