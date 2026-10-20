import { ReauthRequiredError } from '../auth/errors.js';
import type { Repositories } from '../db/repositories.js';
import type { OutboxOp } from '../domain/types.js';
import type { EventBus } from '../events/event-bus.js';
import { isRetryableGoogleError } from '../google/errors.js';
import type { GatewayProvider } from '../google/gateways.js';
import type { ActionLogger } from '../logging/action-logger.js';
import type { Logger } from '../logging/system-logger.js';
import type { MailSync } from './mail-sync.js';
import type { OutboxOpName, OutboxPayloads } from './outbox-ops.js';

export interface OutboxWorkerOptions {
  repos: Repositories;
  gateways: GatewayProvider;
  events: EventBus;
  actions: ActionLogger;
  logger: Logger;
  /** Used to undo a failed label change by re-reading Gmail. */
  mailSync: Pick<MailSync, 'refreshMessages'>;
  /** Give up on a retryable op after this many attempts. Default 8. */
  maxAttempts?: number;
  /** Delay before retry N (1-based). Default: 5s doubling, capped at 10 minutes. */
  retryDelayMs?: (attempt: number) => number;
}

const REAUTH_RETRY_MS = 5 * 60_000;

type Handlers = {
  [K in OutboxOpName]: (accountId: string, payload: OutboxPayloads[K]) => Promise<void>;
};

/** Pushes queued local changes to Google, strictly in order per account. */
export class OutboxWorker {
  private readonly handlers: Handlers;

  constructor(private readonly options: OutboxWorkerOptions) {
    const { repos, gateways, events } = options;
    this.handlers = {
      modify_labels: async (accountId, p) => {
        await (
          await gateways.gmail(accountId)
        ).modifyMessages(p.messageIds, { add: p.add, remove: p.remove });
      },
      send_message: async (accountId, p) => {
        await (await gateways.gmail(accountId)).sendMessage(p.raw, p.threadId);
      },
      create_task: async (accountId, p) => {
        if (!(await repos.todos.getById(p.todoId))) return; // removed before it was pushed
        const tasks = await gateways.tasks(accountId);
        const tasklistId = await tasks.getDefaultTasklistId();
        const task = await tasks.createTask(tasklistId, {
          title: p.title,
          notes: p.notes,
          due: p.due ? new Date(p.due) : undefined,
        });
        const linked = await repos.todos.update(p.todoId, { googleTaskId: task.id, tasklistId });
        if (!linked) await tasks.deleteTask(tasklistId, task.id); // removed while being pushed
        events.emit('todos.changed', { accountId });
      },
      delete_task: async (accountId, p) => {
        await (await gateways.tasks(accountId)).deleteTask(p.tasklistId, p.googleTaskId);
      },
    };
  }

  /** Push the account's queued ops until the queue is empty or its head waits for a retry. */
  async drain(accountId: string): Promise<number> {
    let processed = 0;
    for (;;) {
      const op = await this.options.repos.outbox.claimNext(accountId);
      if (!op) return processed;
      await this.execute(op);
      processed++;
    }
  }

  private async execute(op: OutboxOp): Promise<void> {
    const { repos, events, logger } = this.options;
    const handler = this.handlers[op.op as OutboxOpName] as
      ((accountId: string, payload: unknown) => Promise<void>) | undefined;
    try {
      if (!handler) throw new Error(`Unknown outbox op "${op.op}"`);
      await handler(op.accountId, op.payload);
      await repos.outbox.markDone(op.id);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ReauthRequiredError) {
        // Not the op's fault: keep it until the user reconnects.
        await repos.outbox.markRetry(op.id, message, REAUTH_RETRY_MS);
        events.emit('sync.status', {
          accountId: op.accountId,
          phase: 'reauth_required',
          error: message,
        });
        return;
      }
      if (isRetryableGoogleError(err) && op.attempts < (this.options.maxAttempts ?? 8)) {
        await repos.outbox.markRetry(op.id, message, this.retryDelay(op.attempts));
        logger.warn(
          { err, opId: op.id, op: op.op, attempt: op.attempts },
          'outbox op will be retried',
        );
        return;
      }
      await repos.outbox.markFailed(op.id, message);
      await this.options.actions.log({
        accountId: op.accountId,
        actor: 'sync',
        action: `outbox.${op.op}`,
        targetIds: this.targets(op),
        status: 'error',
        error: message,
      });
      await this.compensate(op).catch((compErr: unknown) =>
        logger.error({ err: compErr, opId: op.id }, 'failed to reconcile after outbox failure'),
      );
      events.emit('outbox.failed', { accountId: op.accountId, op: op.op, error: message });
    }
  }

  /** Bring local state back in line with Google after a change was given up on. */
  private async compensate(op: OutboxOp): Promise<void> {
    if (op.op === 'modify_labels') {
      const { messageIds } = op.payload as OutboxPayloads['modify_labels'];
      await this.options.mailSync.refreshMessages(op.accountId, messageIds);
    } else if (op.op === 'create_task') {
      const { todoId } = op.payload as OutboxPayloads['create_task'];
      const todo = await this.options.repos.todos.getById(todoId);
      if (todo && !todo.googleTaskId) {
        await this.options.repos.todos.delete(todoId);
        this.options.events.emit('todos.changed', { accountId: op.accountId });
      }
    }
  }

  private targets(op: OutboxOp): string[] {
    const payload = op.payload as Partial<
      OutboxPayloads['modify_labels'] & OutboxPayloads['create_task']
    >;
    return payload.messageIds ?? (payload.todoId ? [payload.todoId] : []);
  }

  private retryDelay(attempt: number): number {
    return this.options.retryDelayMs?.(attempt) ?? Math.min(5000 * 2 ** (attempt - 1), 10 * 60_000);
  }
}
