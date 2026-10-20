import { ReauthRequiredError } from '../auth/errors.js';
import type { GoogleAuthProvider } from '../auth/google-auth.js';
import type { Repositories } from '../db/repositories.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../logging/system-logger.js';
import type { MailSync } from './mail-sync.js';
import type { OutboxWorker } from './outbox-worker.js';
import type { TasksSync } from './tasks-sync.js';

/** Runs `task` every `intervalMs` without overlap; kick() runs it again as soon as possible. */
class Loop {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rerun = false;
  private stopped = true;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.timer);
    this.running = this.task().finally(() => {
      this.running = undefined;
      if (this.stopped) return;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      } else {
        this.timer = setTimeout(() => this.kick(), this.intervalMs);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

export interface SyncSchedulerOptions {
  repos: Repositories;
  auth: Pick<GoogleAuthProvider, 'isConnected'>;
  mailSync: MailSync;
  tasksSync: TasksSync;
  outbox: OutboxWorker;
  events: EventBus;
  logger: Logger;
  mailIntervalMs: number;
  /** Fallback poll; new ops wake the worker immediately. Default 5s. */
  outboxIntervalMs?: number;
  tasksIntervalMs?: number;
}

/** Background sync for every connected account: Gmail polling, Tasks polling, outbox pushes. */
export class SyncScheduler {
  private readonly mail: Loop;
  private readonly tasks: Loop;
  private readonly outbox: Loop;
  private unsubscribe?: () => void;

  constructor(private readonly options: SyncSchedulerOptions) {
    this.mail = new Loop(
      () => this.forEachAccount('mail', (id) => this.syncMail(id)),
      options.mailIntervalMs,
    );
    this.tasks = new Loop(
      () => this.forEachAccount('tasks', async (id) => void (await options.tasksSync.sync(id))),
      options.tasksIntervalMs ?? 60_000,
    );
    this.outbox = new Loop(
      () => this.forEachAccount('outbox', (id) => this.drainOutbox(id)),
      options.outboxIntervalMs ?? 5000,
    );
  }

  async start(): Promise<void> {
    // Ops left in_progress by a crash are safe to retry.
    const requeued = await this.options.repos.outbox.requeueInProgress();
    if (requeued > 0) this.options.logger.info({ requeued }, 'requeued interrupted outbox ops');
    this.unsubscribe = this.options.events.on('outbox.enqueued', () => this.outbox.kick());
    this.outbox.start();
    this.mail.start();
    this.tasks.start();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await Promise.all([this.mail.stop(), this.tasks.stop(), this.outbox.stop()]);
  }

  /** Poll Gmail now (e.g. user pressed refresh). */
  syncNow(): void {
    this.mail.kick();
  }

  private async syncMail(accountId: string): Promise<void> {
    await this.options.mailSync.sync(accountId);
    this.options.events.emit('sync.status', { accountId, phase: 'idle' });
  }

  private async drainOutbox(accountId: string): Promise<void> {
    // Pull right away so pushed changes (e.g. a sent message) show up without waiting a poll.
    if ((await this.options.outbox.drain(accountId)) > 0) this.mail.kick();
  }

  private async forEachAccount(
    loop: string,
    fn: (accountId: string) => Promise<void>,
  ): Promise<void> {
    const { repos, auth, events, logger } = this.options;
    for (const account of await repos.accounts.list()) {
      try {
        if (!(await auth.isConnected(account.id))) continue;
        await fn(account.id);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const phase = err instanceof ReauthRequiredError ? 'reauth_required' : 'error';
        events.emit('sync.status', { accountId: account.id, phase, error });
        logger.error({ err, accountId: account.id, loop }, 'sync loop failed');
      }
    }
  }
}
