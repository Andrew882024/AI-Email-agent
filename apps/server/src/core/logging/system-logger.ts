import { join } from 'node:path';
import { type Level, type Logger, pino } from 'pino';

export type { Logger } from 'pino';

/**
 * Process-wide structured logger: stdout plus, when `logDir` is given, `<logDir>/app.jsonl`.
 * Action log entries are also written here (see ActionLogger) so the file is a complete trail.
 */
export function createSystemLogger(options: {
  level: Level;
  logDir?: string;
  /** Also write to stdout. Default true; CLIs turn it off to keep their output readable. */
  stdout?: boolean;
}): Logger {
  const streams: { level: Level; stream: NodeJS.WritableStream | pino.DestinationStream }[] = [];
  if (options.stdout ?? true) streams.push({ level: options.level, stream: process.stdout });
  if (options.logDir) {
    streams.push({
      level: options.level,
      stream: pino.destination({
        dest: join(options.logDir, 'app.jsonl'),
        mkdir: true,
        sync: true,
      }),
    });
  }
  return pino({ level: options.level }, pino.multistream(streams));
}
