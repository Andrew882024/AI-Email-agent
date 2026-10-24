import { ReauthRequiredError } from '../auth/errors.js';
import type { GoogleAuthProvider } from '../auth/google-auth.js';
import type { Repositories } from '../db/repositories.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../logging/system-logger.js';
import type { EmailIndexer } from '../rag/indexer.js';
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
  /** Keeps the semantic index current; new and changed mail wakes it. */
  indexer?: EmailIndexer;
  indexIntervalMs?: number;
}

/** One account's background work. */
interface AccountLoops {
  mail: Loop;
  tasks: Loop;
  outbox: Loop;
  index?: Loop;
}

/**
 * Background sync for every connected account: Gmail polling, Tasks polling, outbox pushes and
 * indexing. Each account has its own loops, so one account's long first sync doesn't hold up
 * the others.
 */
export class SyncScheduler {
  private readonly accounts = new Map<string, AccountLoops>();
  private started = false;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly options: SyncSchedulerOptions) {}

  async start(): Promise<void> {
    // Ops left in_progress by a crash are safe to retry.
    const requeued = await this.options.repos.outbox.requeueInProgress();
    if (requeued > 0) this.options.logger.info({ requeued }, 'requeued interrupted outbox ops');
    const { events } = this.options;
    this.unsubscribers = [
      events.on('outbox.enqueued', ({ accountId }) => this.accounts.get(accountId)?.outbox.kick()),
      events.on('message.added', ({ accountId }) => this.accounts.get(accountId)?.index?.kick()),
      events.on('message.updated', ({ accountId }) => this.accounts.get(accountId)?.index?.kick()),
    ];
    this.started = true;
    for (const account of await this.options.repos.accounts.list()) this.addAccount(account.id);
  }

  /** Start background work for an account (e.g. one that just signed in); if running, sync now. */
  addAccount(accountId: string): void {
    if (!this.started) return;
    const running = this.accounts.get(accountId);
    if (running) {
      running.mail.kick();
      return;
    }
    const { options } = this;
    const indexer = options.indexer;
    const loops: AccountLoops = {
      mail: new Loop(
        () => this.run(accountId, 'mail', () => this.syncMail(accountId)),
        options.mailIntervalMs,
      ),
      tasks: new Loop(
        () =>
          this.run(accountId, 'tasks', async () => void (await options.tasksSync.sync(accountId))),
        options.tasksIntervalMs ?? 60_000,
      ),
      outbox: new Loop(
        () => this.run(accountId, 'outbox', () => this.drainOutbox(accountId)),
        options.outboxIntervalMs ?? 5000,
      ),
      ...(indexer && {
        index: new Loop(
          () =>
            this.run(accountId, 'index', async () => {
              try {
                await indexer.indexAll(accountId);
              } catch (err) {
                options.events.emit('index.status', {
                  accountId,
                  phase: 'error',
                  error: err instanceof Error ? err.message : String(err),
                });
                throw err;
              }
            }),
          // Fallback only (new mail wakes it); short so a failed batch (e.g. network) retries soon.
          options.indexIntervalMs ?? 60_000,
        ),
      }),
    };
    this.accounts.set(accountId, loops);
    loops.outbox.start();
    loops.mail.start();
    loops.tasks.start();
    loops.index?.start();
  }

  /** Stop an account's background work, waiting for what is running (e.g. before deleting it). */
  async removeAccount(accountId: string): Promise<void> {
    const loops = this.accounts.get(accountId);
    if (!loops) return;
    this.accounts.delete(accountId);
    await stopAll(loops);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribers.forEach((off) => off());
    const all = [...this.accounts.values()];
    this.accounts.clear();
    await Promise.all(all.map(stopAll));
  }

  /** Poll an account's Gmail now (e.g. the user pressed refresh). */
  syncNow(accountId: string): void {
    this.accounts.get(accountId)?.mail.kick();
  }

  private async syncMail(accountId: string): Promise<void> {
    await this.options.mailSync.sync(accountId);
    this.options.events.emit('sync.status', { accountId, phase: 'idle' });
  }

  private async drainOutbox(accountId: string): Promise<void> {
    // Pull right away so pushed changes (e.g. a sent message) show up without waiting a poll.
    if ((await this.options.outbox.drain(accountId)) > 0) this.syncNow(accountId);
  }

  /** One round of a loop; skipped while the account is signed out of Google, errors reported. */
  private async run(accountId: string, loop: string, fn: () => Promise<void>): Promise<void> {
    const { auth, events, logger } = this.options;
    try {
      if (!(await auth.isConnected(accountId))) return;
      await fn();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const phase = err instanceof ReauthRequiredError ? 'reauth_required' : 'error';
      events.emit('sync.status', { accountId, phase, error });
      logger.error({ err, accountId, loop }, 'sync loop failed');
    }
  }
}

const stopAll = (loops: AccountLoops) =>
  Promise.all([loops.mail.stop(), loops.tasks.stop(), loops.outbox.stop(), loops.index?.stop()]);
