import open from 'open';
import type { OpenExternal } from './google-auth.js';

/** OpenExternal for the server and CLI: the system's default browser. */
export const openInSystemBrowser: OpenExternal = async (url) => {
  await open(url);
};
