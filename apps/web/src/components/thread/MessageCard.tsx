import { Download, Paperclip, Reply } from 'lucide-react';
import { useState } from 'react';
import { attachmentUrl, type Message } from '../../api/mail';
import { IconButton } from '../ui/IconButton';
import { displayName, fileSize, longDate } from '../../utils/format';
import type { ComposeMode } from '../../state/ui';
import { EmailBody } from './EmailBody';

/** One message of the conversation: collapsed to a line, or expanded with body and attachments. */
export function MessageCard(props: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
  self: string;
  onCompose: (mode: ComposeMode) => void;
}) {
  const { message, self } = props;
  const [details, setDetails] = useState(false);
  const recipients = [...message.to, ...message.cc];
  const sender = message.from;
  // Inline images shown inside the body aren't listed again as files.
  const files = message.attachments.filter(
    (a) => !(a.contentId && message.bodyHtml?.includes(`cid:${a.contentId}`)),
  );

  if (!props.expanded) {
    return (
      <button
        type="button"
        onClick={props.onToggle}
        className="flex w-full items-center gap-4 border-b border-gray-100 px-6 py-3 text-left text-sm hover:bg-gray-50"
      >
        <span className="w-48 shrink-0 truncate font-medium">{displayName(sender, self)}</span>
        <span className="flex-1 truncate text-gray-600">{message.snippet}</span>
        <span className="shrink-0 text-xs text-gray-500">{longDate(message.internalDate)}</span>
      </button>
    );
  }

  return (
    <article className="border-b border-gray-100 px-6 py-4">
      <header className="mb-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-500 font-medium text-white">
          {displayName(sender).charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={props.onToggle}>
          <div className="text-sm">
            <span className="font-semibold">{sender?.name ?? sender?.email}</span>
            {sender?.name && <span className="text-xs text-gray-600"> &lt;{sender.email}&gt;</span>}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDetails(!details);
            }}
            className="text-xs text-gray-600 hover:underline"
          >
            to {recipients.map((a) => displayName(a, self)).join(', ') || '(no recipients)'} ▾
          </button>
          {details && (
            <dl className="mt-2 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-0.5 text-xs text-gray-700">
              <dt className="text-gray-500">from:</dt>
              <dd>{sender?.email}</dd>
              <dt className="text-gray-500">to:</dt>
              <dd>{message.to.map((a) => a.email).join(', ')}</dd>
              {message.cc.length > 0 && (
                <>
                  <dt className="text-gray-500">cc:</dt>
                  <dd>{message.cc.map((a) => a.email).join(', ')}</dd>
                </>
              )}
              <dt className="text-gray-500">date:</dt>
              <dd>{longDate(message.internalDate)}</dd>
            </dl>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-600">{longDate(message.internalDate)}</span>
        <IconButton label="Reply" onClick={() => props.onCompose('reply')}>
          <Reply className="h-[18px] w-[18px]" />
        </IconButton>
      </header>
      <div className="pl-13">
        <EmailBody message={message} />
        {files.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {files.map((a) => (
              <a
                key={a.partId}
                href={attachmentUrl(message.id, a.partId)}
                target="_blank"
                rel="noreferrer"
                className="flex w-56 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <Paperclip className="h-4 w-4 shrink-0 text-gray-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.filename || 'attachment'}</span>
                  <span className="text-xs text-gray-500">{fileSize(a.size)}</span>
                </span>
                <Download className="h-4 w-4 shrink-0 text-gray-500" />
              </a>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
