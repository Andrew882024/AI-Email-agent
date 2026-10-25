import { useMemo, useRef, useState } from 'react';
import { attachmentUrl, type Message } from '../../api/mail';
import { buildEmailDocument } from '../../utils/email-html';

/**
 * Renders an email body in a sandboxed iframe: scripts, forms and plugins are blocked by the
 * sandbox and a CSP; remote images load right away, as in Gmail.
 * allow-same-origin (without allow-scripts) only lets us measure the content height.
 */
export function EmailBody({ message }: { message: Message }) {
  const [height, setHeight] = useState(60);
  const observer = useRef<ResizeObserver | null>(null);

  const doc = useMemo(() => {
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
      { origin, cidUrl: (cid) => inline.get(cid) },
    );
  }, [message]);

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
    <iframe
      title={`Email: ${message.subject}`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      onLoad={(e) => measure(e.currentTarget)}
      style={{ height }}
      className="w-full border-0"
    />
  );
}
