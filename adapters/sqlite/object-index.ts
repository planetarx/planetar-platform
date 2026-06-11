// adapters/sqlite/object-index.ts — R4 on node:sqlite (LIKE-based; FTS5 optional). Edge fallback.
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './_db.ts';
import type { ObjectIndex, AdapterContext, AdapterCapabilities, IndexDoc, SearchQuery, SearchResult, AggQuery, AggResult } from '../../spine/ports.ts';
import type { TypeName, EntityId, FieldName, Json, HealthStatus } from '../../spine/model.ts';
import { jstr } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const DDL = `CREATE TABLE IF NOT EXISTS idx (type TEXT, id TEXT, text TEXT, fields TEXT, PRIMARY KEY(type,id));`;

export class SqliteObjectIndex implements ObjectIndex {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 50 };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
    this.db.exec(DDL);
  }
  async index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
    const text = (doc.text ?? '') + ' ' + Object.values(doc.fields).map(String).join(' ');
    this.db.prepare('INSERT OR REPLACE INTO idx(type,id,text,fields) VALUES(?,?,?,?)').run(type, id, text.toLowerCase(), jstr(doc.fields));
  }
  async remove(type: TypeName, id: EntityId): Promise<void> {
    this.db.prepare('DELETE FROM idx WHERE type=? AND id=?').run(type, id);
  }
  async search(q: SearchQuery): Promise<SearchResult> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.type) { where.push('type=?'); params.push(q.type); }
    if (q.text) { where.push('text LIKE ?'); params.push(`%${q.text.toLowerCase()}%`); }
    const sql = `SELECT type,id FROM idx${where.length ? ' WHERE ' + where.join(' AND ') : ''} LIMIT ?`;
    params.push(q.limit ?? 25);
    const rows = this.db.prepare(sql).all(...(params as never[])) as { type: string; id: string }[];
    return { hits: rows.map((r) => ({ id: r.id, type: r.type, score: 1 })) };
  }
  async aggregate(q: AggQuery): Promise<AggResult> {
    const rows = this.db.prepare('SELECT count(*) c FROM idx WHERE type=?').all(q.type) as { c: number }[];
    return { rows: [{ key: {} as Record<FieldName, Json>, metrics: { count: rows[0]?.c ?? 0 } }] };
  }
  async searchCandidates(type: TypeName, blockingKeys: Record<FieldName, Json>, limit: number): Promise<EntityId[]> {
    const needle = Object.values(blockingKeys).map(String).join(' ').toLowerCase();
    const rows = this.db.prepare('SELECT id FROM idx WHERE type=? AND text LIKE ? LIMIT ?').all(type, `%${needle}%`, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 50 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('object-index', 'sqlite', () => new SqliteObjectIndex());
