import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSystemLogger } from './system-logger.js';

describe('createSystemLogger', () => {
  it('appends JSON lines to <logDir>/app.jsonl, creating the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-email-log-'));
    const logDir = join(dir, 'nested', 'logs');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logger = createSystemLogger({ level: 'info', logDir });
      logger.info({ action: 'star' }, 'hello');
      logger.debug('below level');
      const lines = (await readFile(join(logDir, 'app.jsonl'), 'utf8')).trim().split('\n');
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        expect.objectContaining({ level: 30, action: 'star', msg: 'hello' }),
      ]);
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
