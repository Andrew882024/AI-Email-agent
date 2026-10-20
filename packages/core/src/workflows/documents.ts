import type { DocumentAction, DocumentFormat } from '../domain/types.js';
import type { DocSection, GatewayProvider } from '../google/gateways.js';

/** The Drive folder that holds every workflow document. */
export const DRIVE_FOLDER = 'AI Email Agent';

/** One matching email, as recorded in a document. */
export interface DocumentEntry {
  messageId: string;
  received: Date;
  subject: string;
  from?: string;
  /** Opens the email in Gmail; also identifies the entry for removal. */
  link: string;
  /** Extracted values, by field name. */
  values: Record<string, string>;
}

/** Where document workflows write. Google Drive today; a local-file implementation can follow. */
export interface DocumentSink {
  /** Create the (empty) document. Returns the action with its ids and links filled in. */
  create(accountId: string, action: DocumentAction): Promise<DocumentAction>;
  /** Append entries in the given order. Returns the action, with links updated if they changed. */
  append(
    accountId: string,
    action: DocumentAction,
    entries: DocumentEntry[],
  ): Promise<DocumentAction>;
  /** Whether one email's entry can be removed again (undo). */
  canRemove(format: DocumentFormat): boolean;
  /** Remove the entry with this link; false when there was none. */
  remove(accountId: string, action: DocumentAction, link: string): Promise<boolean>;
}

/** Sheet columns: the extracted fields between when it arrived and what it is. */
export const documentColumns = (action: Pick<DocumentAction, 'fields'>) => [
  'Received',
  ...action.fields.map((f) => f.name),
  'Subject',
  'From',
  'Email',
];

/** "YYYY-MM-DD HH:mm" in local time: the app runs on the user's machine. */
export function localDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Sheets get one row per email. Docs get one section per email. A PDF is exported from a Google
 * Doc kept next to it, and re-exported into the same Drive file after every append, so its link
 * stays the same.
 */
export class GoogleDriveDocumentSink implements DocumentSink {
  constructor(
    private readonly gateways: GatewayProvider,
    private readonly folderName = DRIVE_FOLDER,
  ) {}

  async create(accountId: string, action: DocumentAction): Promise<DocumentAction> {
    const drive = await this.gateways.documents(accountId);
    const folderId = await drive.ensureFolder(this.folderName);
    switch (action.format) {
      case 'sheet': {
        const file = await drive.createFile('spreadsheet', action.title, folderId);
        await drive.appendRows(file.id, [documentColumns(action)]);
        await drive.formatHeader(file.id);
        return { ...action, folderId, documentId: file.id, url: file.url };
      }
      case 'doc': {
        const file = await drive.createFile('document', action.title, folderId);
        await drive.appendSections(file.id, [], action.title);
        return { ...action, folderId, documentId: file.id, url: file.url };
      }
      case 'pdf': {
        const file = await drive.createFile('document', `${action.title} (PDF source)`, folderId);
        await drive.appendSections(file.id, [], action.title);
        const pdf = await drive.savePdf(file.id, { name: `${action.title}.pdf`, folderId });
        return {
          ...action,
          folderId,
          documentId: file.id,
          url: file.url,
          pdfFileId: pdf.id,
          pdfUrl: pdf.url,
        };
      }
    }
  }

  async append(
    accountId: string,
    action: DocumentAction,
    entries: DocumentEntry[],
  ): Promise<DocumentAction> {
    if (entries.length === 0) return action;
    const drive = await this.gateways.documents(accountId);
    const documentId = action.documentId!;
    if (action.format === 'sheet') {
      await drive.appendRows(
        documentId,
        entries.map((e) => [
          localDateTime(e.received),
          ...action.fields.map((f) => e.values[f.name] ?? ''),
          e.subject,
          e.from ?? '',
          e.link,
        ]),
      );
      return action;
    }
    const sections: DocSection[] = entries.map((e) => ({
      heading: e.subject || '(no subject)',
      fields: [
        { label: 'Received', value: localDateTime(e.received) },
        ...action.fields.map((f) => ({ label: f.name, value: e.values[f.name] ?? '' })),
        { label: 'From', value: e.from ?? '' },
      ],
      link: { text: 'Open in Gmail', url: e.link },
    }));
    await drive.appendSections(documentId, sections);
    if (action.format === 'doc') return action;
    const pdf = await drive.savePdf(documentId, {
      name: `${action.title}.pdf`,
      folderId: action.folderId!,
      fileId: action.pdfFileId,
    });
    return pdf.id === action.pdfFileId ? action : { ...action, pdfFileId: pdf.id, pdfUrl: pdf.url };
  }

  canRemove(format: DocumentFormat): boolean {
    // Sections in a Doc can't be found reliably once the user has edited it; rows can (by link).
    return format === 'sheet';
  }

  async remove(accountId: string, action: DocumentAction, link: string): Promise<boolean> {
    if (!this.canRemove(action.format))
      throw new Error(`Can't remove entries from a ${action.format}`);
    const drive = await this.gateways.documents(accountId);
    const rows = await drive.readRows(action.documentId!);
    const index = rows.findIndex((row, i) => i > 0 && row.includes(link));
    if (index < 0) return false;
    await drive.deleteRow(action.documentId!, index);
    return true;
  }
}
