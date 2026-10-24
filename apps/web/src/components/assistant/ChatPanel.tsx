import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  FileText,
  MailPlus,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  type AgentEvent,
  type ChatMessage,
  type EmailDraft,
  resolveChatAction,
  sendChatMessage,
  type StoredPart,
  type ToolRun,
  uploadChatFile,
} from '../../api/chat';
import { ApiError } from '../../api/client';
import {
  useChatSession,
  useChatSessions,
  useCreateChatSession,
  useDeleteChatSession,
  useRefreshAfterTurn,
} from '../../state/chat';
import { useChatPanel, useComposeActions, useToast } from '../../state/ui';
import { fileSize } from '../../utils/format';
import { MemoryDialog } from './MemoryDialog';
import { IconButton } from '../ui/IconButton';
import { Spinner } from '../ui/Spinner';
import { openThread, showList } from '../../router/mail-params';

const SUGGESTIONS = [
  'Summarize my unread emails from today',
  'Find my most recent invoice',
  'What do I need to reply to this week?',
];

/** Tool names as the user reads them. */
const toolLabel = (name: string) => name.replace(/_/g, ' ');

/** Markdown with links to emails (#thread/<id>) opening the conversation in the app. */
function Answer({ text }: { text: string }) {
  return (
    <div className="chat-md text-sm leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith('#thread/') ? (
              <button
                type="button"
                onClick={() => openThread(decodeURIComponent(href.slice(8)))}
                className="text-blue-700 hover:underline"
              >
                {children}
              </button>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 hover:underline"
              >
                {children}
              </a>
            ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function ToolChip(props: {
  name: string;
  args: Record<string, unknown>;
  state: 'running' | 'ok' | 'error' | 'waiting';
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  const color =
    props.state === 'error'
      ? 'text-red-700'
      : props.state === 'waiting'
        ? 'text-amber-700'
        : 'text-gray-600';
  return (
    <div className={`text-xs ${color}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 hover:bg-gray-200"
      >
        {props.state === 'running' ? (
          <Spinner className="h-3 w-3" />
        ) : (
          <Wrench className="h-3 w-3" />
        )}
        {toolLabel(props.name)}
        {props.state === 'error' && ' — failed'}
        {props.state === 'waiting' && ' — needs approval'}
        <ChevronDown className={`h-3 w-3 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 p-2 text-[11px] text-gray-700">
          {JSON.stringify(props.args, null, 1)}
          {props.detail ? `\n→ ${props.detail}` : ''}
        </pre>
      )}
    </div>
  );
}

function ApprovalCard(props: {
  description: string;
  args: Record<string, unknown>;
  onDecide: (approve: boolean) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-900">
        <ShieldAlert className="h-4 w-4" /> Approve: {props.description}?
      </div>
      <p className="mt-1 text-xs text-amber-900/80">
        Changes this many emails at once only run with your approval.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={props.busy}
          onClick={() => props.onDecide(true)}
          className="flex items-center gap-1 rounded-full bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" /> Approve
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={() => props.onDecide(false)}
          className="rounded-full border border-amber-400 px-3 py-1 text-xs hover:bg-amber-100 disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

function DraftChip({ draft }: { draft: EmailDraft }) {
  const openDraft = useOpenDraft();
  return (
    <button
      type="button"
      onClick={() => openDraft(draft)}
      className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-left text-xs text-blue-900 hover:bg-blue-100"
    >
      <MailPlus className="h-4 w-4 shrink-0" />
      <span className="min-w-0">
        <span className="block font-medium">Draft: {draft.subject || '(no subject)'}</span>
        <span className="block truncate text-blue-900/70">
          Opened in a compose window — click to open again
        </span>
      </span>
    </button>
  );
}

function useOpenDraft() {
  const openCompose = useComposeActions().open;
  return (draft: EmailDraft) =>
    openCompose({
      mode: draft.mode,
      sourceMessageId: draft.sourceMessageId,
      replyPreview: draft.replyPreview,
      to: draft.to.join(', '),
      cc: draft.cc.join(', '),
      showCc: draft.cc.length > 0,
      subject: draft.subject,
      body: draft.body,
    });
}

const Bubble = ({ children }: { children: ReactNode }) => (
  <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-[#d3e3fd] px-3.5 py-2 text-sm whitespace-pre-wrap">
    {children}
  </div>
);

/** A stored conversation, paired up: each tool call shows the outcome from the next message's results. */
function History({
  messages,
  awaiting,
  onDecide,
  busy,
}: {
  messages: ChatMessage[];
  awaiting: ToolRun[];
  onDecide: (runId: string, approve: boolean) => void;
  busy: boolean;
}) {
  const results = new Map<string, Extract<StoredPart, { type: 'tool_result' }>>();
  messages.forEach((m, i) => {
    if (m.role !== 'model') return;
    const next = messages[i + 1];
    m.parts
      .filter((p) => p.type === 'tool_call')
      .forEach((_, position) => {
        const result = next?.parts.filter((p) => p.type === 'tool_result')[position];
        if (result?.type === 'tool_result') results.set(`${m.id}:${position}`, result);
      });
  });
  return (
    <>
      {messages.map((m) => {
        if (m.role === 'user') {
          const texts = m.parts.filter((p) => p.type === 'text');
          const files = m.parts.filter((p) => p.type === 'file_ref');
          if (texts.length === 0 && files.length === 0) return null; // tool results only
          return (
            <div key={m.id} className="flex flex-col items-end gap-1">
              {files.map((f) => (
                <span
                  key={f.fileId}
                  className="flex items-center gap-1 rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-700"
                >
                  <FileText className="h-3.5 w-3.5" /> {f.name}
                </span>
              ))}
              {texts.length > 0 && <Bubble>{texts.map((t) => t.text).join('\n')}</Bubble>}
            </div>
          );
        }
        let call = -1;
        return (
          <div key={m.id} className="flex flex-col gap-2">
            {m.parts.map((p, i) => {
              if (p.type === 'text') return p.text.trim() ? <Answer key={i} text={p.text} /> : null;
              if (p.type !== 'tool_call') return null;
              call++;
              const result = results.get(`${m.id}:${call}`);
              const waiting = awaiting.find(
                (r) => r.tool === p.name && JSON.stringify(r.input) === JSON.stringify(p.args),
              );
              return (
                <div key={i} className="flex flex-col gap-2">
                  <ToolChip
                    name={p.name}
                    args={p.args}
                    state={waiting ? 'waiting' : result?.isError ? 'error' : 'ok'}
                    detail={result ? JSON.stringify(result.result).slice(0, 300) : undefined}
                  />
                  {p.name === 'draft_email' && !result?.isError && (
                    <span className="text-xs text-gray-500">Draft opened in a compose window.</span>
                  )}
                  {waiting && (
                    <ApprovalCard
                      description={
                        (waiting.result as { description?: string } | undefined)?.description ??
                        `${toolLabel(waiting.tool)} on ${(waiting.input.messageIds as unknown[] | undefined)?.length ?? 0} emails`
                      }
                      args={waiting.input}
                      busy={busy}
                      onDecide={(approve) => onDecide(waiting.id, approve)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

interface LiveTurn {
  user?: { text: string; files: string[] };
  text: string;
  tools: {
    runId: string;
    name: string;
    args: Record<string, unknown>;
    state: 'running' | 'ok' | 'error' | 'waiting';
    detail?: string;
  }[];
  approvals: Extract<AgentEvent, { type: 'approval_required' }>[];
  drafts: EmailDraft[];
  error?: string;
}

/** Docked assistant: ask about your mail, have it act on emails, draft replies. */
export function ChatPanel() {
  const { toggle: toggleChat, sessionId, setSessionId: setSession } = useChatPanel();
  const toast = useToast();
  const createSession = useCreateChatSession();
  const deleteSession = useDeleteChatSession();
  const refreshAfterTurn = useRefreshAfterTurn();
  const sessions = useChatSessions();
  const detail = useChatSession(sessionId);
  const openDraft = useOpenDraft();
  const [input, setInput] = useState('');
  // `preview`: a local URL of a pasted image, shown as a thumbnail until it is sent or removed.
  const [files, setFiles] = useState<
    { id: string; filename: string; size: number; preview?: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [live, setLive] = useState<LiveTurn>();
  const [busy, setBusy] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  // Default to the most recent conversation.
  useEffect(() => {
    if (!sessionId && sessions.data?.[0]) setSession(sessions.data[0].id);
  }, [sessionId, sessions.data, setSession]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [detail.data, live]);

  useEffect(() => () => abort.current?.abort(), []);

  const unavailable = sessions.error instanceof ApiError && sessions.error.status === 503;
  const awaiting = detail.data?.awaiting ?? [];

  /** Run one streamed assistant turn (a message, or a decision on a waiting action). */
  const run = async (
    turn: (onEvent: (event: AgentEvent) => void, signal: AbortSignal) => Promise<void>,
    user?: LiveTurn['user'],
  ) => {
    setBusy(true);
    setLive({ user, text: '', tools: [], approvals: [], drafts: [] });
    abort.current = new AbortController();
    try {
      await turn((event) => {
        if (event.type === 'draft') openDraft(event.draft);
        setLive((prev) => {
          if (!prev) return prev;
          switch (event.type) {
            case 'text':
              return { ...prev, text: prev.text + event.text };
            case 'tool_call':
              return prev.tools.some((t) => t.runId === event.runId)
                ? prev
                : {
                    ...prev,
                    tools: [
                      ...prev.tools,
                      {
                        runId: event.runId,
                        name: event.name,
                        args: event.args,
                        state: 'running',
                      },
                    ],
                  };
            case 'tool_result': {
              const known = prev.tools.some((t) => t.runId === event.runId);
              const tool = {
                runId: event.runId,
                name: event.name,
                args: {},
                state: event.ok ? ('ok' as const) : ('error' as const),
                detail: event.summary,
              };
              return {
                ...prev,
                tools: known
                  ? prev.tools.map((t) =>
                      t.runId === event.runId
                        ? { ...t, state: tool.state, detail: tool.detail }
                        : t,
                    )
                  : [...prev.tools, tool],
              };
            }
            case 'approval_required':
              return {
                ...prev,
                approvals: [...prev.approvals, event],
                tools: prev.tools.map((t) =>
                  t.runId === event.runId ? { ...t, state: 'waiting' } : t,
                ),
              };
            case 'draft':
              return { ...prev, drafts: [...prev.drafts, event.draft] };
            case 'error':
              return { ...prev, error: event.message };
            default:
              return prev;
          }
        });
      }, abort.current.signal);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError'))
        toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
      await refreshAfterTurn();
      setLive((prev) =>
        prev?.error ? { ...prev, user: undefined, text: '', tools: [] } : undefined,
      );
    }
  };

  const send = async (text = input) => {
    if (busy || (!text.trim() && files.length === 0)) return;
    let id = sessionId;
    if (!id) {
      id = (await createSession.mutateAsync()).id;
      setSession(id);
    }
    const sent = files;
    setInput('');
    setFiles([]);
    for (const f of sent) if (f.preview) URL.revokeObjectURL(f.preview);
    const sessionForTurn = id;
    await run(
      (onEvent, signal) =>
        sendChatMessage(sessionForTurn, { text, fileIds: sent.map((f) => f.id) }, onEvent, signal),
      { text, files: sent.map((f) => f.filename) },
    );
  };

  const decide = (runId: string, approve: boolean) => {
    if (sessionId)
      void run((onEvent, signal) => resolveChatAction(sessionId, runId, approve, onEvent, signal));
  };

  const attach = async (list: File[]) => {
    setUploading(true);
    try {
      for (const file of list) {
        const uploaded = await uploadChatFile(file);
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setFiles((prev) => [...prev, { ...uploaded, preview }]);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setUploading(false);
    }
  };

  const newChat = () => {
    setSession(undefined);
    setLive(undefined);
    createSession.mutate(undefined, {
      onSuccess: (s) => setSession(s.id),
      onError: (err) => toast(err.message, 'error'),
    });
  };

  const remove = async (id: string) => {
    await deleteSession.mutateAsync(id).catch(() => undefined);
    if (id === sessionId) setSession(undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const current = sessions.data?.find((s) => s.id === sessionId);
  const messages = detail.data?.messages ?? [];
  const empty = messages.length === 0 && !live?.user;
  const blocked = busy || awaiting.length > 0 || (live?.approvals.length ?? 0) > 0;

  return (
    <aside
      aria-label="Assistant"
      className="mb-2 mr-2 flex w-[400px] shrink-0 flex-col overflow-hidden rounded-2xl bg-white"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-100 pl-3 pr-1">
        <Bot className="h-5 w-5 shrink-0 text-blue-600" />
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-gray-100"
            >
              <span className="truncate">{current?.title ?? 'Assistant'}</span>
              <ChevronDown className="h-4 w-4 shrink-0" />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              align="start"
              sideOffset={4}
              className="z-50 max-h-96 w-80 overflow-y-auto rounded-xl border bg-white p-1 shadow-lg"
            >
              <Menu.Item
                onSelect={newChat}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none hover:bg-gray-100"
              >
                <Plus className="h-4 w-4" /> New chat
              </Menu.Item>
              {(sessions.data ?? []).length > 0 && (
                <Menu.Separator className="my-1 h-px bg-gray-200" />
              )}
              {(sessions.data ?? []).map((s) => (
                <Menu.Item
                  key={s.id}
                  onSelect={() => setSession(s.id)}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm outline-none hover:bg-gray-100 ${s.id === sessionId ? 'bg-blue-50' : ''}`}
                >
                  <span className="flex-1 truncate">{s.title}</span>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(s.id);
                    }}
                    className="invisible text-gray-500 hover:text-red-700 group-hover:visible"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <IconButton label="Workflows" onClick={() => showList({ kind: 'workflows' })}>
          <Zap className="h-[18px] w-[18px]" />
        </IconButton>
        <IconButton
          label="What the assistant remembers"
          onClick={() => setMemoryOpen(true)}
          disabled={unavailable}
        >
          <Brain className="h-[18px] w-[18px]" />
        </IconButton>
        <IconButton label="New chat" onClick={newChat} disabled={unavailable}>
          <Plus className="h-[18px] w-[18px]" />
        </IconButton>
        <IconButton label="Close assistant" onClick={toggleChat}>
          <X className="h-[18px] w-[18px]" />
        </IconButton>
      </header>

      <div
        ref={scroller}
        aria-busy={busy}
        aria-live="polite"
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {unavailable ? (
          <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The assistant needs a Gemini API key. Add GEMINI_API_KEY to the configuration and
            restart.
          </div>
        ) : empty ? (
          <div className="flex flex-col gap-2">
            <div className="rounded-2xl rounded-tl-sm bg-[#f2f6fc] px-4 py-3 text-sm text-gray-700">
              Ask me about your mail, or have me label, archive, add todos and draft replies. Paste
              images, PDFs, Word, Excel or text files into the message box and I can read them.
            </div>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                className="self-start rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          <History
            messages={messages}
            awaiting={live ? [] : awaiting}
            onDecide={decide}
            busy={busy}
          />
        )}
        {live && (
          <div className="flex flex-col gap-2">
            {live.user && (
              <div className="flex flex-col items-end gap-1">
                {live.user.files.map((f) => (
                  <span
                    key={f}
                    className="flex items-center gap-1 rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-700"
                  >
                    <FileText className="h-3.5 w-3.5" /> {f}
                  </span>
                ))}
                {live.user.text && <Bubble>{live.user.text}</Bubble>}
              </div>
            )}
            {live.tools.map((t) => (
              <ToolChip
                key={t.runId}
                name={t.name}
                args={t.args}
                state={t.state}
                detail={t.detail}
              />
            ))}
            {live.drafts.map((d, i) => (
              <DraftChip key={i} draft={d} />
            ))}
            {live.text && <Answer text={live.text} />}
            {live.approvals.map((a) => (
              <ApprovalCard
                key={a.runId}
                description={a.description}
                args={a.args}
                busy={busy}
                onDecide={(approve) => decide(a.runId, approve)}
              />
            ))}
            {busy && !live.text && <Spinner className="h-4 w-4 text-blue-600" />}
            {live.error && <p className="text-sm text-red-700">{live.error}</p>}
          </div>
        )}
      </div>

      <footer className="border-t border-gray-100 p-3">
        {(files.length > 0 || uploading) && (
          <div className="mb-2 flex flex-wrap items-end gap-1.5">
            {files.map((f) => {
              const remove = () => {
                if (f.preview) URL.revokeObjectURL(f.preview);
                setFiles(files.filter((x) => x.id !== f.id));
              };
              return f.preview ? (
                <span key={f.id} className="group relative">
                  <img
                    src={f.preview}
                    alt={f.filename}
                    title={`${f.filename} (${fileSize(f.size)})`}
                    className="h-16 w-16 rounded-xl border border-gray-200 object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${f.filename}`}
                    onClick={remove}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-gray-200 bg-white p-0.5 text-gray-700 shadow-sm hover:bg-gray-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : (
                <span
                  key={f.id}
                  className="flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-xs"
                >
                  <FileText className="h-3.5 w-3.5" /> {f.filename}{' '}
                  <span className="text-gray-500">({fileSize(f.size)})</span>
                  <button type="button" aria-label={`Remove ${f.filename}`} onClick={remove}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
            {uploading && (
              <span className="flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">
                <Spinner className="h-3.5 w-3.5" /> Uploading…
              </span>
            )}
          </div>
        )}
        <div className="flex items-end gap-1 rounded-2xl border border-gray-300 py-1.5 pl-3 pr-2 focus-within:border-blue-600">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            // Pasted screenshots, copied images and files (e.g. from Finder) are attached, not typed.
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length === 0) return;
              e.preventDefault();
              void attach(pasted);
            }}
            rows={Math.min(6, Math.max(1, input.split('\n').length))}
            disabled={unavailable}
            placeholder={
              awaiting.length > 0
                ? 'Approve or decline the action above first'
                : 'Ask about your email… (paste images or files)'
            }
            aria-label="Message the assistant"
            className="max-h-40 flex-1 resize-none bg-transparent py-2 text-sm outline-none"
          />
          <IconButton
            label="Send"
            onClick={() => void send()}
            disabled={unavailable || blocked || (!input.trim() && files.length === 0)}
          >
            <Send className="h-4 w-4" />
          </IconButton>
        </div>
      </footer>
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
    </aside>
  );
}
