import { Readable } from 'node:stream';
import { docs, type docs_v1 } from '@googleapis/docs';
import { drive, type drive_v3 } from '@googleapis/drive';
import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { sheets, type sheets_v4 } from '@googleapis/sheets';
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
  createLabel(name: string): Promise<GmailLabel>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
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

export interface DriveFile {
  id: string;
  /** Where the user opens it. */
  url: string;
}

/** One email's entry in a Google Doc: a heading, "label: value" lines and a link. */
export interface DocSection {
  heading: string;
  fields: { label: string; value: string }[];
  link?: { text: string; url: string };
}

/**
 * Google Drive / Sheets / Docs operations for workflow documents. With the drive.file scope the app
 * only sees files it created itself.
 */
export interface DocumentsGateway {
  /** The folder with this name that the app created (created now if there is none). */
  ensureFolder(name: string): Promise<string>;
  /** A new, empty Google Sheet or Doc in the folder. */
  createFile(kind: 'spreadsheet' | 'document', title: string, folderId: string): Promise<DriveFile>;
  /** Append rows to the first sheet. Values are stored as typed, never parsed as formulas. */
  appendRows(spreadsheetId: string, rows: string[][]): Promise<void>;
  /** Make the first row of the first sheet a bold, frozen header. */
  formatHeader(spreadsheetId: string): Promise<void>;
  /** Every row of the first sheet. */
  readRows(spreadsheetId: string): Promise<string[][]>;
  /** Delete a row (0-based) of the first sheet. */
  deleteRow(spreadsheetId: string, index: number): Promise<void>;
  /** Append sections at the end of a Doc, after an optional title. */
  appendSections(documentId: string, sections: DocSection[], title?: string): Promise<void>;
  /** Export a Doc as PDF: into `fileId` (replacing its content) or a new file in the folder. */
  savePdf(
    documentId: string,
    target: { name: string; folderId: string; fileId?: string },
  ): Promise<DriveFile>;
}

/** Hands out gateways bound to an account's credentials. */
export interface GatewayProvider {
  gmail(accountId: string): Promise<GmailGateway>;
  tasks(accountId: string): Promise<TasksGateway>;
  documents(accountId: string): Promise<DocumentsGateway>;
}

/** Gmail quota units per call (developers.google.com/gmail/api/reference/quota). */
const GMAIL_COST = {
  getProfile: 1,
  listMessages: 5,
  getMessage: 5,
  listHistory: 2,
  listLabels: 1,
  createLabel: 5,
  getAttachment: 5,
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

  async createLabel(name: string) {
    const { data } = await this.call(
      () =>
        this.api.users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        }),
      GMAIL_COST.createLabel,
    );
    return data;
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const { data } = await this.call(
      () => this.api.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }),
      GMAIL_COST.getAttachment,
    );
    return Buffer.from(data.data ?? '', 'base64url');
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

const MIME = {
  folder: 'application/vnd.google-apps.folder',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  document: 'application/vnd.google-apps.document',
  pdf: 'application/pdf',
} as const;

/** Text the Docs API accepts: no control characters other than newlines. */
const docText = (s: string) =>
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ');

class GoogleDocumentsGateway implements DocumentsGateway {
  private readonly drive: drive_v3.Drive;
  private readonly sheets: sheets_v4.Sheets;
  private readonly docs: docs_v1.Docs;

  constructor(
    client: OAuth2Client,
    private readonly call: ReturnType<typeof caller>,
  ) {
    this.drive = drive({ version: 'v3', auth: client });
    this.sheets = sheets({ version: 'v4', auth: client });
    this.docs = docs({ version: 'v1', auth: client });
  }

  async ensureFolder(name: string) {
    const quoted = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { data } = await this.call(() =>
      this.drive.files.list({
        q: `mimeType = '${MIME.folder}' and name = '${quoted}' and trashed = false`,
        fields: 'files(id)',
        spaces: 'drive',
        pageSize: 1,
      }),
    );
    const existing = data.files?.[0]?.id;
    if (existing) return existing;
    const created = await this.call(() =>
      this.drive.files.create({ requestBody: { name, mimeType: MIME.folder }, fields: 'id' }),
    );
    return created.data.id ?? '';
  }

  async createFile(kind: 'spreadsheet' | 'document', title: string, folderId: string) {
    const { data } = await this.call(() =>
      this.drive.files.create({
        requestBody: { name: title, mimeType: MIME[kind], parents: [folderId] },
        fields: 'id,webViewLink',
      }),
    );
    return { id: data.id ?? '', url: data.webViewLink ?? '' };
  }

  private async firstSheetId(spreadsheetId: string): Promise<number> {
    const { data } = await this.call(() =>
      this.sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.sheetId' }),
    );
    return data.sheets?.[0]?.properties?.sheetId ?? 0;
  }

  async appendRows(spreadsheetId: string, rows: string[][]) {
    if (rows.length === 0) return;
    await this.call(() =>
      this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'A1',
        valueInputOption: 'RAW', // "=..." stays text: email content must never become a formula
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      }),
    );
  }

  async formatHeader(spreadsheetId: string) {
    const sheetId = await this.firstSheetId(spreadsheetId);
    await this.call(() =>
      this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: 'gridProperties.frozenRowCount',
              },
            },
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        },
      }),
    );
  }

  async readRows(spreadsheetId: string) {
    const { data } = await this.call(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId, range: 'A:ZZ' }),
    );
    return (data.values ?? []).map((row) => row.map((v) => String(v ?? '')));
  }

  async deleteRow(spreadsheetId: string, index: number) {
    const sheetId = await this.firstSheetId(spreadsheetId);
    await this.call(() =>
      this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: { sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 },
              },
            },
          ],
        },
      }),
    );
  }

  async appendSections(documentId: string, sections: DocSection[], title?: string) {
    const { data } = await this.call(() =>
      this.docs.documents.get({ documentId, fields: 'body.content(endIndex)' }),
    );
    const start = (data.body?.content?.at(-1)?.endIndex ?? 2) - 1;
    // Build the text, remembering the ranges to style. Docs indexes count UTF-16 code units, like JS.
    let text = '';
    const paragraphs: { start: number; end: number; style: string }[] = [];
    const bold: { start: number; end: number }[] = [];
    const links: { start: number; end: number; url: string }[] = [];
    const add = (s: string) => {
      const from = start + text.length;
      text += s;
      return { start: from, end: start + text.length };
    };
    if (title) paragraphs.push({ ...add(`${docText(title)}\n`), style: 'TITLE' });
    for (const section of sections) {
      paragraphs.push({ ...add(`${docText(section.heading)}\n`), style: 'HEADING_2' });
      for (const field of section.fields) {
        bold.push(add(`${docText(field.label)}:`));
        add(` ${docText(field.value) || '—'}\n`);
      }
      if (section.link) {
        links.push({ ...add(docText(section.link.text)), url: section.link.url });
        add('\n');
      }
    }
    if (!text) return;
    const all = { startIndex: start, endIndex: start + text.length };
    const requests: docs_v1.Schema$Request[] = [
      { insertText: { location: { index: start }, text } },
      // Inserted text inherits the style around it (e.g. a previous link); reset it first.
      {
        updateParagraphStyle: {
          range: all,
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      { updateTextStyle: { range: all, textStyle: {}, fields: 'bold,link' } },
      ...paragraphs.map((p) => ({
        updateParagraphStyle: {
          range: { startIndex: p.start, endIndex: p.end },
          paragraphStyle: { namedStyleType: p.style },
          fields: 'namedStyleType',
        },
      })),
      ...bold.map((b) => ({
        updateTextStyle: {
          range: { startIndex: b.start, endIndex: b.end },
          textStyle: { bold: true },
          fields: 'bold',
        },
      })),
      ...links.map((l) => ({
        updateTextStyle: {
          range: { startIndex: l.start, endIndex: l.end },
          textStyle: { link: { url: l.url } },
          fields: 'link',
        },
      })),
    ];
    await this.call(() =>
      this.docs.documents.batchUpdate({ documentId, requestBody: { requests } }),
    );
  }

  async savePdf(documentId: string, target: { name: string; folderId: string; fileId?: string }) {
    const { data: pdf } = await this.call(() =>
      this.drive.files.export(
        { fileId: documentId, mimeType: MIME.pdf },
        { responseType: 'arraybuffer' },
      ),
    );
    const media = () => ({
      mimeType: MIME.pdf,
      body: Readable.from([Buffer.from(pdf as ArrayBuffer)]),
    });
    if (target.fileId) {
      try {
        const { data } = await this.call(() =>
          this.drive.files.update({
            fileId: target.fileId,
            media: media(),
            fields: 'id,webViewLink',
          }),
        );
        return { id: data.id ?? '', url: data.webViewLink ?? '' };
      } catch (err) {
        if (!isNotFound(err)) throw err; // deleted by the user: write a new one
      }
    }
    const { data } = await this.call(() =>
      this.drive.files.create({
        requestBody: { name: target.name, mimeType: MIME.pdf, parents: [target.folderId] },
        media: media(),
        fields: 'id,webViewLink',
      }),
    );
    return { id: data.id ?? '', url: data.webViewLink ?? '' };
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

  async documents(accountId: string): Promise<DocumentsGateway> {
    const call = caller(this.auth, accountId, this.options.retry);
    return new GoogleDocumentsGateway(await call(() => this.auth.getClient(accountId)), call);
  }
}
