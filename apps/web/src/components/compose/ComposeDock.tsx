import { Maximize2, Minus, Paperclip, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { callTool } from '../../api/client';
import { fileSize, splitRecipients } from '../../lib/format';
import { type ComposeAttachment, type ComposeDraft, useUi } from '../../store';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const TITLES: Record<ComposeDraft['mode'], string> = {
  new: 'New Message',
  reply: 'Reply',
  replyAll: 'Reply all',
  forward: 'Forward',
};

function readFile(file: File): Promise<ComposeAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        contentBase64: String(reader.result).split(',')[1] ?? '',
      });
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** The tool call that sends a draft. */
function toolCall(draft: ComposeDraft): { name: string; input: Record<string, unknown> } {
  const attachments = draft.attachments.map(({ filename, mimeType, contentBase64 }) => ({
    filename,
    mimeType,
    contentBase64,
  }));
  const addressed = {
    to: splitRecipients(draft.to),
    ...(draft.cc.trim() && { cc: splitRecipients(draft.cc) }),
    ...(draft.bcc.trim() && { bcc: splitRecipients(draft.bcc) }),
  };
  switch (draft.mode) {
    case 'reply':
    case 'replyAll':
      return {
        name: 'reply_email',
        input: {
          messageId: draft.sourceMessageId,
          body: draft.body,
          replyAll: draft.mode === 'replyAll',
          attachments,
        },
      };
    case 'forward':
      return {
        name: 'forward_email',
        input: { messageId: draft.sourceMessageId, ...addressed, body: draft.body },
      };
    default:
      return {
        name: 'send_email',
        input: { ...addressed, subject: draft.subject, body: draft.body, attachments },
      };
  }
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children?: React.ReactNode;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 border-b border-gray-100 px-4 py-1.5 text-sm">
      <span className="w-14 shrink-0 text-gray-600">{props.label}</span>
      <input
        autoFocus={props.autoFocus}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-label={props.label}
        className="min-w-0 flex-1 bg-transparent py-1 outline-none"
      />
      {props.children}
    </label>
  );
}

function ComposeWindow({ draft }: { draft: ComposeDraft }) {
  const update = useUi((s) => s.updateCompose);
  const close = useUi((s) => s.closeCompose);
  const toast = useUi((s) => s.toast);
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ComposeDraft>) => update(draft.id, patch);
  const addressed = draft.mode === 'new' || draft.mode === 'forward';
  const canSend =
    !draft.sending &&
    (!addressed || splitRecipients(draft.to).length > 0) &&
    (draft.mode !== 'new' || draft.subject.trim() || draft.body.trim());

  const attach = async (files: FileList | null) => {
    if (!files) return;
    try {
      const added = await Promise.all([...files].map(readFile));
      const all = [...draft.attachments, ...added];
      if (all.reduce((n, a) => n + a.size, 0) > MAX_ATTACHMENT_BYTES) {
        toast('Attachments are limited to 18 MB in total', 'error');
        return;
      }
      set({ attachments: all });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const send = async () => {
    set({ sending: true, error: undefined });
    try {
      const { name, input } = toolCall(draft);
      await callTool(name, input);
      close(draft.id);
      toast('Message queued — it will be sent in a moment');
      void qc.invalidateQueries({ queryKey: ['sync'] });
    } catch (err) {
      set({ sending: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const title =
    draft.mode === 'new' ? draft.subject || TITLES.new : `${TITLES[draft.mode]}: ${draft.subject}`;

  return (
    <section
      aria-label={TITLES[draft.mode]}
      className={`flex flex-col overflow-hidden rounded-t-xl bg-white shadow-2xl ${draft.minimized ? 'w-72' : 'h-[520px] w-[520px]'}`}
    >
      <header
        onClick={() => set({ minimized: !draft.minimized })}
        className="flex h-10 shrink-0 cursor-pointer items-center gap-1 bg-[#f2f6fc] pl-4 pr-1 text-sm font-medium"
      >
        <span className="flex-1 truncate">{title}</span>
        <IconButton
          label={draft.minimized ? 'Expand' : 'Minimize'}
          onClick={() => set({ minimized: !draft.minimized })}
          className="h-8 w-8"
        >
          {draft.minimized ? <Maximize2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
        </IconButton>
        <IconButton label="Close" onClick={() => close(draft.id)} className="h-8 w-8">
          <X className="h-4 w-4" />
        </IconButton>
      </header>
      {!draft.minimized && (
        <>
          {addressed ? (
            <>
              <Field label="To" value={draft.to} onChange={(to) => set({ to })} autoFocus>
                {!draft.showCc && (
                  <button
                    type="button"
                    onClick={() => set({ showCc: true })}
                    className="text-xs text-gray-600 hover:underline"
                  >
                    Cc Bcc
                  </button>
                )}
              </Field>
              {draft.showCc && (
                <>
                  <Field label="Cc" value={draft.cc} onChange={(cc) => set({ cc })} />
                  <Field label="Bcc" value={draft.bcc} onChange={(bcc) => set({ bcc })} />
                </>
              )}
            </>
          ) : (
            <div className="border-b border-gray-100 px-4 py-2.5 text-sm text-gray-600">
              To: {draft.replyPreview}
            </div>
          )}
          {draft.mode === 'new' && (
            <Field label="Subject" value={draft.subject} onChange={(subject) => set({ subject })} />
          )}
          <textarea
            autoFocus={!addressed}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            aria-label="Message body"
            placeholder={draft.mode === 'forward' ? 'Add a note (optional)' : ''}
            className="min-h-0 flex-1 resize-none px-4 py-3 text-sm outline-none"
          />
          {draft.mode === 'forward' && (
            <p className="px-4 pb-2 text-xs text-gray-500">
              The original message and its attachments will be included.
            </p>
          )}
          {draft.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pb-2">
              {draft.attachments.map((a, i) => (
                <span
                  key={`${a.filename}-${i}`}
                  className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs"
                >
                  {a.filename} <span className="text-gray-500">({fileSize(a.size)})</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.filename}`}
                    onClick={() =>
                      set({ attachments: draft.attachments.filter((_, j) => j !== i) })
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {draft.error && <p className="px-4 pb-2 text-sm text-red-700">{draft.error}</p>}
          <footer className="flex items-center gap-1 px-4 py-3">
            <Button variant="primary" onClick={() => void send()} disabled={!canSend}>
              {draft.sending ? 'Sending…' : 'Send'}
            </Button>
            {draft.mode !== 'forward' && (
              <>
                <IconButton label="Attach files" onClick={() => fileInput.current?.click()}>
                  <Paperclip className="h-[18px] w-[18px]" />
                </IconButton>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    void attach(e.target.files);
                    e.target.value = '';
                  }}
                />
              </>
            )}
            <IconButton label="Discard draft" onClick={() => close(draft.id)} className="ml-auto">
              <Trash2 className="h-[18px] w-[18px]" />
            </IconButton>
          </footer>
        </>
      )}
    </section>
  );
}

/** Compose windows docked bottom-right, like Gmail. */
export function ComposeDock() {
  const composes = useUi((s) => s.composes);
  const chatOpen = useUi((s) => s.chatOpen);
  if (composes.length === 0) return null;
  return (
    // Sits left of the assistant panel when it's open, so neither covers the other.
    <div
      className={`pointer-events-none fixed bottom-0 z-40 flex flex-row-reverse items-end gap-3 ${chatOpen ? 'right-[404px]' : 'right-6'}`}
    >
      {composes.map((draft) => (
        <div key={draft.id} className="pointer-events-auto">
          <ComposeWindow draft={draft} />
        </div>
      ))}
    </div>
  );
}
