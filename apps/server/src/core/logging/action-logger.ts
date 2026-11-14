import type { ActionStatus, Actor } from '../domain/types.js';
import type { Logger } from './system-logger.js';

/** One action (by the user, the agent, a workflow or sync) and how it went. */
export interface ActionEntry {
  accountId?: string;
  actor: Actor;
  action: string;
  targetIds?: string[];
  params?: unknown;
  status: ActionStatus;
  error?: string;
  durationMs?: number;
}

/** Who/what an action is about; status, error and duration are filled in by `track`. */
export type ActionContext = Omit<ActionEntry, 'status' | 'error' | 'durationMs'>;

/**
 * Records every action (user, agent, workflow or sync) to the system log, as `kind: 'action'`
 * lines, so app.jsonl is the audit trail.
 */
export class ActionLogger {
  constructor(private readonly logger: Logger) {}

  async log(entry: ActionEntry): Promise<void> {
    const level = entry.status === 'error' ? 'warn' : 'info';
    this.logger[level](
      { kind: 'action', ...entry },
      `${entry.actor} ${entry.action} ${entry.status}`,
    );
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
