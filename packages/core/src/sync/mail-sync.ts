import type { Repositories } from '../db/repositories.js';
import type { FullSyncCheckpoint } from '../domain/types.js';
import type { EventBus } from '../events/event-bus.js';
import { HistoryExpiredError } from '../google/errors.js';
import type { GatewayProvider, GmailGateway } from '../google/gateways.js';
import { mapLimit } from '../google/retry.js';
import type { ActionLogger } from '../logging/action-logger.js';
import type { Logger } from '../logging/system-logger.js';
import type { OutboxPayloads } from './outbox-ops.js';
import { parseGmailLabel, parseGmailMessage } from './parse-message.js';

export interface MailSyncOptions {
  repos: Repositories;
  gateways: GatewayProvider;
  events: EventBus;
  actions: ActionLogger;
  logger: Logger;
  /** Full sync covers the last N days; 0 = whole mailbox. */
  windowDays: number;
  /** Parallel messages.get calls (each costs 5 of the 250 quota units/user/second). */
  fetchConcurrency?: number;
  now?: () => Date;
}

export type SyncResult =
  | { kind: 'full'; synced: number; deleted: number }
  | { kind: 'incremental'; added: number; updated: number; deleted: number };

const DAY_MS = 86_400_000;

/** Gmail → local mirror: labels, resumable full sync, and history-based incremental sync. */
export class MailSync {
  private readonly now: () => Date;

  constructor(private readonly options: MailSyncOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** One pass: refresh labels, then continue/start a full sync or apply new history. */
  async sync(accountId: string): Promise<SyncResult> {
    const { repos } = this.options;
    const gmail = await this.options.gateways.gmail(accountId);
    await this.syncLabels(accountId, gmail);

    const account = await repos.accounts.getById(accountId);
    if (!account) throw new Error(`Unknown account ${accountId}`);
    const { fullSync } = await repos.syncState.get(accountId);
    if (fullSync) return this.runFullSync(accountId, gmail, fullSync);
    if (!account.historyId)
      return this.runFullSync(accountId, gmail, await this.startFullSync(accountId, gmail));
    try {
      return await this.incrementalSync(accountId, gmail, account.historyId);
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
      this.options.logger.warn({ accountId }, 'Gmail history expired; running a full resync');
      return this.runFullSync(accountId, gmail, await this.startFullSync(accountId, gmail));
    }
  }

  /**
   * End an in-progress full sync where it is: keep what was synced (the newest mail, since Gmail
   * lists newest first) and switch to incremental sync from the history id captured when the full
   * sync began. Nothing is swept. Returns false if no full sync was in progress.
   */
  async finishFullSyncEarly(accountId: string): Promise<boolean> {
    const { repos } = this.options;
    const { fullSync } = await repos.syncState.get(accountId);
    if (!fullSync) return false;
    await repos.accounts.updateSyncState(accountId, {
      historyId: fullSync.historyId,
      lastFullSyncAt: this.now(),
    });
    await repos.syncState.update(accountId, { fullSync: null });
    await this.options.actions.log({
      accountId,
      actor: 'user',
      action: 'sync.full.finish_early',
      params: { synced: fullSync.synced, windowStart: fullSync.windowStart },
      status: 'success',
    });
    return true;
  }

  /** Re-read messages from Gmail (the source of truth); ones gone from Gmail are deleted locally. */
  async refreshMessages(accountId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const gmail = await this.options.gateways.gmail(accountId);
    const stored = new Set(await this.fetchAndStore(accountId, gmail, ids));
    const gone = ids.filter((id) => !stored.has(id));
    await this.options.repos.messages.deleteMany(accountId, gone);
    this.emitIfAny('message.updated', accountId, [...stored]);
    this.emitIfAny('message.deleted', accountId, gone);
  }

  private async syncLabels(accountId: string, gmail: GmailGateway): Promise<void> {
    const { repos, events } = this.options;
    const remote = (await gmail.listLabels()).flatMap((l) => parseGmailLabel(l) ?? []);
    const local = await repos.labels.list(accountId);
    const key = (labels: typeof remote) =>
      JSON.stringify([...labels].sort((a, b) => a.id.localeCompare(b.id)));
    if (key(remote) === key(local)) return;
    await repos.labels.replaceAll(accountId, remote);
    events.emit('labels.changed', { accountId });
  }

  private async startFullSync(accountId: string, gmail: GmailGateway): Promise<FullSyncCheckpoint> {
    const { windowDays } = this.options;
    // Capture historyId before listing so changes made during the sync are replayed afterwards.
    const { historyId } = await gmail.getProfile();
    return this.options.repos.syncState.beginFullSync(accountId, {
      historyId,
      ...(windowDays > 0 && {
        windowStart: new Date(this.now().getTime() - windowDays * DAY_MS),
      }),
    });
  }

  private async runFullSync(
    accountId: string,
    gmail: GmailGateway,
    checkpoint: FullSyncCheckpoint,
  ): Promise<SyncResult> {
    const { repos, events } = this.options;
    const started = performance.now();
    const query = checkpoint.windowStart
      ? `after:${Math.floor(checkpoint.windowStart.getTime() / 1000)}`
      : undefined;
    let cp = checkpoint;
    events.emit('sync.status', { accountId, phase: 'full_sync', synced: cp.synced });

    do {
      // Small pages: at low quota a page takes a while, and a restart re-fetches at most one.
      const page = await gmail.listMessageIds({ query, pageToken: cp.pageToken, maxResults: 100 });
      const stored = await this.fetchAndStore(accountId, gmail, page.ids);
      cp = { ...cp, pageToken: page.nextPageToken, synced: cp.synced + stored.length };
      // Checkpoint after every page so a restart resumes here.
      if (cp.pageToken) await repos.syncState.update(accountId, { fullSync: cp });
      // Backfilled mail is not "new mail", so this is message.updated rather than message.added.
      this.emitIfAny('message.updated', accountId, stored);
      events.emit('sync.status', { accountId, phase: 'full_sync', synced: cp.synced });
    } while (cp.pageToken);

    await repos.accounts.updateSyncState(accountId, {
      historyId: cp.historyId,
      lastFullSyncAt: this.now(),
    });
    await repos.syncState.update(accountId, { fullSync: null });
    // Anything in the window that this pass didn't refresh no longer exists in Gmail.
    const deleted = await repos.messages.sweepStale(accountId, {
      updatedBefore: cp.startedAt,
      receivedSince: cp.windowStart,
    });
    this.emitIfAny('message.deleted', accountId, deleted);
    await this.options.actions.log({
      accountId,
      actor: 'sync',
      action: 'sync.full',
      params: { synced: cp.synced, deleted: deleted.length, windowStart: cp.windowStart },
      status: 'success',
      durationMs: Math.round(performance.now() - started),
    });
    events.emit('sync.status', { accountId, phase: 'idle' });
    return { kind: 'full', synced: cp.synced, deleted: deleted.length };
  }

  private async incrementalSync(
    accountId: string,
    gmail: GmailGateway,
    startHistoryId: string,
  ): Promise<SyncResult> {
    const { repos } = this.options;
    const started = performance.now();
    const added = new Set<string>();
    const deleted = new Set<string>();
    const relabeled = new Set<string>();
    let latest: string;
    let pageToken: string | undefined;

    do {
      const page = await gmail.listHistory({ startHistoryId, pageToken });
      for (const record of page.history) {
        for (const { message } of record.messagesAdded ?? []) {
          if (!message?.id) continue;
          added.add(message.id);
          deleted.delete(message.id);
        }
        for (const { message } of record.messagesDeleted ?? []) {
          if (!message?.id) continue;
          deleted.add(message.id);
          added.delete(message.id);
          relabeled.delete(message.id);
        }
        // Label deltas are applied in history order; unknown (not yet stored) ids are ignored and
        // get their current labels when fetched below.
        for (const { message, labelIds } of record.labelsAdded ?? []) {
          if (!message?.id || deleted.has(message.id) || !labelIds?.length) continue;
          await repos.messages.modifyLabels(accountId, [message.id], { add: labelIds });
          relabeled.add(message.id);
        }
        for (const { message, labelIds } of record.labelsRemoved ?? []) {
          if (!message?.id || deleted.has(message.id) || !labelIds?.length) continue;
          await repos.messages.modifyLabels(accountId, [message.id], { remove: labelIds });
          relabeled.add(message.id);
        }
      }
      latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);

    const stored = await this.fetchAndStore(accountId, gmail, [...added]);
    await repos.messages.deleteMany(accountId, [...deleted]);
    const updated = [...relabeled].filter((id) => !added.has(id));
    await this.reapplyPending(accountId, updated);
    await repos.accounts.updateSyncState(accountId, { historyId: latest });

    this.emitIfAny('message.added', accountId, stored);
    this.emitIfAny('message.updated', accountId, updated);
    this.emitIfAny('message.deleted', accountId, [...deleted]);
    if (stored.length + updated.length + deleted.size > 0) {
      await this.options.actions.log({
        accountId,
        actor: 'sync',
        action: 'sync.incremental',
        params: { added: stored.length, updated: updated.length, deleted: deleted.size },
        status: 'success',
        durationMs: Math.round(performance.now() - started),
      });
    }
    return {
      kind: 'incremental',
      added: stored.length,
      updated: updated.length,
      deleted: deleted.size,
    };
  }

  /** Fetch full messages and store them. Returns the ids stored (missing/unparseable ones skipped). */
  private async fetchAndStore(
    accountId: string,
    gmail: GmailGateway,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const raw = await mapLimit(ids, this.options.fetchConcurrency ?? 10, (id) =>
      gmail.getMessage(id),
    );
    const parsed = raw.flatMap((message) => {
      if (!message) return []; // deleted since it was listed
      try {
        return [parseGmailMessage(message)];
      } catch (err) {
        this.options.logger.warn(
          { err, accountId, messageId: message.id },
          'skipping unparseable message',
        );
        return [];
      }
    });
    await this.options.repos.messages.upsertMany(accountId, parsed);
    const storedIds = parsed.map((m) => m.id);
    await this.reapplyPending(accountId, storedIds);
    return storedIds;
  }

  /**
   * Fresh Gmail state may predate local changes still queued in the outbox; re-apply those so the
   * UI doesn't flicker back to the old state before the push lands.
   */
  private async reapplyPending(accountId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const touched = new Set(ids);
    for (const op of await this.options.repos.outbox.listActive(accountId)) {
      if (op.op !== 'modify_labels') continue;
      const payload = op.payload as OutboxPayloads['modify_labels'];
      const hit = payload.messageIds.filter((id) => touched.has(id));
      if (hit.length > 0) {
        await this.options.repos.messages.modifyLabels(accountId, hit, {
          add: payload.add,
          remove: payload.remove,
        });
      }
    }
  }

  private emitIfAny(
    event: 'message.added' | 'message.updated' | 'message.deleted',
    accountId: string,
    messageIds: string[],
  ): void {
    if (messageIds.length > 0) this.options.events.emit(event, { accountId, messageIds });
  }
}
