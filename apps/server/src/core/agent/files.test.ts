import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatFileRepository } from '../db/repositories.js';
import type { ChatFile } from '../domain/types.js';
import { ChatFileStore, classifyFile, UnsupportedFileError, xlsxToText } from './files.js';

/** Minimal real .docx (one paragraph per line). */
async function docx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraphs = lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Minimal real .xlsx with one sheet of inline strings/numbers. */
async function xlsx(name: string, rows: (string | number)[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  const col = (i: number) => String.fromCharCode(65 + i);
  const xmlRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`,
    )
    .join('');
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('chat files', () => {
  let dir: string;
  const stored: ChatFile[] = [];
  const repo: ChatFileRepository = {
    create: async (f) => {
      const file = { ...f, id: `f${stored.length + 1}`, createdAt: new Date() };
      stored.push(file);
      return file;
    },
    get: async (id) => stored.find((f) => f.id === id),
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-files-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('classifies by extension, then MIME type, and rejects the rest', () => {
    expect(classifyFile('scan.PDF', 'application/octet-stream')).toEqual({
      kind: 'pdf',
      mimeType: 'application/pdf',
    });
    expect(classifyFile('photo', 'image/png').kind).toBe('image');
    expect(classifyFile('notes.log', 'text/x-log').kind).toBe('text');
    expect(() => classifyFile('app.exe', 'application/x-msdownload')).toThrow(UnsupportedFileError);
  });

  it('extracts text from Word and Excel, keeps images/PDFs as bytes for the model', async () => {
    const store = new ChatFileStore(repo, dir);
    const word = await store.save('a1', {
      filename: '会议纪要.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: await docx(['Budget review', '下周三提交报告']),
    });
    expect(word.extractedText).toBe('Budget review\n\n下周三提交报告\n\n');
    expect(await store.toParts(word)).toEqual([
      { type: 'text', text: `[Attached file: 会议纪要.docx]\n${word.extractedText}` },
    ]);

    const sheet = await store.save('a1', {
      filename: 'orders.xlsx',
      mimeType: 'application/octet-stream',
      data: await xlsx('Q3', [
        ['Order', 'Amount'],
        ['A-1', 40],
        ['B|2', 12.5],
      ]),
    });
    expect(sheet.extractedText).toBe(
      '### Sheet: Q3\n| Order | Amount |\n| --- | --- |\n| A-1 | 40 |\n| B\\|2 | 12.5 |',
    );

    const png = Buffer.from('fake-png');
    const image = await store.save('a1', {
      filename: 'shot.png',
      mimeType: 'image/png',
      data: png,
    });
    expect(image.extractedText).toBeUndefined();
    expect(await readFile(image.storagePath)).toEqual(png);
    expect(await store.toParts(image)).toEqual([
      { type: 'text', text: '[Attached file: shot.png]' },
      { type: 'file', mimeType: 'image/png', data: png, name: 'shot.png' },
    ]);

    const text = await store.save('a1', {
      filename: 'n.txt',
      mimeType: 'text/plain',
      data: Buffer.from('hello 你好'),
    });
    expect(text.extractedText).toBe('hello 你好');
  });

  it('rejects oversized, unsupported and corrupt files', async () => {
    const store = new ChatFileStore(repo, dir);
    await expect(
      store.save('a1', {
        filename: 'big.txt',
        mimeType: 'text/plain',
        data: Buffer.alloc(21 * 1024 * 1024),
      }),
    ).rejects.toThrow('20 MB');
    await expect(
      store.save('a1', { filename: 'x.zip', mimeType: 'application/zip', data: Buffer.from('z') }),
    ).rejects.toThrow('Unsupported');
    await expect(
      store.save('a1', { filename: 'bad.xlsx', mimeType: '', data: Buffer.from('not a zip') }),
    ).rejects.toThrow(/Couldn't read "bad.xlsx"/);
  });

  it('formats several sheets and bounds big ones', async () => {
    const rows = [['n'], ...Array.from({ length: 600 }, (_, i) => [i])];
    const text = await xlsxToText(await xlsx('Big', rows));
    expect(text).toContain('(101 more rows not shown)');
    expect(text.split('\n').length).toBeLessThan(510);
  });
});
