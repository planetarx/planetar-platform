// adapters/sqlite/analytics-olap.ts — R9 columnar-ish analytics over node:sqlite GROUP BY.
// Points at the same db the canonical-store writes, so reports run over the live entity table.
// Real scale binds ClickHouse/DuckDB or federates BigQuery/Snowflake (40-ADAPTERS/timeseries-olap.md).
//
// Two modes, chosen by whether the query carries a principal:
//   system    — `from` is a table and names are columns (operators and report builders).
//   principal — `from` is a canonical TYPE and every name is a logical FIELD of it. No storage
//               column or other table can be reached, and only rows whose every marking the
//               principal holds are aggregated (docs/specs/2026-10-06-governed-ports-design.md §4.4).
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './_db.ts';
import type { AnalyticsOlap, AdapterContext, AdapterCapabilities, OlapQuery, OlapResult, Principal } from '../../spine/ports.ts';
import type { Json, HealthStatus } from '../../spine/model.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;   // identifiers must be plain (no injection)
const FIELD = /^[A-Za-z0-9_:.-]+$/;         // a logical field name, e.g. 'planetar:status'
const FNS = ['count', 'sum', 'avg', 'min', 'max'];
const OPS: Record<string, string> = { eq: '=', ne: '<>', gt: '>', lt: '<', gte: '>=', lte: '<=' };
// a canonical row is selectable when it carries no marking outside the principal's clearances
const VISIBLE = `NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(body,'$.markings'),'[]')) m WHERE m.value NOT IN (SELECT value FROM json_each(?)))`;

export class SqliteOlap implements AnalyticsOlap {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 500, enforcesMarkings: true };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
  }

  async query(q: OlapQuery): Promise<OlapResult> {
    return q.principal ? this.typedQuery(q, q.principal) : this.tableQuery(q);
  }

  /** system mode: plain GROUP BY over a table's own columns. */
  private tableQuery(q: OlapQuery): OlapResult {
    const table = q.from;
    if (!SAFE.test(table)) throw new Error(`unsafe table '${table}'`);
    const dims = q.dimensions.filter((d) => SAFE.test(d));
    const measures = q.measures.map((m) => {
      const fn = FNS.includes(m.fn) ? m.fn : 'count';
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

  /** principal mode: every name is a field read out of the entity body through a BOUND JSON
   *  path, so nothing the caller sends becomes SQL text or selects a storage column. */
  private typedQuery(q: OlapQuery, principal: Principal): OlapResult {
    const path = (field: string): string => {
      if (!FIELD.test(field)) throw new Error(`unsupported field name '${field}'`);
      return `$.fields."${field}"`;
    };
    const params: (string | number)[] = [];
    const out: { key: string; col: string }[] = [];
    const sel: string[] = [];
    q.dimensions.forEach((d, i) => { sel.push(`json_extract(body, ?) AS d${i}`); params.push(path(d)); out.push({ key: d, col: `d${i}` }); });
    q.measures.forEach((m, i) => {
      if (!SAFE.test(m.as)) throw new Error(`unsafe measure name '${m.as}'`);
      const fn = FNS.includes(m.fn) ? m.fn : 'count';
      if (m.field) { sel.push(`${fn}(json_extract(body, ?)) AS m${i}`); params.push(path(m.field)); } else sel.push(`count(*) AS m${i}`);
      out.push({ key: m.as, col: `m${i}` });
    });
    if (!sel.length) throw new Error('a query needs at least one dimension or measure');

    let sql = `SELECT ${sel.join(', ')} FROM entity WHERE type = ? AND ${VISIBLE}`;
    params.push(q.from, JSON.stringify(principal.clearances));
    for (const w of q.where ?? []) {
      const op = OPS[w.op];
      if (!op) throw new Error(`unsupported filter op '${w.op}'`);
      if (typeof w.value !== 'string' && typeof w.value !== 'number') throw new Error(`unsupported filter value for '${w.field}'`);
      sql += ` AND json_extract(body, ?) ${op} ?`; params.push(path(w.field), w.value);
    }
    if (q.dimensions.length) sql += ` GROUP BY ${q.dimensions.map((_, i) => `d${i}`).join(', ')}`;
    if (q.orderBy?.length) {
      sql += ' ORDER BY ' + q.orderBy.map((o) => {
        const hit = out.find((c) => c.key === o.key);
        if (!hit) throw new Error(`cannot order by '${o.key}': not a dimension or measure of this query`);
        return `${hit.col} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`;
      }).join(', ');
    }
    if (q.limit) sql += ` LIMIT ${Number(q.limit)}`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, Json>[];
    return { rows: rows.map((r) => Object.fromEntries(out.map((c) => [c.key, r[c.col]]))) };
  }

  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 500 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('analytics-olap', 'sqlite', () => new SqliteOlap());
