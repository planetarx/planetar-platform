# 40 · Adapters — Relational canonical-store family

**Role:** R1 `canonical-store` (primary). **Engines:** `sqlite` (node:sqlite), `postgres` (pg), `mysql` (mysql2).

This family is the workhorse behind plane **P4** ([`00 §1`](../00-ARCHITECTURE-OVERVIEW.md)). All three engines implement the **identical** `CanonicalStore` port from [`12 §2`](../12-ADAPTER-CONTRACT.md) — the ontology, resolver, and Object API import the port and never know which row is running underneath. Swapping `sqlite`→`postgres`→`mysql` is the one-line manifest edit shown in [`13 §3`](../13-CLIENT-MANIFEST.md).

The headline of this file: **`postgres` is not just an R1 adapter.** A single pg instance, with the right extensions and secondary indexes, simultaneously satisfies **R1 + R4 + R7 + R8 + R14** (and R9-small) — which is the entire "Standard (single-cloud SaaS)" collapse from [`10 §3`](../10-STORAGE-ROLES.md). That multiplexing is documented in §6 ("One postgres, many roles"), with the same adapter port surface for each role it covers.

> **Status (this family):** `sqlite` adapter ✅ **built** — `planetar-ontology/src/store/store.ts` (248 LOC) + `schema.sql` is exactly this code, in production behind the ontology Object API today. `postgres` adapter 🟡 **partial** — DDL + port below are production-shaped, but doibio's Postgres adapter is a **stub** today (doibio runs SQLite-from-vault); the pg path here is the first full write. `mysql` adapter 🔲 **designed** — no client yet binds it; included so a client that standardizes on MySQL drops in without spine changes.

---

## 1. When to pick each engine

| You are… | Bind R1 to | Why |
|---|---|---|
| At the **edge / air-gapped / demo** — one box, no external services | **`sqlite`** (`node:sqlite`, zero-dep) | The whole canonical store is one file; ships in the binary; `planetar` runs this today. Also covers R4 (FTS5), R10, R14 on the same file. |
| The **single-cloud workhorse** — one engine for as many roles as the contract allows | **`postgres`** (`pg`) | One instance multiplexes R1+R4+R7+R8+R14 (§6). Mature, transactional, the default for most clients. |
| The client **standardizes on MySQL** (existing ops, DBA team, RDS/Aurora-MySQL) | **`mysql`** (`mysql2`) | Same port, same DDL shape, dialect-specific upsert. R1 only — for R4/R7/R8 the manifest binds opensearch/pgvector/clickhouse separately. |
| **Planet-scale / 99.999%** | `spanner` / `cockroachdb` | Different file (`40-ADAPTERS/spanner.md`) — same port. |

Pick is a **manifest line**, never a code change. The compiler ([`12 §4`](../12-ADAPTER-CONTRACT.md)) checks each adapter's `capabilities` against the R1 contract (strong / read-your-writes, p99 ≤ 10 ms point-get, durable, rebuildable-from-R3) before boot.

---

## 2. Shared shape — the codegen'd DDL, three dialects

The registry (R10) holds the canonical types of `ARCH-canonical-data-model.md §5.1`; codegen emits one DDL per dialect. The tables are **1:1 with the core:\* types**: `entity`, `observation`, `identifier`, `link`, `event`, `discrepancy`. The SQLite DDL below is verbatim from the built ontology (`planetar-ontology/src/store/schema.sql`); the pg and mysql variants are the same logical schema in each dialect.

### 2.1 SQLite (`node:sqlite`) — built, `planetar-ontology/src/store/schema.sql`

```sql
-- ns timestamps as INTEGER (SQLite INTEGER is 64-bit signed; no overflow until ~2262).
CREATE TABLE IF NOT EXISTS entity (
  id             TEXT PRIMARY KEY,        -- UUIDv7
  type           TEXT NOT NULL,           -- e.g. planetar:Vessel
  schema_version TEXT NOT NULL,
  name           TEXT,
  created_ns     INTEGER,
  updated_ns     INTEGER,
  body           TEXT NOT NULL,           -- JSON: merged canonical fields
  provenance     TEXT NOT NULL            -- JSON: per-field {obs,src,conf,ts}
);
CREATE TABLE IF NOT EXISTS observation (
  id         TEXT PRIMARY KEY,            -- envelope id (UUIDv7)
  entity_id  TEXT REFERENCES entity(id),  -- NULL until resolved (P2)
  type       TEXT NOT NULL,
  source     TEXT NOT NULL,               -- src:<name>@<semver>
  topic      TEXT,
  ts_ns      INTEGER NOT NULL,
  confidence REAL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observation_entity ON observation(entity_id);
CREATE INDEX IF NOT EXISTS observation_type   ON observation(type);
CREATE TABLE IF NOT EXISTS identifier (
  entity_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- mmsi | imo | callsign | ...
  value      TEXT NOT NULL,
  source     TEXT,
  confidence REAL,
  PRIMARY KEY (kind, value, entity_id)
);
CREATE TABLE IF NOT EXISTS link (
  id TEXT PRIMARY KEY, type TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, body TEXT, created_ns INTEGER
);
CREATE INDEX IF NOT EXISTS link_from ON link(from_id);
CREATE INDEX IF NOT EXISTS link_to   ON link(to_id);
-- event, discrepancy tables: see schema.sql (identical shape)
```

### 2.2 Postgres (`pg`) — `jsonb` body, native upsert, GENERATED column for FTS (§6)

```sql
CREATE TABLE IF NOT EXISTS entity (
  type           TEXT   NOT NULL,
  id             TEXT   NOT NULL,
  schema_version TEXT   NOT NULL,
  name           TEXT,
  created_ns     BIGINT,
  updated_ns     BIGINT NOT NULL,
  body           JSONB  NOT NULL,         -- queryable: body->>'mmsi', GIN below
  provenance     JSONB  NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS entity_body_gin ON entity USING gin (body jsonb_path_ops);
CREATE INDEX IF NOT EXISTS entity_type_updated ON entity (type, updated_ns DESC);

CREATE TABLE IF NOT EXISTS observation (
  id         TEXT   PRIMARY KEY,
  entity_id  TEXT,
  type       TEXT   NOT NULL,
  source     TEXT   NOT NULL,
  topic      TEXT,
  ts_ns      BIGINT NOT NULL,
  confidence DOUBLE PRECISION,
  body       JSONB  NOT NULL
);
CREATE INDEX IF NOT EXISTS observation_entity ON observation (entity_id);

CREATE TABLE IF NOT EXISTS identifier (
  entity_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
  source TEXT, confidence DOUBLE PRECISION,
  PRIMARY KEY (kind, value, entity_id)
);
CREATE TABLE IF NOT EXISTS link (
  id TEXT PRIMARY KEY, type TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, body JSONB, created_ns BIGINT
);
CREATE INDEX IF NOT EXISTS link_from ON link (from_id);
CREATE INDEX IF NOT EXISTS link_to   ON link (to_id);
```

### 2.3 MySQL (`mysql2`) — `JSON` body, `ON DUPLICATE KEY`, `utf8mb4`

```sql
CREATE TABLE IF NOT EXISTS entity (
  type           VARCHAR(128) NOT NULL,
  id             VARCHAR(40)  NOT NULL,    -- UUIDv7
  schema_version VARCHAR(32)  NOT NULL,
  name           VARCHAR(512),
  created_ns     BIGINT,
  updated_ns     BIGINT       NOT NULL,
  body           JSON         NOT NULL,
  provenance     JSON         NOT NULL,
  PRIMARY KEY (type, id),
  KEY entity_type_updated (type, updated_ns)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS observation (
  id         VARCHAR(40)  PRIMARY KEY,
  entity_id  VARCHAR(40),
  type       VARCHAR(128) NOT NULL,
  source     VARCHAR(256) NOT NULL,
  topic      VARCHAR(256),
  ts_ns      BIGINT       NOT NULL,
  confidence DOUBLE,
  body       JSON         NOT NULL,
  KEY observation_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS identifier (
  entity_id  VARCHAR(40)  NOT NULL,
  kind       VARCHAR(64)  NOT NULL,
  value      VARCHAR(256) NOT NULL,
  source     VARCHAR(256),
  confidence DOUBLE,
  PRIMARY KEY (kind, value, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS link (
  id VARCHAR(40) PRIMARY KEY, type VARCHAR(128) NOT NULL,
  from_id VARCHAR(40) NOT NULL, to_id VARCHAR(40) NOT NULL,
  body JSON, created_ns BIGINT, KEY link_from (from_id), KEY link_to (to_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

The three differ only in **type names**, **upsert syntax**, and **JSON column type**. Everything above is mechanical codegen off one registry type set — the spine sees only the port.

---

## 3. `sqlite` adapter — `SqliteCanonicalStore`

Built today as `planetar-ontology/src/store/store.ts`; below is that store wrapped to the exact `CanonicalStore` port from [`12 §2`](../12-ADAPTER-CONTRACT.md). `node:sqlite` is synchronous; we satisfy the `Promise`-returning port by returning resolved promises (the calls don't yield, which is fine — at the edge there's one process).

```ts
// 40-ADAPTERS/sqlite/canonical-store.ts
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type {
  CanonicalStore, AdapterContext, HealthStatus, Tx,
  CanonicalEntity, Observation, Link, EntityId, TypeName,
  EntityQuery, Page,
} from '../../spine/ports/canonical-store';

export class SqliteCanonicalStore implements CanonicalStore {
  private db!: DatabaseSync;
  private stmt!: Record<string, StatementSync>;

  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: true,
    scale: 'single', p99TargetMs: 5,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.db = new DatabaseSync(ctx.manifest.config.path);      // ./data/canonical.db
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(readFileSync(ctx.manifest.config.ddl, 'utf8'));  // §2.1, codegen'd from R10
    this.stmt = {
      upEntity: this.db.prepare(
        `INSERT INTO entity(id,type,schema_version,name,created_ns,updated_ns,body,provenance)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, updated_ns=excluded.updated_ns,
           body=excluded.body, provenance=excluded.provenance
         WHERE excluded.updated_ns >= entity.updated_ns`),      // last-writer-wins on ts
      getEntity: this.db.prepare(`SELECT * FROM entity WHERE type=? AND id=?`),
      insObs: this.db.prepare(
        `INSERT OR IGNORE INTO observation(id,entity_id,type,source,topic,ts_ns,confidence,body)
         VALUES(?,?,?,?,?,?,?,?)`),                             // idempotent on envelope id
      insLink: this.db.prepare(
        `INSERT OR IGNORE INTO link(id,type,from_id,to_id,body,created_ns) VALUES(?,?,?,?,?,?)`),
      linksFrom: this.db.prepare(`SELECT * FROM link WHERE from_id=?`),
    };
    this.stmt.getEntity.setReadBigInts(true);
    this.stmt.linksFrom.setReadBigInts(true);
  }

  async upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
    (tx?.stmt('upEntity') ?? this.stmt.upEntity).run(
      e.id, e.type, e.schemaVersion, e.name ?? null,
      e.createdNs, e.updatedNs, JSON.stringify(e.body), JSON.stringify(e.provenance));
  }

  async putObservation(o: Observation, tx?: Tx): Promise<void> {
    (tx?.stmt('insObs') ?? this.stmt.insObs).run(
      o.id, o.entityId ?? null, o.type, o.source, o.topic ?? null,
      o.tsNs, o.confidence ?? null, JSON.stringify(o.body));
  }

  async putLink(l: Link, tx?: Tx): Promise<void> {
    (tx?.stmt('insLink') ?? this.stmt.insLink).run(
      l.id, l.type, l.fromId, l.toId,
      l.body == null ? null : JSON.stringify(l.body), l.createdNs);
  }

  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    const row = this.stmt.getEntity.get(type, id) as Record<string, unknown> | undefined;
    return row ? rowToEntity(row) : null;
  }

  async listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>> {
    // structured filter compiled to body->>'$.field' predicates (SQLite JSON1)
    const { where, params } = compileFilterSqlite(q.filter);
    const limit = q.limit ?? 100;
    const after = q.cursor ? BigInt(q.cursor) : null;
    const sql =
      `SELECT * FROM entity
       WHERE type=? ${where} ${after !== null ? 'AND updated_ns < ?' : ''}
       ORDER BY updated_ns DESC LIMIT ?`;
    const st = this.db.prepare(sql); st.setReadBigInts(true);
    const args = after !== null ? [type, ...params, after, limit + 1] : [type, ...params, limit + 1];
    const rows = (st.all(...args) as Record<string, unknown>[]).map(rowToEntity);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, cursor: hasMore ? String(items[items.length - 1].updatedNs) : null };
  }

  async getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]> {
    const links = (this.stmt.linksFrom.all(id) as Record<string, unknown>[]).map(rowToLink);
    return linkType ? links.filter((l) => l.type === linkType) : links;
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try { const r = await fn(new SqliteTx(this.stmt)); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async health(): Promise<HealthStatus> {
    try {
      const r = this.db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return { ok: r.ok === 1, engine: 'sqlite', detail: 'wal' };
    } catch (e) { return { ok: false, engine: 'sqlite', detail: String(e) }; }
  }

  async close(): Promise<void> { this.db.close(); }
}

class SqliteTx implements Tx {
  constructor(private prepared: Record<string, StatementSync>) {}
  stmt(name: string): StatementSync { return this.prepared[name]; }
}

function rowToEntity(r: Record<string, unknown>): CanonicalEntity {
  return {
    id: r.id as string, type: r.type as string,
    schemaVersion: r.schema_version as string, name: (r.name as string) ?? null,
    createdNs: r.created_ns as bigint, updatedNs: r.updated_ns as bigint,
    body: JSON.parse(r.body as string), provenance: JSON.parse(r.provenance as string),
  };
}
function rowToLink(r: Record<string, unknown>): Link {
  return {
    id: r.id as string, type: r.type as string,
    fromId: r.from_id as string, toId: r.to_id as string,
    body: r.body ? JSON.parse(r.body as string) : null, createdNs: r.created_ns as bigint,
  };
}
function compileFilterSqlite(filter?: { field: string; op: string; value: unknown }[]) {
  const where: string[] = []; const params: unknown[] = [];
  for (const f of filter ?? []) {
    where.push(`json_extract(body, '$.${f.field}') ${sqlOp(f.op)} ?`);
    params.push(f.value);
  }
  return { where: where.length ? 'AND ' + where.join(' AND ') : '', params };
}
function sqlOp(op: string): string {
  return ({ eq: '=', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=', like: 'LIKE' } as const)[op] ?? '=';
}
```

---

## 4. `postgres` adapter — `PostgresCanonicalStore`

`pg` Pool, `jsonb` body. Real driver APIs (`pool.query`, `pool.connect`, parameterized `$n`). The `tx` here carries a pinned `PoolClient` so multi-row kinetic effects run in one transaction. `pg` returns `bigint` columns as **strings** by default (lossless); we coerce to `BigInt` on read and pass `BigInt` as a string on write — no precision loss on ns timestamps.

```ts
// 40-ADAPTERS/postgres/canonical-store.ts
import { Pool, type PoolClient } from 'pg';
import type {
  CanonicalStore, AdapterContext, HealthStatus, Tx,
  CanonicalEntity, Observation, Link, EntityId, TypeName, EntityQuery, Page,
} from '../../spine/ports/canonical-store';

export class PostgresCanonicalStore implements CanonicalStore {
  private pool!: Pool;

  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: true,
    scale: 'vertical', p99TargetMs: 8,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.pool = new Pool(ctx.manifest.config.connection);     // { host, db, user, pool }
    await this.pool.query(ctx.manifest.config.ddl ?? DDL_PG);  // §2.2
  }

  async upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
    await q(this.pool, tx,
      `INSERT INTO entity(type,id,schema_version,name,created_ns,updated_ns,body,provenance)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(type,id) DO UPDATE SET
         name=$4, updated_ns=$6, body=$7, provenance=$8
       WHERE excluded.updated_ns >= entity.updated_ns`,
      [e.type, e.id, e.schemaVersion, e.name ?? null,
       str(e.createdNs), str(e.updatedNs), e.body, e.provenance]);
  }

  async putObservation(o: Observation, tx?: Tx): Promise<void> {
    await q(this.pool, tx,
      `INSERT INTO observation(id,entity_id,type,source,topic,ts_ns,confidence,body)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,   // idempotent on replay
      [o.id, o.entityId ?? null, o.type, o.source, o.topic ?? null,
       str(o.tsNs), o.confidence ?? null, o.body]);
  }

  async putLink(l: Link, tx?: Tx): Promise<void> {
    await q(this.pool, tx,
      `INSERT INTO link(id,type,from_id,to_id,body,created_ns)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
      [l.id, l.type, l.fromId, l.toId, l.body ?? null, str(l.createdNs)]);
  }

  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM entity WHERE type=$1 AND id=$2`, [type, id]);
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async listEntities(type: TypeName, query: EntityQuery): Promise<Page<CanonicalEntity>> {
    const ps: unknown[] = [type];
    const preds: string[] = [];
    for (const f of query.filter ?? []) {                     // jsonb path predicates
      ps.push(f.value);
      preds.push(`body->>'${f.field}' ${sqlOp(f.op)} $${ps.length}`);
    }
    if (query.cursor) { ps.push(query.cursor); preds.push(`updated_ns < $${ps.length}`); }
    const limit = query.limit ?? 100; ps.push(limit + 1);
    const { rows } = await this.pool.query(
      `SELECT * FROM entity WHERE type=$1 ${preds.length ? 'AND ' + preds.join(' AND ') : ''}
       ORDER BY updated_ns DESC LIMIT $${ps.length}`, ps);
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToEntity);
    return { items, cursor: hasMore ? String(items[items.length - 1].updatedNs) : null };
  }

  async getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM link WHERE from_id=$1 ${linkType ? 'AND type=$2' : ''}`,
      linkType ? [id, linkType] : [id]);
    return rows.map(rowToLink);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(new PgTx(c));
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }

  async health(): Promise<HealthStatus> {
    try { await this.pool.query('SELECT 1'); return { ok: true, engine: 'postgres' }; }
    catch (e) { return { ok: false, engine: 'postgres', detail: String(e) }; }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

class PgTx implements Tx { constructor(readonly client: PoolClient) {} }

/** Route a write through the tx's pinned client, else the pool. */
function q(pool: Pool, tx: Tx | undefined, sql: string, params: unknown[]) {
  const exec = (tx as PgTx | undefined)?.client ?? pool;
  return exec.query(sql, params);
}
const str = (n: bigint | null | undefined) => (n == null ? null : n.toString());  // bigint→pg lossless
function rowToEntity(r: any): CanonicalEntity {
  return {
    id: r.id, type: r.type, schemaVersion: r.schema_version, name: r.name ?? null,
    createdNs: r.created_ns == null ? null : BigInt(r.created_ns),
    updatedNs: BigInt(r.updated_ns), body: r.body, provenance: r.provenance,    // jsonb → object
  };
}
function rowToLink(r: any): Link {
  return {
    id: r.id, type: r.type, fromId: r.from_id, toId: r.to_id,
    body: r.body ?? null, createdNs: r.created_ns == null ? null : BigInt(r.created_ns),
  };
}
function sqlOp(op: string): string {
  return ({ eq: '=', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=', like: 'LIKE' } as const)[op] ?? '=';
}
declare const DDL_PG: string;
```

---

## 5. `mysql` adapter — `MysqlCanonicalStore`

`mysql2/promise` pool, `JSON` columns, `INSERT … ON DUPLICATE KEY UPDATE`, `?` placeholders. MySQL has no `excluded`-with-`WHERE` upsert guard, so last-writer-wins on `updated_ns` is enforced with `GREATEST`/conditional `IF` in the `UPDATE` clause. `BIGINT` round-trips through `mysql2` as JS `number` by default; we set `supportBigNumbers: true, bigNumberStrings: true` and coerce to `BigInt`, identical to the pg precision discipline.

```ts
// 40-ADAPTERS/mysql/canonical-store.ts
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import type {
  CanonicalStore, AdapterContext, HealthStatus, Tx,
  CanonicalEntity, Observation, Link, EntityId, TypeName, EntityQuery, Page,
} from '../../spine/ports/canonical-store';

export class MysqlCanonicalStore implements CanonicalStore {
  private pool!: Pool;

  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: true,
    scale: 'vertical', p99TargetMs: 9,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.pool = mysql.createPool({
      ...ctx.manifest.config.connection,
      supportBigNumbers: true, bigNumberStrings: true,      // ns timestamps lossless as strings
      multipleStatements: true,
    });
    await this.pool.query(ctx.manifest.config.ddl ?? DDL_MYSQL);   // §2.3
  }

  async upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
    await q(this.pool, tx,
      `INSERT INTO entity(type,id,schema_version,name,created_ns,updated_ns,body,provenance)
       VALUES(?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         name=IF(VALUES(updated_ns) >= updated_ns, VALUES(name), name),
         body=IF(VALUES(updated_ns) >= updated_ns, VALUES(body), body),
         provenance=IF(VALUES(updated_ns) >= updated_ns, VALUES(provenance), provenance),
         updated_ns=GREATEST(VALUES(updated_ns), updated_ns)`,
      [e.type, e.id, e.schemaVersion, e.name ?? null,
       str(e.createdNs), str(e.updatedNs), JSON.stringify(e.body), JSON.stringify(e.provenance)]);
  }

  async putObservation(o: Observation, tx?: Tx): Promise<void> {
    await q(this.pool, tx,
      `INSERT IGNORE INTO observation(id,entity_id,type,source,topic,ts_ns,confidence,body)
       VALUES(?,?,?,?,?,?,?,?)`,
      [o.id, o.entityId ?? null, o.type, o.source, o.topic ?? null,
       str(o.tsNs), o.confidence ?? null, JSON.stringify(o.body)]);
  }

  async putLink(l: Link, tx?: Tx): Promise<void> {
    await q(this.pool, tx,
      `INSERT IGNORE INTO link(id,type,from_id,to_id,body,created_ns) VALUES(?,?,?,?,?,?)`,
      [l.id, l.type, l.fromId, l.toId,
       l.body == null ? null : JSON.stringify(l.body), str(l.createdNs)]);
  }

  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM entity WHERE type=? AND id=?`, [type, id]) as any;
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async listEntities(type: TypeName, query: EntityQuery): Promise<Page<CanonicalEntity>> {
    const params: unknown[] = [type]; const preds: string[] = [];
    for (const f of query.filter ?? []) {
      preds.push(`JSON_UNQUOTE(JSON_EXTRACT(body, '$.${f.field}')) ${sqlOp(f.op)} ?`);
      params.push(f.value);
    }
    if (query.cursor) { preds.push(`updated_ns < ?`); params.push(query.cursor); }
    const limit = query.limit ?? 100; params.push(limit + 1);
    const [rows] = await this.pool.query(
      `SELECT * FROM entity WHERE type=? ${preds.length ? 'AND ' + preds.join(' AND ') : ''}
       ORDER BY updated_ns DESC LIMIT ?`, params) as any;
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToEntity);
    return { items, cursor: hasMore ? String(items[items.length - 1].updatedNs) : null };
  }

  async getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM link WHERE from_id=? ${linkType ? 'AND type=?' : ''}`,
      linkType ? [id, linkType] : [id]) as any;
    return rows.map(rowToLink);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try { await c.beginTransaction(); const r = await fn(new MysqlTx(c)); await c.commit(); return r; }
    catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }

  async health(): Promise<HealthStatus> {
    try { await this.pool.query('SELECT 1'); return { ok: true, engine: 'mysql' }; }
    catch (e) { return { ok: false, engine: 'mysql', detail: String(e) }; }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

class MysqlTx implements Tx { constructor(readonly conn: PoolConnection) {} }
function q(pool: Pool, tx: Tx | undefined, sql: string, params: unknown[]) {
  return ((tx as MysqlTx | undefined)?.conn ?? pool).query(sql, params);
}
const str = (n: bigint | null | undefined) => (n == null ? null : n.toString());
function rowToEntity(r: any): CanonicalEntity {
  return {
    id: r.id, type: r.type, schemaVersion: r.schema_version, name: r.name ?? null,
    createdNs: r.created_ns == null ? null : BigInt(r.created_ns),
    updatedNs: BigInt(r.updated_ns),
    body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
    provenance: typeof r.provenance === 'string' ? JSON.parse(r.provenance) : r.provenance,
  };
}
function rowToLink(r: any): Link {
  return {
    id: r.id, type: r.type, fromId: r.from_id, toId: r.to_id,
    body: r.body == null ? null : (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    createdNs: r.created_ns == null ? null : BigInt(r.created_ns),
  };
}
function sqlOp(op: string): string {
  return ({ eq: '=', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=', like: 'LIKE' } as const)[op] ?? '=';
}
declare const DDL_MYSQL: string;
```

---

## 6. One postgres, many roles

The "Standard (single-cloud SaaS)" collapse in [`10 §3`](../10-STORAGE-ROLES.md) is: *"`postgres` covers R1, R4 (FTS), R7 (pgvector), R8 (timescale+postgis), R9 (small), R12, R14."* This section shows the **one** pg instance backing **R1 + R4 + R7 + R8 + R14** with nothing but extensions and secondary indexes — five role ports, one connection pool, one transaction domain. (R9-small is R1's `entity` table scanned columnarly; R12 lineage is its own §.)

A client whose manifest binds all five to `postgres` shares one `Pool`; the binder ([`12 §4`](../12-ADAPTER-CONTRACT.md)) hands each role adapter the same connection config and the adapters cooperate on one schema.

### 6.1 Extensions + secondary indexes (run once at init)

```sql
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector  → R7
CREATE EXTENSION IF NOT EXISTS postgis;       -- geo       → R8
CREATE EXTENSION IF NOT EXISTS timescaledb;   -- hypertable→ R8 (continuous aggregates)
-- pg_trgm optional for ILIKE accel; tsvector covers FTS → R4

-- R4 object-index: a generated tsvector + GIN over it (no second search service)
ALTER TABLE entity ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name,'') || ' ' || (body::text))) STORED;
CREATE INDEX IF NOT EXISTS entity_fts ON entity USING gin (fts);
CREATE INDEX IF NOT EXISTS entity_body_gin ON entity USING gin (body jsonb_path_ops);

-- R7 vector: embeddings table, HNSW index for cosine KNN
CREATE TABLE IF NOT EXISTS embedding (
  id     TEXT PRIMARY KEY,                     -- entity id or chip id
  kind   TEXT NOT NULL,                        -- 'eo' | 'sar' | 'text' | 'sai'
  vec    vector(512) NOT NULL,
  meta   JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS embedding_hnsw ON embedding USING hnsw (vec vector_cosine_ops);

-- R8 timeseries-geo: AIS/track points as a timescale hypertable with a geography column
CREATE TABLE IF NOT EXISTS track_point (
  entity_id TEXT NOT NULL,
  ts_ns     BIGINT NOT NULL,
  geom      geography(Point,4326) NOT NULL,
  sog       DOUBLE PRECISION, cog DOUBLE PRECISION,
  PRIMARY KEY (entity_id, ts_ns)
);
SELECT create_hypertable('track_point', by_range('ts_ns'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS track_geom ON track_point USING gist (geom);

-- R14 work-queue: durable jobs claimed with SKIP LOCKED
CREATE TABLE IF NOT EXISTS work_item (
  id          TEXT PRIMARY KEY,
  queue       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  state       TEXT NOT NULL DEFAULT 'ready',   -- ready | claimed | done | failed
  run_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by  TEXT, attempts INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS work_ready ON work_item (queue, run_after) WHERE state='ready';
```

### 6.2 The same pg `Pool`, five role ports

Each port from [`12 §3`](../12-ADAPTER-CONTRACT.md) (`ObjectIndex`, `VectorStore`, `TimeseriesGeo`, `WorkQueue`) has a postgres adapter that takes the **shared** pool. The binder detects the shared connection config and constructs one pool, passing it to all five adapters.

```ts
// 40-ADAPTERS/postgres/multiplex.ts — five role ports, one Pool
import { Pool } from 'pg';

// R4 object-index over entity.fts (tsvector) — no opensearch needed at this scale
export class PgFtsObjectIndex implements ObjectIndex {
  readonly capabilities = { consistency: 'read-your-writes', durable: true,
    rebuildable: true, scale: 'vertical', p99TargetMs: 50 } as const;
  constructor(private pool: Pool) {}
  async init() {}
  async index() { /* no-op: entity.fts is a GENERATED column, indexed on write to R1 */ }
  async search(q: SearchQuery): Promise<SearchResult> {
    const { rows } = await this.pool.query(
      `SELECT type, id, ts_rank(fts, websearch_to_tsquery('simple', $1)) AS score
       FROM entity WHERE fts @@ websearch_to_tsquery('simple', $1)
       ${q.type ? 'AND type=$3' : ''} ORDER BY score DESC LIMIT $2`,
      q.type ? [q.text, q.limit ?? 25, q.type] : [q.text, q.limit ?? 25]);
    return { hits: rows.map((r) => ({ type: r.type, id: r.id, score: r.score })) };
  }
  async aggregate(q: AggQuery): Promise<AggResult> {
    const { rows } = await this.pool.query(
      `SELECT body->>$1 AS bucket, count(*)::int AS n FROM entity
       WHERE type=$2 GROUP BY 1 ORDER BY n DESC LIMIT 50`, [q.field, q.type]);
    return { buckets: rows.map((r) => ({ key: r.bucket, count: r.n })) };
  }
  async health() { try { await this.pool.query('SELECT 1'); return { ok: true, engine: 'postgres-fts' }; }
    catch (e) { return { ok: false, engine: 'postgres-fts', detail: String(e) }; } }
  async close() { /* pool owned by binder, shared — not closed here */ }
}

// R7 vector over the embedding table (pgvector HNSW)
export class PgVectorStore implements VectorStore {
  readonly capabilities = { consistency: 'eventual', durable: true,
    rebuildable: true, scale: 'vertical', p99TargetMs: 50 } as const;
  constructor(private pool: Pool) {}
  async init() {}
  async upsert(id: string, vec: Float32Array, meta: Json): Promise<void> {
    const lit = `[${Array.from(vec).join(',')}]`;     // pgvector text literal
    await this.pool.query(
      `INSERT INTO embedding(id,kind,vec,meta) VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO UPDATE SET vec=$3, meta=$4`,
      [id, (meta as any).kind ?? 'text', lit, meta]);
  }
  async knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]> {
    const lit = `[${Array.from(vec).join(',')}]`;
    const kind = (filter as any)?.kind;
    const { rows } = await this.pool.query(
      `SELECT id, 1 - (vec <=> $1) AS score FROM embedding
       ${kind ? 'WHERE kind=$3' : ''} ORDER BY vec <=> $1 LIMIT $2`,   // <=> = cosine distance
      kind ? [lit, k, kind] : [lit, k]);
    return rows.map((r) => ({ id: r.id, score: r.score }));
  }
  async health() { try { await this.pool.query('SELECT 1'); return { ok: true, engine: 'pgvector' }; }
    catch (e) { return { ok: false, engine: 'pgvector', detail: String(e) }; } }
  async close() {}
}

// R8 timeseries-geo over the timescale hypertable + postgis geography
export class PgTimeseriesGeo implements TimeseriesGeo {
  readonly capabilities = { consistency: 'read-your-writes', durable: true,
    rebuildable: true, scale: 'vertical', p99TargetMs: 50 } as const;
  constructor(private pool: Pool) {}
  async init() {}
  async appendPoint(p: TrackPoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO track_point(entity_id,ts_ns,geom,sog,cog)
       VALUES($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, $5,$6)
       ON CONFLICT(entity_id,ts_ns) DO NOTHING`,
      [p.entityId, p.tsNs.toString(), p.lon, p.lat, p.sog ?? null, p.cog ?? null]);
  }
  async rangeScan(entityId: string, fromNs: bigint, toNs: bigint): Promise<TrackPoint[]> {
    const { rows } = await this.pool.query(
      `SELECT ts_ns, ST_X(geom::geometry) lon, ST_Y(geom::geometry) lat, sog, cog
       FROM track_point WHERE entity_id=$1 AND ts_ns BETWEEN $2 AND $3 ORDER BY ts_ns`,
      [entityId, fromNs.toString(), toNs.toString()]);
    return rows.map((r) => ({ entityId, tsNs: BigInt(r.ts_ns), lon: r.lon, lat: r.lat, sog: r.sog, cog: r.cog }));
  }
  async within(geojson: Json, fromNs: bigint, toNs: bigint): Promise<string[]> {  // geofence
    const { rows } = await this.pool.query(
      `SELECT DISTINCT entity_id FROM track_point
       WHERE ts_ns BETWEEN $2 AND $3
         AND ST_Within(geom::geometry, ST_GeomFromGeoJSON($1))`,
      [JSON.stringify(geojson), fromNs.toString(), toNs.toString()]);
    return rows.map((r) => r.entity_id);
  }
  async health() { try { await this.pool.query('SELECT 1'); return { ok: true, engine: 'timescale-postgis' }; }
    catch (e) { return { ok: false, engine: 'timescale-postgis', detail: String(e) }; } }
  async close() {}
}

// R14 work-queue via FOR UPDATE SKIP LOCKED (exactly-once claim)
export class PgWorkQueue implements WorkQueue {
  readonly capabilities = { consistency: 'strong', durable: true,
    rebuildable: false, scale: 'vertical', p99TargetMs: 20 } as const;
  constructor(private pool: Pool) {}
  async init() {}
  async enqueue(job: Job): Promise<JobId> {
    await this.pool.query(
      `INSERT INTO work_item(id,queue,payload,run_after) VALUES($1,$2,$3, coalesce($4, now()))`,
      [job.id, job.queue, job.payload, job.runAfter ?? null]);
    return job.id;
  }
  async claim(worker: string, max: number): Promise<Job[]> {
    const { rows } = await this.pool.query(
      `UPDATE work_item SET state='claimed', claimed_by=$1, attempts=attempts+1
       WHERE id IN (
         SELECT id FROM work_item
         WHERE state='ready' AND run_after <= now()
         ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT $2)
       RETURNING id, queue, payload`,
      [worker, max]);
    return rows.map((r) => ({ id: r.id, queue: r.queue, payload: r.payload }));
  }
  async complete(id: JobId): Promise<void> {
    await this.pool.query(`UPDATE work_item SET state='done' WHERE id=$1`, [id]);
  }
  async fail(id: JobId, retryInSec = 30): Promise<void> {
    await this.pool.query(
      `UPDATE work_item SET state='ready', run_after = now() + ($2 || ' seconds')::interval
       WHERE id=$1`, [id, String(retryInSec)]);
  }
  async health() { try { await this.pool.query('SELECT 1'); return { ok: true, engine: 'pg-skiplocked' }; }
    catch (e) { return { ok: false, engine: 'pg-skiplocked', detail: String(e) }; } }
  async close() {}
}
```

### 6.3 The binder collapses these onto one pool

```ts
// spine/control/binder.ts — pooling-aware role binding (excerpt)
// When ≥2 roles bind 'postgres' with the same connection config, build ONE Pool and share it.
const pgPools = new Map<string, Pool>();
function sharedPgPool(cfg: PgConfig): Pool {
  const key = `${cfg.host}/${cfg.db}`;
  let p = pgPools.get(key);
  if (!p) { p = new Pool(cfg); pgPools.set(key, p); }
  return p;
}
// canonical-store: postgres → PostgresCanonicalStore(sharedPgPool(cfg))
// object-index:    postgres → PgFtsObjectIndex(sharedPgPool(cfg))
// vector:          pgvector  → PgVectorStore(sharedPgPool(cfg))
// timeseries-geo:  timescale → PgTimeseriesGeo(sharedPgPool(cfg))
// work-queue:      postgres → PgWorkQueue(sharedPgPool(cfg))
```

**Result:** a `standard`-tier client runs *one* database process and gets canonical storage, search, vector KNN, geotemporal tracks, and a durable job queue — five roles, one engine, one transaction domain, no cross-store consistency problem. That is the "collapse roles onto as few engines as the contract allows" principle ([`10 §3`](../10-STORAGE-ROLES.md)) made concrete.

---

## 7. Comparison table

| Engine | Consistency | Scale | p99 (point-get) | Roles it can cover | When to choose |
|---|---|---|---|---|---|
| **sqlite** (`node:sqlite`) | strong (single writer, WAL) | single-node | ~1–5 ms | R1, R4 (FTS5), R10, R14 | Edge / air-gapped / demo; one file, zero services. `planetar` today. |
| **postgres** (`pg`) | strong / read-your-writes | vertical (read replicas) | ~3–8 ms | **R1, R4, R7, R8, R9-sm, R12, R14** | Single-cloud workhorse; multiplex five roles on one instance (§6). |
| **mysql** (`mysql2`) | strong / read-your-writes | vertical | ~4–9 ms | R1 (R4 via FULLTEXT, light) | Client standardizes on MySQL / Aurora-MySQL; pair with opensearch+pgvector for the other roles. |
| spanner / cockroach | strong (external) | global | ~10–20 ms | R1 | Planet-scale, 99.999%, multi-region (separate file). |

All three relational rows **satisfy the R1 contract** (strong/RYW, p99 ≤ 10 ms point-get, durable, rebuildable-from-R3), so the manifest compiler accepts any of them for R1 without a code change.

---

## 8. Conformance hookup

Every engine in this family runs the **single shared** `canonicalStoreConformance` suite from [`12 §5`](../12-ADAPTER-CONTRACT.md). Green across all three = a client may bind any of them and the spine behaves identically.

```ts
// 40-ADAPTERS/relational.conformance.spec.ts
import { canonicalStoreConformance } from './_conformance/canonical-store.spec';
import { SqliteCanonicalStore } from './sqlite/canonical-store';
import { PostgresCanonicalStore } from './postgres/canonical-store';
import { MysqlCanonicalStore } from './mysql/canonical-store';

// SQLite: fully in-process, runs everywhere (CI, edge, laptop)
describe('sqlite', () => canonicalStoreConformance(() => new SqliteCanonicalStore()));

// Postgres / MySQL: gated on a container (testcontainers) so CI without docker skips cleanly
const pg = process.env.PG_URL;
(pg ? describe : describe.skip)('postgres', () =>
  canonicalStoreConformance(() => new PostgresCanonicalStore()));

const my = process.env.MYSQL_URL;
(my ? describe : describe.skip)('mysql', () =>
  canonicalStoreConformance(() => new MysqlCanonicalStore()));

// The multiplex ports (R4/R7/R8/R14 on pg) run their OWN role suites against the shared pool:
//   objectIndexConformance(() => new PgFtsObjectIndex(pool))
//   vectorStoreConformance(() => new PgVectorStore(pool))
//   timeseriesGeoConformance(() => new PgTimeseriesGeo(pool))
//   workQueueConformance(() => new PgWorkQueue(pool))
// A 'standard' manifest is valid only when every bound role's suite is green for its engine.
```

The conformance contract that matters for swap-safety is in `12 §5`: *round-trips an entity*, *upsert idempotent + last-writer-wins on `updated_ns`*, *transaction rolls back on throw*, *`listEntities` honors filter + cursor pagination*, *declares capabilities that satisfy the R1 contract*. The SQLite adapter passes today (it is the ontology's production store); the pg/mysql adapters are written to pass the same suite.

---

## 9. Which manifest tiers / clients bind which

| Tier ([`13`](../13-CLIENT-MANIFEST.md)) | R1 engine | Notes |
|---|---|---|
| **edge / air-gapped** | `sqlite` | One file covers R1 + R4 (FTS5) + R10 + R14. Maritime/defence (`planetar`) edge manifest — **built**. |
| **standard** | `postgres` | One pg multiplexes R1+R4+R7+R8+R14 (§6). The generic enterprise CRM and biotech CRM (`doibio`) reference clients. |
| **scale** | `postgres` (sharded) → `spanner` | R1 promotes to spanner; R4→opensearch, R7→qdrant, R8→clickhouse split out (the one-diff in [`13 §3`](../13-CLIENT-MANIFEST.md)). |
| client standardized on MySQL | `mysql` | Generic enterprise variant where ops mandate MySQL; other roles bound to their own engines. |

The four reference clients in `30-CLIENTS/`:
- **Maritime / defence (`planetar`)** — `sqlite` R1 at the edge; promotes to `postgres` in the regional-cloud diff. **Built (sqlite path).**
- **Biotech CRM (`doibio`)** — `postgres` R1 in the standard manifest (doibio's Postgres adapter is a **stub** today → SQLite-from-vault; this is the path that closes that gap). **Partial.**
- **Generic enterprise CRM+ops** — `postgres` multiplex (§6) is the whole datastore tier for the clean Salesforce-parity client.
- **Intel / financial-crime graph** — `postgres` R1 + a dedicated graph engine (falkordb/neo4j, R5) since link-analysis volume exceeds pg+AGE.

> The invariant across every row: **the ontology, resolver, Object API, detectors, and UI are byte-identical.** Only the manifest line under `roles.canonical-store.engine` (and the §6 multiplex bindings) differs.
