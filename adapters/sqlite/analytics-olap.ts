// adapters/sqlite/analytics-olap.ts — R9 columnar-ish analytics over node:sqlite GROUP BY.
// Points at the same db the canonical-store writes, so reports run over the live entity table.
// Real scale binds ClickHouse/DuckDB or federates BigQuery/Snowflake (40-ADAPTERS/timeseries-olap.md).
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './_db.ts';
import type { AnalyticsOlap, AdapterContext, AdapterCapabilities, OlapQuery, OlapResult } from '../../spine/ports.ts';
import type { Json, HealthStatus } from '../../spine/model.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;   // identifiers must be plain (no injection)

export class SqliteOlap implements AnalyticsOlap {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 500 };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
  }
  async query(q: OlapQuery): Promise<OlapResult> {
    const table = q.from;
    if (!SAFE.test(table)) throw new Error(`unsafe table '${table}'`);
    const dims = q.dimensions.filter((d) => SAFE.test(d));
    const measures = q.measures.map((m) => {
      const fn = ['count', 'sum', 'avg', 'min', 'max'].includes(m.fn) ? m.fn : 'count';
      const col = m.field && SAFE.test(m.field) ? m.field : '*';
      const as = SAFE.test(m.as) ? m.as : 'm';
      return `${fn}(${col}) AS ${as}`;
    });
    const sel = [...dims, ...measures].join(', ');
    const grp = dims.length ? ` GROUP BY ${dims.join(', ')}` : '';
    const ord = q.orderBy?.length ? ` ORDER BY ${q.orderBy.filter((o) => SAFE.test(o.key)).map((o) => `${o.key} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}` : '';
    const lim = q.limit ? ` LIMIT ${Number(q.limit)}` : '';
    const rows = this.db.prepare(`SELECT ${sel} FROM ${table}${grp}${ord}${lim}`).all() as Record<string, Json>[];
    return { rows };
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 500 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('analytics-olap', 'sqlite', () => new SqliteOlap());
