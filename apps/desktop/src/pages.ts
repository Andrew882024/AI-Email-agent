const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A self-contained status page (starting, database down, crashed) as a data: URL. */
export function statusPageUrl(page: {
  title: string;
  message: string;
  detail?: string;
  busy?: boolean;
}): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>AI Email Agent</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f8fc;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f1f1f}
main{max-width:520px;background:#fff;border-radius:16px;padding:32px 36px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;font-weight:500;margin:0 0 8px}p{margin:8px 0;color:#444}
pre{background:#f1f3f4;border-radius:8px;padding:10px 12px;white-space:pre-wrap;font-size:13px}
.spin{width:18px;height:18px;border:2px solid #c2e7ff;border-top-color:#1a73e8;border-radius:50%;
display:inline-block;vertical-align:-3px;margin-right:8px;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
</style></head><body><main>
<h1>${page.busy ? '<span class="spin"></span>' : ''}${escape(page.title)}</h1>
<p>${escape(page.message)}</p>${page.detail ? `<pre>${escape(page.detail)}</pre>` : ''}
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
