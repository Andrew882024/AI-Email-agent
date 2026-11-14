import type { Label, MessageUpsert } from '../shared/types.js';
import type { OutboxPayloads } from './outbox-ops.js';
import type {
  LabelRepository,
  MessageRepository,
  OutboxRepository,
  TodoRepository,
} from './repositories.js';

/**
 * The mailbox as sync sees it: writes that apply Google's state locally, and the queue of local
 * changes to push. Nothing here queues a change for Google (it would echo back); local changes go
 * through MailboxService, which sync never gets.
 */
export interface MailboxMirror {
  listLabels(accountId: string): Promise<Label[]>;
  /** Make the stored labels exactly Gmail's. */
  replaceLabels(accountId: string, labels: Label[]): Promise<void>;
  /** Store messages as fetched from Gmail, keeping local changes that are still queued. */
  storeMessages(accountId: string, messages: MessageUpsert[]): Promise<void>;
  /** Apply label changes that happened in Gmail. */
  applyLabelChanges(
    accountId: string,
    messageIds: string[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  /** Re-apply queued local label changes over fresh Gmail state of these messages. */
  keepPendingChanges(accountId: string, messageIds: string[]): Promise<void>;
  deleteMessages(accountId: string, ids: string[]): Promise<void>;
  sweepStale: MessageRepository['sweepStale'];
  /** Todos as Google Tasks sees them (ids filled in, completion, deletion). */
  todos: Pick<TodoRepository, 'list' | 'getById' | 'update' | 'delete'>;
  /** The queue of local changes waiting to be pushed to Google. */
  outbox: Pick<
    OutboxRepository,
    'claimNext' | 'markDone' | 'markRetry' | 'markFailed' | 'requeueInProgress'
  >;
}

export function createMailboxMirror(repos: {
  messages: MessageRepository;
  labels: LabelRepository;
  todos: TodoRepository;
  outbox: OutboxRepository;
}): MailboxMirror {
  const { messages, labels, outbox } = repos;

  /** Fresh Gmail state may predate queued local changes; re-apply them so the UI doesn't flicker. */
  async function keepPendingChanges(accountId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const touched = new Set(ids);
    for (const op of await outbox.listActive(accountId)) {
      if (op.op !== 'modify_labels') continue;
      const payload = op.payload as OutboxPayloads['modify_labels'];
      const hit = payload.messageIds.filter((id) => touched.has(id));
      if (hit.length > 0) {
        await messages.modifyLabels(accountId, hit, { add: payload.add, remove: payload.remove });
      }
    }
  }

  return {
    listLabels: (accountId) => labels.list(accountId),
    replaceLabels: (accountId, all) => labels.replaceAll(accountId, all),
    async storeMessages(accountId, fetched) {
      await messages.upsertMany(accountId, fetched);
      await keepPendingChanges(
        accountId,
        fetched.map((m) => m.id),
      );
    },
    applyLabelChanges: (accountId, ids, change) => messages.modifyLabels(accountId, ids, change),
    keepPendingChanges,
    deleteMessages: (accountId, ids) => messages.deleteMany(accountId, ids),
    sweepStale: (accountId, options) => messages.sweepStale(accountId, options),
    todos: repos.todos,
    outbox,
  };
}
