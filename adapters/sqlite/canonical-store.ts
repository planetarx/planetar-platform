// adapters/sqlite/canonical-store.ts — R1 on node:sqlite (zero-dep; mirrors planetar-ontology store).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CanonicalStore } from '../../spine/ports.ts';
import type { AdapterContext, AdapterCapabilities } from '../../spine/ports.ts';
import type { CanonicalEntity, Observation, Link, EntityId, TypeName, Page, EntityQuery, Tx, HealthStatus, MarkingId } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

function openDb(path: string): DatabaseSync { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); return new DatabaseSync(path); }

const DDL = `
CREATE TABLE IF NOT EXISTS entity (type TEXT, id TEXT, body TEXT, updated_at TEXT, PRIMARY KEY(type,id));
CREATE TABLE IF NOT EXISTS observation (id TEXT PRIMARY KEY, type TEXT, body TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS link (id TEXT PRIMARY KEY, link_type TEXT, from_id TEXT, to_id TEXT, body TEXT);
CREATE INDEX IF NOT EXISTS link_from ON link(from_id);
`;

export class SqliteCanonicalStore implements CanonicalStore {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'strong', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 5 };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
    this.db.exec(DDL);
  }
  async putObservation(obs: Observation): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO observation(id,type,body,ts) VALUES(?,?,?,?)').run(obs.id, obs.type, jstr(obs), obs.ts.toString());
  }
  async upsertEntity(e: CanonicalEntity): Promise<void> {
    this.db.prepare('INSERT INTO entity(type,id,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at')
      .run(e.type, e.id, jstr(e), e.ts.toString());
  }
  async putLink(l: Link): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO link(id,link_type,from_id,to_id,body) VALUES(?,?,?,?,?)').run(l.id, l.linkType, l.from, l.to, jstr(l));
  }
  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    const row = this.db.prepare('SELECT body FROM entity WHERE type=? AND id=?').get(type, id) as { body: string } | undefined;
    return row ? jparse<CanonicalEntity>(row.body) : null;
  }
  async listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>> {
    const limit = q.limit ?? 50;
    const after = q.cursor ?? '';
    const rows = this.db.prepare('SELECT id, body FROM entity WHERE type=? AND id>? ORDER BY id LIMIT ?').all(type, after, limit) as { id: string; body: string }[];
    return { items: rows.map((r) => jparse<CanonicalEntity>(r.body)), cursor: rows.length === limit ? rows[rows.length - 1].id : undefined };
  }
  async getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]> {
    const rows = linkType
      ? this.db.prepare('SELECT body FROM link WHERE from_id=? AND link_type=?').all(id, linkType) as { body: string }[]
      : this.db.prepare('SELECT body FROM link WHERE from_id=?').all(id) as { body: string }[];
    return rows.map((r) => jparse<Link>(r.body));
  }
  async markingsOf(ids: EntityId[]): Promise<Record<EntityId, MarkingId[]>> {
    const out: Record<EntityId, MarkingId[]> = {};
    if (!ids.length) return out;
    const rows = this.db.prepare("SELECT id, json_extract(body,'$.markings') AS m FROM entity WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { id: string; m: string | null }[];
    // the key is (type,id): if one id exists under two types, the union is the safe answer
    for (const r of rows) out[r.id] = [...new Set([...(out[r.id] ?? []), ...(JSON.parse(r.m ?? '[]') as MarkingId[])])];
    return out;
  }
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try { const r = await fn({ id: 'sqlite-tx' }); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async health(): Promise<HealthStatus> { this.db.prepare('SELECT 1').get(); return { ok: true, p99Ms: 5 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('canonical-store', 'sqlite', () => new SqliteCanonicalStore());
