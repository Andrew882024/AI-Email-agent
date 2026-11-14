import type { ActionLogEntry } from '../domain/types.js';
import type { ActionLogRepository, NewActionLog } from '../db/repositories.js';
import type { Logger } from './system-logger.js';

/** Who/what an action is about; status, error and duration are filled in by `track`. */
export type ActionContext = Omit<NewActionLog, 'status' | 'error' | 'durationMs'>;

/**
 * Records every action (user, agent, workflow or sync) with a timestamp, to the action_logs table
 * and the system log. Logging never breaks the action: persistence failures are reported to the
 * system log and swallowed.
 */
export class ActionLogger {
  constructor(
    private readonly repo: ActionLogRepository,
    private readonly logger: Logger,
  ) {}

  async log(entry: NewActionLog): Promise<ActionLogEntry | undefined> {
    const level = entry.status === 'error' ? 'warn' : 'info';
    this.logger[level](
      { kind: 'action', ...entry },
      `${entry.actor} ${entry.action} ${entry.status}`,
    );
    try {
      return await this.repo.insert(entry);
    } catch (err) {
      this.logger.error({ err, action: entry.action }, 'failed to persist action log');
      return undefined;
    }
  }

  /** Run `fn`, then log it as success or error with its duration. Rethrows `fn`'s error. */
  async track<T>(context: ActionContext, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      await this.log({
        ...context,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: elapsed(),
      });
      throw err;
    }
    await this.log({ ...context, status: 'success', durationMs: elapsed() });
    return result;
  }
}
