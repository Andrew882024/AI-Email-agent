import { pino } from 'pino';
import { type ActionEntry, ActionLogger } from '../../src/core/logging/action-logger.js';

/** An ActionLogger that appends its entries to `entries` (oldest first) for assertions. */
export function recordActions(entries: ActionEntry[] = []): {
  actions: ActionLogger;
  entries: ActionEntry[];
} {
  const logger = pino(
    { level: 'info', base: undefined, timestamp: false },
    {
      write(line: string) {
        const record = JSON.parse(line);
        if (record.kind !== 'action') return;
        delete record.kind;
        delete record.level;
        delete record.msg;
        entries.push(record as ActionEntry);
      },
    },
  );
  return { actions: new ActionLogger(logger), entries };
}
