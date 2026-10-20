// Builds the document shown inside the sandboxed iframe that renders an email body.

export interface EmailDocumentOptions {
  /** Load remote images/styles/fonts (they can tell the sender you opened the mail). */
  allowRemote: boolean;
  /** Resolves a cid: reference (inline image) to a URL on our API, if the message has it. */
  cidUrl: (contentId: string) => string | undefined;
  /** Our own origin, allowed for inline images served by the API. */
  origin: string;
}

const REMOTE = /(?:src|background)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Plain text to HTML with clickable links. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(
    /\bhttps?:\/\/[^\s<>&"']+/g,
    (url) => `<a href="${url}">${url}</a>`,
  );
}

export function buildEmailDocument(
  body: { html?: string; text?: string },
  options: EmailDocumentOptions,
): { doc: string; hasRemoteContent: boolean } {
  const html = body.html
    ? body.html.replace(
        /cid:([^"'\s)>]+)/gi,
        (match, cid: string) => options.cidUrl(decodeURIComponent(cid)) ?? match,
      )
    : `<div style="white-space:pre-wrap">${textToHtml(body.text ?? '')}</div>`;
  const remote = options.allowRemote ? ' https: http:' : '';
  // No scripts ever (the iframe sandbox also blocks them); remote content only when allowed.
  const csp = [
    "default-src 'none'",
    `img-src data: ${options.origin}${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    "script-src 'none'",
  ].join('; ');
  const doc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>html,body{margin:0;padding:0}body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f1f1f;overflow-wrap:anywhere}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368}</style>` +
    `</head><body>${html}</body></html>`;
  return { doc, hasRemoteContent: !!body.html && REMOTE.test(body.html) };
}
