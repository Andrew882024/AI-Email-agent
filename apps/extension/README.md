# AI Email Agent for Gmail (Chrome extension)

The assistant from the web app, in Chrome's side panel next to Gmail. It talks to the same server
(`apps/server`) with the same sign-in, so chats, memory and workflows are shared with the web app.
The toolbar button and the panel are enabled on `mail.google.com` tabs only.

## Setup

1. Allow the extension's origin in `apps/server/.env` and restart the server:
   `ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,chrome-extension://onbgbnemkenflcpjogcmfjiajnmfmaao`
   (the ID is fixed by `key` in `public/manifest.json`).
2. `pnpm install && pnpm build` (or `pnpm dev` to rebuild on change).
3. `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/dist`.
4. Sign in to the web app at http://localhost:5173 (use `localhost`, not 127.0.0.1: the sign-in
   cookie belongs to the host you opened).
5. Open Gmail and click the extension's button.

After a rebuild, press reload on the extension in `chrome://extensions`; after the first install,
reload open Gmail tabs once so the content script is there.

`VITE_API_URL` and `VITE_APP_URL` (build time) point it at another server or app URL.

## Drafts

Drafts open in Gmail's own compose window: new emails via Compose; replies and forwards from the
conversation's Reply / Reply all / Forward buttons, so Gmail keeps them in the thread (Gmail replies
to the conversation's latest email). If that fails — Gmail's page changed, or the tab wasn't
reloaded — the draft opens in Gmail's full-page compose in a new tab, where a reply is sent as a
new email.
