// adapters/sqlite/graph.ts — R5 graph over node:sqlite recursive CTEs (zero-service edge/standard).
// Real scale binds FalkorDB/Neo4j (see 40-ADAPTERS/graph.md); same GraphStore port.
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './_db.ts';
import type { GraphStore, AdapterContext, AdapterCapabilities, GraphNode, GraphEdge, TraversalSpec, Subgraph, Path } from '../../spine/ports.ts';
import type { EntityId, HealthStatus, Json } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const DDL = `
CREATE TABLE IF NOT EXISTS gnode (id TEXT PRIMARY KEY, type TEXT, fields TEXT);
CREATE TABLE IF NOT EXISTS gedge (from_id TEXT, to_id TEXT, link_type TEXT, fields TEXT, PRIMARY KEY(from_id,to_id,link_type));
CREATE INDEX IF NOT EXISTS gedge_from ON gedge(from_id);
CREATE INDEX IF NOT EXISTS gedge_to ON gedge(to_id);`;

export class SqliteGraphStore implements GraphStore {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 80 };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
    this.db.exec(DDL);
  }
  async upsertNode(n: GraphNode): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO gnode(id,type,fields) VALUES(?,?,?)').run(n.id, n.type, jstr(n.fields ?? {}));
  }
  async upsertEdge(e: GraphEdge): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO gedge(from_id,to_id,link_type,fields) VALUES(?,?,?,?)').run(e.from, e.to, e.linkType, jstr(e.fields ?? {}));
  }
  async neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph> {
    const hops = spec.maxHops ?? 2;
    const dir = spec.direction ?? 'out';
    const out = 'SELECT g.to_id, nb.hop+1 FROM gedge g JOIN nb ON g.from_id=nb.id WHERE nb.hop<?';
    const inc = 'SELECT g.from_id, nb.hop+1 FROM gedge g JOIN nb ON g.to_id=nb.id WHERE nb.hop<?';
    const rec = dir === 'in' ? inc : dir === 'both' ? `${out} UNION ${inc}` : out;
    const params = dir === 'both' ? [id, hops, hops, id] : [id, hops, id];
    const rows = this.db.prepare(
      `WITH RECURSIVE nb(id,hop) AS (SELECT ?,0 UNION ${rec}) SELECT DISTINCT id FROM nb WHERE id<>?`,
    ).all(...(params as never[])) as { id: string }[];
    const ids = new Set([id, ...rows.map((r) => r.id)]);
    const nodes = [...ids].map((nid) => {
      const n = this.db.prepare('SELECT id,type,fields FROM gnode WHERE id=?').get(nid) as { id: string; type: string; fields: string } | undefined;
      return n ? { id: n.id, type: n.type, fields: jparse<Record<string, Json>>(n.fields) } : { id: nid, type: 'unknown' };
    });
    const edges = this.db.prepare('SELECT from_id,to_id,link_type FROM gedge WHERE from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...ids]), JSON.stringify([...ids])) as { from_id: string; to_id: string; link_type: string }[];
    return { nodes, edges: edges.filter((e) => ids.has(e.from_id) && ids.has(e.to_id)).map((e) => ({ from: e.from_id, to: e.to_id, linkType: e.link_type })) };
  }
  async shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null> {
    const max = spec.maxHops ?? 6;
    const row = this.db.prepare(
      `WITH RECURSIVE p(id,hop) AS (SELECT ?,0 UNION SELECT g.to_id,p.hop+1 FROM gedge g JOIN p ON g.from_id=p.id WHERE p.hop<?)
       SELECT min(hop) AS h FROM p WHERE id=?`,
    ).get(a, max, b) as { h: number | null };
    return row.h == null ? null : { nodes: [a, b], edges: [], length: row.h };
  }
  async query(): Promise<Subgraph> { return { nodes: [], edges: [] }; }   // raw-cypher escape hatch: N/A on sqlite
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 80 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('graph', 'sqlite', () => new SqliteGraphStore());
