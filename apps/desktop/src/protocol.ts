// Messages between the Electron main process and the server utility process.

export type ToServer =
  | { type: 'start'; env: Record<string, string>; secretKey: string; port: number; webRoot: string }
  | { type: 'stop' };

export type FromServer =
  | { type: 'ready'; port: number }
  | {
      type: 'startup-error';
      reason: 'database' | 'config' | 'unknown';
      message: string;
      hint?: string;
    }
  | { type: 'open-external'; url: string }
  | { type: 'stopped' };
