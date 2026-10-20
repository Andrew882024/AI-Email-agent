import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';
import type { ChatFileRepository } from '../db/repositories.js';
import type { ChatFile } from '../domain/types.js';
import type { Part } from '../llm/types.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLUMNS = 30;

export class UnsupportedFileError extends Error {
  override name = 'UnsupportedFileError';
}

type Kind = 'image' | 'pdf' | 'docx' | 'xlsx' | 'text';

const BY_EXTENSION: Record<string, { kind: Kind; mimeType: string }> = {
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.heic': { kind: 'image', mimeType: 'image/heic' },
  '.heif': { kind: 'image', mimeType: 'image/heif' },
  '.pdf': { kind: 'pdf', mimeType: 'application/pdf' },
  '.docx': {
    kind: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  '.xlsx': {
    kind: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  '.txt': { kind: 'text', mimeType: 'text/plain' },
  '.md': { kind: 'text', mimeType: 'text/markdown' },
  '.csv': { kind: 'text', mimeType: 'text/csv' },
  '.json': { kind: 'text', mimeType: 'application/json' },
};

/** What we do with a file: send it to the model as-is (image, PDF) or extract its text. */
export function classifyFile(filename: string, mimeType: string): { kind: Kind; mimeType: string } {
  const byExt = BY_EXTENSION[extname(filename).toLowerCase()];
  if (byExt) return byExt;
  const known = Object.values(BY_EXTENSION).find((t) => t.mimeType === mimeType);
  if (known) return known;
  if (mimeType.startsWith('text/')) return { kind: 'text', mimeType };
  throw new UnsupportedFileError(
    `Unsupported file type "${filename}" (${mimeType}). Supported: images, PDF, Word (.docx), Excel (.xlsx), text.`,
  );
}

const cell = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : (value instanceof Date ? value.toISOString().slice(0, 10) : String(value))
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');

/** Every sheet as a Markdown table (bounded), which models read reliably. */
export async function xlsxToText(data: Buffer): Promise<string> {
  const sheets = await readXlsxFile(data);
  return sheets
    .map(({ sheet, data: rows }) => {
      const kept = rows.slice(0, MAX_SHEET_ROWS).map((r) => r.slice(0, MAX_SHEET_COLUMNS));
      const width = Math.max(1, ...kept.map((r) => r.length));
      const line = (r: unknown[]) =>
        `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
      const [header = [], ...body] = kept;
      const table = [line(header), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
      const more =
        rows.length > MAX_SHEET_ROWS
          ? `\n(${rows.length - MAX_SHEET_ROWS} more rows not shown)`
          : '';
      return `### Sheet: ${sheet}\n${table}${more}`;
    })
    .join('\n\n');
}

export async function extractText(kind: Kind, data: Buffer): Promise<string | undefined> {
  let text: string;
  if (kind === 'docx') text = (await mammoth.extractRawText({ buffer: data })).value;
  else if (kind === 'xlsx') text = await xlsxToText(data);
  else if (kind === 'text') text = data.toString('utf8');
  else return undefined; // images and PDFs go to the model directly
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…(truncated)` : text;
}

/** Stores chat uploads under the app data directory and prepares them for the model. */
export class ChatFileStore {
  constructor(
    private readonly repo: ChatFileRepository,
    private readonly directory: string,
  ) {}

  async save(
    accountId: string,
    upload: { filename: string; mimeType: string; data: Buffer },
  ): Promise<ChatFile> {
    if (upload.data.length > MAX_FILE_BYTES)
      throw new UnsupportedFileError('Files are limited to 20 MB');
    const { kind, mimeType } = classifyFile(upload.filename, upload.mimeType);
    const extractedText = await extractText(kind, upload.data).catch((err: unknown) => {
      throw new UnsupportedFileError(
        `Couldn't read "${upload.filename}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await mkdir(this.directory, { recursive: true });
    const storagePath = join(
      this.directory,
      `${randomUUID()}${extname(upload.filename).toLowerCase()}`,
    );
    await writeFile(storagePath, upload.data, { mode: 0o600 });
    return this.repo.create({
      accountId,
      filename: upload.filename,
      mimeType,
      size: upload.data.length,
      storagePath,
      extractedText,
    });
  }

  get(id: string): Promise<ChatFile | undefined> {
    return this.repo.get(id);
  }

  /** The model's view of a file: the bytes for images/PDFs, extracted text otherwise. */
  async toParts(file: ChatFile): Promise<Part[]> {
    if (file.extractedText !== undefined) {
      return [{ type: 'text', text: `[Attached file: ${file.filename}]\n${file.extractedText}` }];
    }
    return [
      { type: 'text', text: `[Attached file: ${file.filename}]` },
      {
        type: 'file',
        mimeType: file.mimeType,
        data: await readFile(file.storagePath),
        name: file.filename,
      },
    ];
  }
}
