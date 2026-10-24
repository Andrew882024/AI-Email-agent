import { ImageOff } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { attachmentUrl, type Message } from '../../api/mail';
import { buildEmailDocument } from '../../utils/email-html';

/**
 * Renders an email body in a sandboxed iframe: scripts, forms and plugins are blocked by the
 * sandbox and a CSP; remote images stay off until the user asks (they reveal that mail was read).
 * allow-same-origin (without allow-scripts) only lets us measure the content height.
 */
export function EmailBody({ message }: { message: Message }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(60);
  const observer = useRef<ResizeObserver | null>(null);

  const { doc, hasRemoteContent } = useMemo(() => {
    const origin = window.location.origin;
    const inline = new Map(
      message.attachments.flatMap((a) =>
        a.contentId
          ? [[a.contentId, `${origin}${attachmentUrl(message.id, a.partId)}`] as const]
          : [],
      ),
    );
    return buildEmailDocument(
      { html: message.bodyHtml, text: message.bodyText ?? message.snippet },
      { allowRemote, origin, cidUrl: (cid) => inline.get(cid) },
    );
  }, [message, allowRemote]);

  const measure = (frame: HTMLIFrameElement) => {
    const body = frame.contentDocument?.body;
    if (!body) return;
    const update = () =>
      setHeight(Math.max(40, frame.contentDocument?.documentElement.scrollHeight ?? 40));
    update();
    observer.current?.disconnect();
    observer.current = new ResizeObserver(update);
    observer.current.observe(body);
  };

  return (
    <div>
      {hasRemoteContent && !allowRemote && (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-700">
          <ImageOff className="h-4 w-4" />
          Remote images are hidden to protect your privacy.
          <button
            type="button"
            onClick={() => setAllowRemote(true)}
            className="font-medium text-blue-700 hover:underline"
          >
            Show images
          </button>
        </div>
      )}
      <iframe
        title={`Email: ${message.subject}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        onLoad={(e) => measure(e.currentTarget)}
        style={{ height }}
        className="w-full border-0"
      />
    </div>
  );
}
