import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './client';

export type StoredPart =
  | { type: 'text'; text: string }
  | { type: 'file_ref'; fileId: string; name: string; mimeType: string }
  | { type: 'tool_call'; id?: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id?: string; name: string; result: unknown; isError?: boolean };

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  parts: StoredPart[];
}

export interface ToolRun {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: 'awaiting_approval' | 'done' | 'error' | 'rejected';
  /** For waiting runs: { description } of the approval request. */
  result?: unknown;
}

export interface EmailDraft {
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  sourceMessageId?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  replyPreview?: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; runId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; runId: string; name: string; ok: boolean; summary: string }
  | {
      type: 'approval_required';
      runId: string;
      name: string;
      args: Record<string, unknown>;
      description: string;
    }
  | { type: 'draft'; draft: EmailDraft }
  | { type: 'done'; status: 'complete' | 'awaiting_approval' | 'step_limit' }
  | { type: 'error'; message: string };

export interface MemoryItem {
  id: string;
  content: string;
  category: string;
  updatedAt: string;
}

export function useChatSessions() {
  return useQuery({
    queryKey: ['chat', 'sessions'],
    queryFn: () => api<ChatSession[]>('/api/chat/sessions'),
  });
}

export function useChatSession(id: string | undefined) {
  return useQuery({
    queryKey: ['chat', 'session', id],
    queryFn: () =>
      api<{ session: ChatSession; messages: ChatMessage[]; awaiting: ToolRun[] }>(
        `/api/chat/sessions/${id}`,
      ),
    enabled: !!id,
  });
}

export function useMemory(enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'memory'],
    queryFn: () => api<MemoryItem[]>('/api/memory'),
    enabled,
  });
}

/** POST that answers with an SSE stream of agent events (or a JSON error before it starts). */
export async function streamTurn(
  url: string,
  body: unknown,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      payload?.error?.code ?? 'http_error',
      payload?.error?.message ?? res.statusText,
    );
  }
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
      if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)) as AgentEvent);
    }
  }
}

export async function uploadChatFile(
  file: File,
): Promise<{ id: string; filename: string; mimeType: string; size: number }> {
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
  return api('/api/chat/files', {
    method: 'POST',
    body: { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64 },
  });
}
