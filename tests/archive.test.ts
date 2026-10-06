import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  downloadArchive,
  dateRange,
  parseChecksum,
  retryRequest,
} from '../packages/market-data/src/archive.js';
describe('archive integrity', () => {
  it('validates filenames and bounded UTC date ranges', () => {
    expect(dateRange('2026-09-30', '2026-10-02')).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(() => dateRange('2026-02-30')).toThrow();
    expect(() => dateRange('2026-10-02', '2026-10-01')).toThrow();
    expect(() =>
      parseChecksum('a'.repeat(64) + ' other.zip', 'target.zip'),
    ).toThrow();
  });
  it('retries transient errors and fails permanent responses promptly', async () => {
    let calls = 0;
    expect(
      await retryRequest(async () => {
        if (++calls < 2) throw new Error('Transient HTTP 503');
        return 'ok';
      }),
    ).toBe('ok');
    expect(calls).toBe(2);
    await expect(
      retryRequest(async () => {
        throw new Error('Permanent HTTP 404');
      }),
    ).rejects.toThrow('404');
  });
  it('verifies downloads, reuses matching cache and rejects corruption', async () => {
    const data = Buffer.from('archive fixture'),
      hash = createHash('sha256').update(data).digest('hex');
    let corrupted = false,
      downloads = 0;
    const server = createServer((req, res) => {
      if (req.url?.endsWith('.CHECKSUM')) res.end(hash + ' fixture.zip');
      else {
        downloads++;
        res.end(corrupted ? 'corrupt' : data);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('No test port');
    const dir = await mkdtemp(join(tmpdir(), 'crosswake-archive-')),
      url = `http://127.0.0.1:${addr.port}/fixture.zip`;
    try {
      const file = join(dir, 'fixture.zip');
      expect(await downloadArchive(url, file)).toBe(hash);
      expect(await readFile(file)).toEqual(data);
      await downloadArchive(url, file);
      expect(downloads).toBe(1);
      corrupted = true;
      await expect(downloadArchive(url, join(dir, 'bad.zip'))).rejects.toThrow(
        'checksum mismatch',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  });
});
