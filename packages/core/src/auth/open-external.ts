import open from 'open';
import type { OpenExternal } from './google-auth.js';

/** Default OpenExternal outside Electron (dev server, CLI). */
export const openInSystemBrowser: OpenExternal = async (url) => {
  await open(url);
};
