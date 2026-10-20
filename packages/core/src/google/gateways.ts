import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { tasks, type tasks_v1 } from '@googleapis/tasks';
import type { OAuth2Client } from 'google-auth-library';
import { isInvalidGrantError, ReauthRequiredError } from '../auth/errors.js';
import type { GoogleAuthProvider } from '../auth/google-auth.js';
import type { TodoStatus } from '../domain/types.js';
import { HistoryExpiredError, httpStatus, isNotFound, isRateLimitError } from './errors.js';
import { QuotaLimiter, type RetryOptions, withRetry } from './retry.js';

export type GmailMessage = gmail_v1.Schema$Message;
export type GmailHistory = gmail_v1.Schema$History;
export type GmailLabel = gmail_v1.Schema$Label;

/** The Gmail operations the app uses. Implemented over googleapis; faked in tests. */
export interface GmailGateway {
  getProfile(): Promise<{ email: string; historyId: string }>;
  /** Ids only, newest first. `query` uses Gmail search syntax. */
  listMessageIds(params: {
    query?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ ids: string[]; nextPageToken?: string }>;
  /** Full message, or undefined if it no longer exists. */
  getMessage(id: string): Promise<GmailMessage | undefined>;
  /** Throws HistoryExpiredError when startHistoryId is too old. */
  listHistory(params: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<{ history: GmailHistory[]; historyId: string; nextPageToken?: string }>;
  listLabels(): Promise<GmailLabel[]>;
  modifyMessages(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void>;
  /** `raw` is the complete RFC 5322 message. */
  sendMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }>;
}

export interface RemoteTask {
  id: string;
  title: string;
  status: TodoStatus;
  due?: Date;
  completedAt?: Date;
  deleted: boolean;
  updated: Date;
}

export interface TasksGateway {
  getDefaultTasklistId(): Promise<string>;
  createTask(
    tasklistId: string,
    task: { title: string; notes?: string; due?: Date },
  ): Promise<RemoteTask>;
  /** Succeeds if the task is already gone. */
  deleteTask(tasklistId: string, taskId: string): Promise<void>;
  /** Tasks changed since `updatedMin` (all when omitted), including completed and deleted ones. */
  listChangedTasks(tasklistId: string, updatedMin?: Date): Promise<RemoteTask[]>;
}

/** Hands out gateways bound to an account's credentials. */
export interface GatewayProvider {
  gmail(accountId: string): Promise<GmailGateway>;
  tasks(accountId: string): Promise<TasksGateway>;
}

/** Gmail quota units per call (developers.google.com/gmail/api/reference/quota). */
const GMAIL_COST = {
  getProfile: 1,
  listMessages: 5,
  getMessage: 5,
  listHistory: 2,
  listLabels: 1,
  batchModify: 50,
  send: 100,
} as const;

/**
 * Wraps a Google call: waits for quota (when a limiter is given), retries transient failures, and
 * on invalid_grant forgets the token and throws ReauthRequiredError so callers can surface
 * "reconnect" instead of failing repeatedly.
 */
function caller(
  auth: GoogleAuthProvider,
  accountId: string,
  retry?: RetryOptions,
  limiter?: QuotaLimiter,
) {
  return async <T>(fn: () => Promise<T>, cost = 0): Promise<T> => {
    try {
      return await withRetry(async () => {
        if (!limiter || cost === 0) return fn();
        await limiter.take(cost);
        try {
          const result = await fn();
          limiter.recover();
          return result;
        } catch (err) {
          if (isRateLimitError(err)) limiter.backoff();
          throw err;
        }
      }, retry);
    } catch (err) {
      if (isInvalidGrantError(err)) {
        await auth.invalidate(accountId);
        throw new ReauthRequiredError(accountId, 'Google sign-in expired or was revoked');
      }
      throw err;
    }
  };
}

class GoogleGmailGateway implements GmailGateway {
  private readonly api: gmail_v1.Gmail;

  constructor(
    client: OAuth2Client,
    private readonly call: ReturnType<typeof caller>,
  ) {
    this.api = gmail({ version: 'v1', auth: client });
  }

  async getProfile() {
    const { data } = await this.call(
      () => this.api.users.getProfile({ userId: 'me' }),
      GMAIL_COST.getProfile,
    );
    return { email: data.emailAddress ?? '', historyId: data.historyId ?? '' };
  }

  async listMessageIds(params: { query?: string; pageToken?: string; maxResults?: number }) {
    const { data } = await this.call(
      () =>
        this.api.users.messages.list({
          userId: 'me',
          q: params.query,
          pageToken: params.pageToken,
          maxResults: params.maxResults ?? 500,
        }),
      GMAIL_COST.listMessages,
    );
    return {
      ids: (data.messages ?? []).flatMap((m) => (m.id ? [m.id] : [])),
      nextPageToken: data.nextPageToken ?? undefined,
    };
  }

  async getMessage(id: string) {
    try {
      const { data } = await this.call(
        () => this.api.users.messages.get({ userId: 'me', id, format: 'full' }),
        GMAIL_COST.getMessage,
      );
      return data;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async listHistory(params: { startHistoryId: string; pageToken?: string }) {
    try {
      const { data } = await this.call(
        () =>
          this.api.users.history.list({
            userId: 'me',
            startHistoryId: params.startHistoryId,
            pageToken: params.pageToken,
            maxResults: 500,
            historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
          }),
        GMAIL_COST.listHistory,
      );
      return {
        history: data.history ?? [],
        historyId: data.historyId ?? params.startHistoryId,
        nextPageToken: data.nextPageToken ?? undefined,
      };
    } catch (err) {
      if (isNotFound(err))
        throw new HistoryExpiredError(`history ${params.startHistoryId} expired`);
      throw err;
    }
  }

  async listLabels() {
    const { data } = await this.call(
      () => this.api.users.labels.list({ userId: 'me' }),
      GMAIL_COST.listLabels,
    );
    return data.labels ?? [];
  }

  async modifyMessages(ids: string[], change: { add?: string[]; remove?: string[] }) {
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      await this.call(
        () =>
          this.api.users.messages.batchModify({
            userId: 'me',
            requestBody: { ids: batch, addLabelIds: change.add, removeLabelIds: change.remove },
          }),
        GMAIL_COST.batchModify,
      );
    }
  }

  async sendMessage(raw: string, threadId?: string) {
    const { data } = await this.call(
      () =>
        this.api.users.messages.send({
          userId: 'me',
          requestBody: { raw: Buffer.from(raw).toString('base64url'), threadId },
        }),
      GMAIL_COST.send,
    );
    return { id: data.id ?? '', threadId: data.threadId ?? '' };
  }
}

function toRemoteTask(task: tasks_v1.Schema$Task): RemoteTask {
  return {
    id: task.id ?? '',
    title: task.title ?? '',
    status: task.status === 'completed' ? 'completed' : 'needsAction',
    due: task.due ? new Date(task.due) : undefined,
    completedAt: task.completed ? new Date(task.completed) : undefined,
    deleted: task.deleted === true,
    updated: new Date(task.updated ?? Date.now()),
  };
}

class GoogleTasksGateway implements TasksGateway {
  private readonly api: tasks_v1.Tasks;

  constructor(
    client: OAuth2Client,
    private readonly call: ReturnType<typeof caller>,
  ) {
    this.api = tasks({ version: 'v1', auth: client });
  }

  async getDefaultTasklistId() {
    const { data } = await this.call(() => this.api.tasklists.get({ tasklist: '@default' }));
    if (!data.id) throw new Error('Google Tasks returned no default task list');
    return data.id;
  }

  async createTask(tasklistId: string, task: { title: string; notes?: string; due?: Date }) {
    const { data } = await this.call(() =>
      this.api.tasks.insert({
        tasklist: tasklistId,
        requestBody: { title: task.title, notes: task.notes, due: task.due?.toISOString() },
      }),
    );
    return toRemoteTask(data);
  }

  async deleteTask(tasklistId: string, taskId: string) {
    try {
      await this.call(() => this.api.tasks.delete({ tasklist: tasklistId, task: taskId }));
    } catch (err) {
      if (!isNotFound(err) && httpStatus(err) !== 410) throw err;
    }
  }

  async listChangedTasks(tasklistId: string, updatedMin?: Date) {
    const result: RemoteTask[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.call(() =>
        this.api.tasks.list({
          tasklist: tasklistId,
          updatedMin: updatedMin?.toISOString(),
          showCompleted: true,
          showHidden: true,
          showDeleted: true,
          maxResults: 100,
          pageToken,
        }),
      );
      result.push(...(data.items ?? []).map(toRemoteTask));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return result;
  }
}

export interface GoogleGatewayOptions {
  retry?: RetryOptions;
  /**
   * The GCP project's Gmail "units per minute per user" quota (Google's default is 15,000; check
   * APIs & Services → Gmail API → Quotas). 80% of it is used, leaving room for other clients.
   */
  gmailUnitsPerMinute?: number;
}

/** Production GatewayProvider: googleapis clients authorized through the auth module. */
export class GoogleGatewayProvider implements GatewayProvider {
  /** One budget per account, shared by every gateway instance handed out for it. */
  private readonly limiters = new Map<string, QuotaLimiter>();

  constructor(
    private readonly auth: GoogleAuthProvider,
    private readonly options: GoogleGatewayOptions = {},
  ) {}

  async gmail(accountId: string): Promise<GmailGateway> {
    let limiter = this.limiters.get(accountId);
    if (!limiter) {
      limiter = QuotaLimiter.perMinute(this.options.gmailUnitsPerMinute ?? 15_000);
      this.limiters.set(accountId, limiter);
    }
    const call = caller(this.auth, accountId, this.options.retry, limiter);
    return new GoogleGmailGateway(await call(() => this.auth.getClient(accountId)), call);
  }

  async tasks(accountId: string): Promise<TasksGateway> {
    const call = caller(this.auth, accountId, this.options.retry);
    return new GoogleTasksGateway(await call(() => this.auth.getClient(accountId)), call);
  }
}
