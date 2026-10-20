export type OpenAction =
  { kind: 'download'; url: string } | { kind: 'external'; url: string } | { kind: 'deny' };

/**
 * What to do when the page opens a URL in a new window (links in emails use target=_blank):
 * attachments from our own server are downloaded, web links go to the system browser, and
 * everything else (file:, custom schemes, other app pages) is refused.
 */
export function classifyOpen(url: string, appOrigin: string | undefined): OpenAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'deny' };
  }
  if (appOrigin && parsed.origin === appOrigin) {
    return /^\/api\/messages\/[^/]+\/attachments\//.test(parsed.pathname)
      ? { kind: 'download', url }
      : { kind: 'deny' };
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return { kind: 'external', url };
  return { kind: 'deny' };
}

/** The app window may only ever show our own origin. */
export function allowNavigation(url: string, appOrigin: string | undefined): boolean {
  try {
    return !!appOrigin && new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}
