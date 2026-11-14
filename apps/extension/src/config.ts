// Where the extension finds the app. Override at build time with VITE_API_URL / VITE_APP_URL.
// Use "localhost" (not 127.0.0.1): the sign-in cookie belongs to the host the app was opened on.

/** The API server (apps/server). */
export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4317';

/** The web app (apps/web), where the user signs in. */
export const APP_URL =
  (import.meta.env.VITE_APP_URL as string | undefined) ?? 'http://localhost:5173';

export const GMAIL_ORIGIN = 'https://mail.google.com';
