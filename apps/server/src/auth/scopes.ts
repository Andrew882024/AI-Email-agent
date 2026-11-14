// Identity scopes, in the full-URL form Google echoes back in the token response.
const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/** API scopes the app needs. The consent screen lets users untick these, so we verify them. */
export const REQUIRED_API_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify', // read, label, archive, send
  'https://www.googleapis.com/auth/tasks', // todos
  'https://www.googleapis.com/auth/drive.file', // files this app creates (PDF exports)
  'https://www.googleapis.com/auth/spreadsheets', // workflow output to Sheets
  'https://www.googleapis.com/auth/documents', // workflow output to Docs
];

export const GOOGLE_SCOPES = [...IDENTITY_SCOPES, ...REQUIRED_API_SCOPES];
