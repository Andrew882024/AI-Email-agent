// Builds the document shown inside the sandboxed iframe that renders an email body.

export interface EmailDocumentOptions {
  /** Resolves a cid: reference (inline image) to a URL on our API, if the message has it. */
  cidUrl: (contentId: string) => string | undefined;
  /** Our own origin, allowed for inline images served by the API. */
  origin: string;
}

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
): string {
  const html = body.html
    ? body.html.replace(
        /cid:([^"'\s)>]+)/gi,
        (match, cid: string) => options.cidUrl(decodeURIComponent(cid)) ?? match,
      )
    : `<div style="white-space:pre-wrap">${textToHtml(body.text ?? '')}</div>`;
  // No scripts ever (the iframe sandbox also blocks them); remote images/styles/fonts load like Gmail.
  const csp = [
    "default-src 'none'",
    `img-src data: ${options.origin} https: http:`,
    "style-src 'unsafe-inline' https: http:",
    'font-src data: https: http:',
    "script-src 'none'",
  ].join('; ');
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>html,body{margin:0;padding:0}body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f1f1f;overflow-wrap:break-word}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368}</style>` +
    `</head><body>${html}</body></html>`
  );
}
