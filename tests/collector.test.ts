import { it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDataset } from '../packages/storage/src/read.js';
import { JournalReplay } from '../packages/market-data/src/journal.js';
import { journalSchema } from '../packages/domain/src/journal.js';
it('collects, reconnects and reproduces real persisted snapshots from its journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosswake-transport-')),
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  let connections = 0,
    id = 0;
  server.on('connection', (socket) => {
    const connection = ++connections;
    const timer = setInterval(() => {
      const ts = Date.now();
      socket.send(
        JSON.stringify({ data: { s: 'BTCUSDT', b: '99.99', a: '100.01' } }),
      );
      socket.send(
        JSON.stringify({
          data: {
            e: 'trade',
            s: 'BTCUSDT',
            t: ++id,
            T: ts,
            p: '100',
            q: '1',
            m: false,
          },
        }),
      );
    }, 100);
    socket.once('close', () => clearInterval(timer));
    if (connection === 1) setTimeout(() => socket.terminate(), 350);
  });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/collector/src/main.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dir,
        SYMBOLS: 'BTCUSDT',
        COLLECT_SECONDS: '7',
        LATENESS_MS: '500',
        BINANCE_SPOT_WS_BASE: `ws://127.0.0.1:${address.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  try {
    await new Promise<void>((resolve) =>
      server.once('connection', () => resolve()),
    );
    const duplicate = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/collector/src/main.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA_DIR: dir,
          SYMBOLS: 'BTCUSDT',
          COLLECT_SECONDS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let duplicateLog = '';
    duplicate.stdout.on('data', (c) => (duplicateLog += c));
    duplicate.stderr.on('data', (c) => (duplicateLog += c));
    expect(
      await new Promise<number | null>((r, j) => {
        duplicate.once('exit', r);
        duplicate.once('error', j);
      }),
    ).not.toBe(0);
    expect(duplicateLog).toContain('Collector locked');
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code, output).toBe(0);
    expect(connections).toBeGreaterThanOrEqual(2);
    const files = await readdir(join(dir, 'raw'));
    const lines = (await readFile(join(dir, 'raw', files[0]!), 'utf8'))
      .trim()
      .split('\n');
    const replay = new JournalReplay();
    const expected = lines.flatMap((line) =>
      replay.apply(journalSchema.parse(JSON.parse(line))),
    );
    expect(expected.length).toBeGreaterThan(2);
    const dataset = await openDataset(dir, 'live');
    const actual = [];
    for await (const batch of dataset.batches()) actual.push(...batch);
    expect(actual).toEqual(expected);
    expect(actual.some((r) => r.isComplete)).toBe(true);
    const paperFile = join(dir, 'paper', files[0]!);
    const replayOutput = join(dir, 'paper-recovery');
    const paperReplay = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/paper/src/main.ts',
        '--journal',
        join(dir, 'raw', files[0]!),
        '--ledger',
        paperFile,
        '--output',
        replayOutput,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let parityLog = '';
    paperReplay.stdout.on('data', (chunk) => (parityLog += chunk));
    paperReplay.stderr.on('data', (chunk) => (parityLog += chunk));
    const parityCode = await new Promise<number | null>((resolve, reject) => {
      paperReplay.once('error', reject);
      paperReplay.once('exit', resolve);
    });
    expect(parityCode, parityLog).toBe(0);
    const parity = JSON.parse(
      await readFile(join(replayOutput, 'parity.json'), 'utf8'),
    );
    expect(parity).toMatchObject({
      identical: true,
      replayedSteps: actual.length,
    });
    const resumed = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/collector/src/main.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA_DIR: dir,
          SYMBOLS: 'BTCUSDT',
          COLLECT_SECONDS: '3',
          LATENESS_MS: '500',
          BINANCE_SPOT_WS_BASE: `ws://127.0.0.1:${address.port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let resumeLog = '';
    resumed.stdout.on('data', (chunk) => (resumeLog += chunk));
    resumed.stderr.on('data', (chunk) => (resumeLog += chunk));
    const resumeCode = await new Promise<number | null>((resolve, reject) => {
      resumed.once('error', reject);
      resumed.once('exit', resolve);
    });
    expect(resumeCode, resumeLog).toBe(0);
    const resumedHealth = JSON.parse(
      await readFile(join(dir, 'collector-health.json'), 'utf8'),
    );
    expect(resumedHealth.recoveredPaperSteps).toBe(actual.length);
    expect(resumedHealth.shadow.steps).toBeGreaterThan(actual.length);
    const header = JSON.parse(
      (await readFile(resumedHealth.paperPath, 'utf8')).split('\n')[0]!,
    );
    expect(header.previousSessions).toHaveLength(1);
    const resumedParity = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/paper/src/main.ts',
        '--journal',
        resumedHealth.journalPath,
        '--ledger',
        resumedHealth.paperPath,
        '--output',
        join(dir, 'resumed-parity'),
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let resumedParityLog = '';
    resumedParity.stdout.on('data', (chunk) => (resumedParityLog += chunk));
    resumedParity.stderr.on('data', (chunk) => (resumedParityLog += chunk));
    const resumedParityCode = await new Promise<number | null>(
      (resolve, reject) => {
        resumedParity.once('error', reject);
        resumedParity.once('exit', resolve);
      },
    );
    expect(resumedParityCode, resumedParityLog).toBe(0);
    expect(
      JSON.parse(
        await readFile(join(dir, 'resumed-parity', 'parity.json'), 'utf8'),
      ).identical,
    ).toBe(true);
    const health = JSON.parse(
      await readFile(join(dir, 'collector-health.json'), 'utf8'),
    );
    expect(health).toMatchObject({
      connected: false,
      failed: false,
      pending: 0,
    });
  } finally {
    child.kill('SIGTERM');
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
