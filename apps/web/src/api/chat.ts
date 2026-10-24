import { z } from 'zod';
import { ApiError, ensureOk, IsoDate, Ok, optional, readBase64, request, validate } from './client';

// ---- shapes ----

const Args = z.record(z.string(), z.unknown());

export const StoredPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('file_ref'),
    fileId: z.string(),
    name: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    id: optional(z.string()),
    name: z.string(),
    args: Args,
  }),
  z.object({
    type: z.literal('tool_result'),
    id: optional(z.string()),
    name: z.string(),
    result: z.unknown(),
    isError: optional(z.boolean()),
  }),
]);
export type StoredPart = z.output<typeof StoredPart>;

export const ChatSession = z.object({ id: z.string(), title: z.string(), updatedAt: IsoDate });
export type ChatSession = z.output<typeof ChatSession>;

export const ChatMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'model']),
  parts: z.array(StoredPart),
});
export type ChatMessage = z.output<typeof ChatMessage>;

export const ToolRun = z.object({
  id: z.string(),
  tool: z.string(),
  input: Args,
  status: z.enum(['awaiting_approval', 'done', 'error', 'rejected']),
  /** For waiting runs: { description } of the approval request. */
  result: z.unknown(),
});
export type ToolRun = z.output<typeof ToolRun>;

export const ChatSessionDetail = z.object({
  session: ChatSession,
  messages: z.array(ChatMessage),
  awaiting: z.array(ToolRun),
});
export type ChatSessionDetail = z.output<typeof ChatSessionDetail>;

export const EmailDraft = z.object({
  mode: z.enum(['new', 'reply', 'replyAll', 'forward']),
  sourceMessageId: optional(z.string()),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  replyPreview: optional(z.string()),
});
export type EmailDraft = z.output<typeof EmailDraft>;

/** What the assistant streams back during a turn. */
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), runId: z.string(), name: z.string(), args: Args }),
  z.object({
    type: z.literal('tool_result'),
    runId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('approval_required'),
    runId: z.string(),
    name: z.string(),
    args: Args,
    description: z.string(),
  }),
  z.object({ type: z.literal('draft'), draft: EmailDraft }),
  z.object({
    type: z.literal('done'),
    status: z.enum(['complete', 'awaiting_approval', 'step_limit']),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AgentEvent = z.output<typeof AgentEvent>;

export const ChatFile = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});
export type ChatFile = z.output<typeof ChatFile>;

// ---- requests ----

export const listChatSessions = () => request(z.array(ChatSession), '/api/chat/sessions');

export const getChatSession = (id: string) =>
  request(ChatSessionDetail, `/api/chat/sessions/${encodeURIComponent(id)}`);

export const createChatSession = () =>
  request(ChatSession, '/api/chat/sessions', { method: 'POST', body: {} });

export const deleteChatSession = (id: string) =>
  request(Ok, `/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Upload a file for the next message (sent as base64 JSON). */
export const uploadChatFile = async (file: File) =>
  request(ChatFile, '/api/chat/files', {
    method: 'POST',
    body: {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      contentBase64: await readBase64(file),
    },
  });

/** POST that answers with a stream of agent events (or a JSON error before it starts). */
async function streamTurn(
  path: string,
  body: unknown,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  await ensureOk(res);
  if (!res.headers.get('content-type')?.includes('text/event-stream'))
    throw new ApiError(res.status, 'invalid_response', `Expected an event stream from ${path}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (chunk.startsWith('data: '))
        onEvent(validate(AgentEvent, JSON.parse(chunk.slice(6)), `the assistant (${path})`));
    }
  }
}

/** Send a message; the assistant's reply streams to `onEvent`. */
export const sendChatMessage = (
  sessionId: string,
  message: { text: string; fileIds: string[] },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) =>
  streamTurn(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    message,
    onEvent,
    signal,
  );

/** Approve or reject an action the assistant asked to run; the rest of the turn streams back. */
export const resolveChatAction = (
  sessionId: string,
  runId: string,
  approve: boolean,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) =>
  streamTurn(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(runId)}`,
    { approve },
    onEvent,
    signal,
  );
