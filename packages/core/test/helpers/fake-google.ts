import { HistoryExpiredError } from '../../src/google/errors.js';
import type {
  GatewayProvider,
  GmailGateway,
  GmailHistory,
  GmailLabel,
  GmailMessage,
  RemoteTask,
  TasksGateway,
} from '../../src/google/gateways.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export interface FakeMessageInput {
  id: string;
  threadId?: string;
  labelIds?: string[];
  subject?: string;
  from?: string;
  body?: string;
  date?: Date;
}

/** Error shaped like a googleapis HTTP error. */
export const googleError = (status: number, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { response: { status, data: {} } });

/**
 * In-memory Gmail with a history log, used to exercise sync end to end. Mutations made through the
 * helpers (web-side changes) and through the gateway (our pushes) both append history records.
 */
export class FakeGmail implements GmailGateway {
  historyId = 1000;
  readonly messages = new Map<string, { message: GmailMessage; labels: Set<string> }>();
  readonly history: { id: number; record: GmailHistory }[] = [];
  readonly labels: GmailLabel[] = [
    'INBOX',
    'UNREAD',
    'STARRED',
    'SENT',
    'DRAFT',
    'TRASH',
    'SPAM',
    'IMPORTANT',
  ].map((id) => ({ id, name: id, type: 'system' }));
  /** listHistory with a startHistoryId below this throws HistoryExpiredError. */
  expiredBefore = 0;
  pageSize = 2;
  readonly sent: { raw: string; threadId?: string }[] = [];
  readonly calls: Record<string, number> = {};
  /** Queue of errors thrown by the next calls of a method. */
  readonly failures: Record<string, unknown[]> = {};

  // --- web-side changes ---

  add(input: FakeMessageInput, recordHistory = true): void {
    const date = input.date ?? new Date();
    const labels = new Set(input.labelIds ?? ['INBOX', 'UNREAD']);
    this.messages.set(input.id, {
      labels,
      message: {
        id: input.id,
        threadId: input.threadId ?? `t-${input.id}`,
        internalDate: String(date.getTime()),
        snippet: input.body ?? '',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: input.from ?? 'Alice <alice@example.com>' },
            { name: 'To', value: 'me@example.com' },
            { name: 'Subject', value: input.subject ?? `Subject ${input.id}` },
          ],
          body: { data: b64(input.body ?? `body ${input.id}`) },
        },
      },
    });
    if (recordHistory) this.record({ messagesAdded: [{ message: { id: input.id } }] });
    else this.historyId++;
  }

  remove(id: string): void {
    this.messages.delete(id);
    this.record({ messagesDeleted: [{ message: { id } }] });
  }

  relabel(id: string, change: { add?: string[]; remove?: string[] }): void {
    const entry = this.messages.get(id);
    if (!entry) throw new Error(`no message ${id}`);
    const added = (change.add ?? []).filter((l) => !entry.labels.has(l));
    const removed = (change.remove ?? []).filter((l) => entry.labels.has(l));
    added.forEach((l) => entry.labels.add(l));
    removed.forEach((l) => entry.labels.delete(l));
    if (added.length) this.record({ labelsAdded: [{ message: { id }, labelIds: added }] });
    if (removed.length) this.record({ labelsRemoved: [{ message: { id }, labelIds: removed }] });
  }

  labelsOf(id: string): string[] {
    return [...(this.messages.get(id)?.labels ?? [])].sort();
  }

  // --- GmailGateway ---

  async getProfile() {
    this.track('getProfile');
    return { email: 'me@example.com', historyId: String(this.historyId) };
  }

  async listMessageIds({ query, pageToken }: { query?: string; pageToken?: string }) {
    this.track('listMessageIds');
    const after = /after:(\d+)/.exec(query ?? '')?.[1];
    const all = [...this.messages.values()]
      .filter((m) => !after || Number(m.message.internalDate) >= Number(after) * 1000)
      .filter((m) => !m.labels.has('TRASH') && !m.labels.has('SPAM'))
      .sort((a, b) => Number(b.message.internalDate) - Number(a.message.internalDate))
      .map((m) => m.message.id!);
    const offset = Number(pageToken ?? 0);
    const next = offset + this.pageSize;
    return {
      ids: all.slice(offset, next),
      ...(next < all.length && { nextPageToken: String(next) }),
    };
  }

  async getMessage(id: string) {
    this.track('getMessage');
    const entry = this.messages.get(id);
    return entry && { ...structuredClone(entry.message), labelIds: [...entry.labels] };
  }

  async listHistory({ startHistoryId, pageToken }: { startHistoryId: string; pageToken?: string }) {
    this.track('listHistory');
    if (Number(startHistoryId) < this.expiredBefore) throw new HistoryExpiredError('expired');
    const records = this.history.filter((h) => h.id > Number(startHistoryId));
    const offset = Number(pageToken ?? 0);
    const next = offset + this.pageSize;
    return {
      history: records.slice(offset, next).map((h) => h.record),
      historyId: String(this.historyId),
      ...(next < records.length && { nextPageToken: String(next) }),
    };
  }

  async listLabels() {
    this.track('listLabels');
    return structuredClone(this.labels);
  }

  async modifyMessages(ids: string[], change: { add?: string[]; remove?: string[] }) {
    this.track('modifyMessages');
    for (const id of ids) {
      if (!this.messages.has(id)) throw googleError(400, `Invalid id ${id}`);
    }
    for (const id of ids) this.relabel(id, change);
  }

  async sendMessage(raw: string, threadId?: string) {
    this.track('sendMessage');
    this.sent.push({ raw, threadId });
    const id = `sent-${this.sent.length}`;
    this.add({ id, threadId: threadId ?? `t-${id}`, labelIds: ['SENT'], subject: 'sent' });
    return { id, threadId: threadId ?? `t-${id}` };
  }

  private record(record: Omit<GmailHistory, 'id'>): void {
    this.historyId++;
    this.history.push({ id: this.historyId, record: { id: String(this.historyId), ...record } });
  }

  private track(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    const error = this.failures[method]?.shift();
    if (error) throw error;
  }
}

export class FakeTasks implements TasksGateway {
  readonly tasks = new Map<string, RemoteTask & { tasklistId: string; notes?: string }>();
  private seq = 0;
  readonly failures: Record<string, unknown[]> = {};

  async getDefaultTasklistId() {
    this.fail('getDefaultTasklistId');
    return 'list-default';
  }

  async createTask(tasklistId: string, task: { title: string; notes?: string; due?: Date }) {
    this.fail('createTask');
    const created = {
      id: `task-${++this.seq}`,
      tasklistId,
      title: task.title,
      notes: task.notes,
      status: 'needsAction' as const,
      due: task.due,
      deleted: false,
      updated: new Date(),
    };
    this.tasks.set(created.id, created);
    return created;
  }

  async deleteTask(_tasklistId: string, taskId: string) {
    this.fail('deleteTask');
    this.tasks.delete(taskId);
  }

  async listChangedTasks(tasklistId: string, updatedMin?: Date) {
    return [...this.tasks.values()].filter(
      (t) => t.tasklistId === tasklistId && (!updatedMin || t.updated >= updatedMin),
    );
  }

  /** Web-side edits. */
  complete(taskId: string): void {
    const task = this.tasks.get(taskId)!;
    Object.assign(task, { status: 'completed', completedAt: new Date(), updated: new Date() });
  }

  deleteRemotely(taskId: string): void {
    Object.assign(this.tasks.get(taskId)!, { deleted: true, updated: new Date() });
  }

  private fail(method: string): void {
    const error = this.failures[method]?.shift();
    if (error) throw error;
  }
}

export class FakeGateways implements GatewayProvider {
  readonly fakeGmail = new FakeGmail();
  readonly fakeTasks = new FakeTasks();
  /** Set to make every gateway lookup fail (e.g. ReauthRequiredError). */
  failWith?: unknown;

  async gmail() {
    if (this.failWith) throw this.failWith;
    return this.fakeGmail;
  }

  async tasks() {
    if (this.failWith) throw this.failWith;
    return this.fakeTasks;
  }
}
