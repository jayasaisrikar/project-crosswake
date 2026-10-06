import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Snapshot } from '../../domain/src/index.js';
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
export class ParquetWriter {
  private constructor(
    private instance: DuckDBInstance,
    private root: string,
  ) {}
  static async create(root: string) {
    return new ParquetWriter(await DuckDBInstance.create(':memory:'), root);
  }
  async write(rows: Snapshot[]) {
    if (!rows.length) return;
    const groups = new Map<string, Snapshot[]>();
    for (const row of rows) {
      const date = new Date(row.ts - 1).toISOString().slice(0, 10);
      const path = join(
        this.root,
        'normalized',
        'venue=binance',
        'market=spot',
        `date=${date}`,
        `symbol=${row.symbol}`,
      );
      const list = groups.get(path) ?? [];
      list.push(row);
      groups.set(path, list);
    }
    for (const [dir, list] of groups) {
      await mkdir(dir, { recursive: true });
      const id = randomUUID(),
        json = join(dir, `${id}.json.tmp`),
        temp = join(dir, `${id}.parquet.tmp`),
        final = join(dir, `${id}.parquet`);
      await writeFile(
        json,
        list.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      const conn = await this.instance.connect();
      try {
        await conn.run(
          `COPY (SELECT * FROM read_json_auto(${literal(json)}, format='newline_delimited', columns={ts:'BIGINT',symbol:'VARCHAR',open:'DOUBLE',high:'DOUBLE',low:'DOUBLE',close:'DOUBLE',baseVolume:'DOUBLE',quoteVolume:'DOUBLE',buyQuoteVolume:'DOUBLE',sellQuoteVolume:'DOUBLE',tradeCount:'BIGINT',bestBid:'DOUBLE',bestAsk:'DOUBLE',spreadBps:'DOUBLE',sourceLatencyMs:'DOUBLE',isComplete:'BOOLEAN',quoteClock:'VARCHAR',quoteTs:'BIGINT',availableAt:'BIGINT'})) TO ${literal(temp)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
      } finally {
        conn.closeSync();
      }
      await rename(temp, final);
      const hash = createHash('sha256')
        .update(await readFile(final))
        .digest('hex');
      await writeFile(
        final + '.manifest.json',
        JSON.stringify(
          {
            schemaVersion: 2,
            rows: list.length,
            sha256: hash,
            quoteEvidence: list.some((r) => r.bestBid !== null),
            firstTs: list[0]!.ts,
            lastTs: list.at(-1)!.ts,
          },
          null,
          2,
        ),
      );
      const { unlink } = await import('node:fs/promises');
      await unlink(json);
    }
  }
  close() {
    this.instance.closeSync();
  }
}
