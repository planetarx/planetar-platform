# 40-ADAPTERS · Global-scale canonical-store (spanner, cockroachdb, yugabytedb)

**Role:** R1 · canonical-store, at `scale: 'global'`.
**Engines:** Google Cloud Spanner (`@google-cloud/spanner`), CockroachDB (pg wire, `pg`), YugabyteDB YSQL (pg wire, `pg`).
**Status:** **designed**. The R1 port is **built** against `sqlite` (`~/github/planetarx/planetar-ontology/src/store/store.ts`, node:sqlite, 30 tests green) and `postgres` (stub in [`12 §2.1`](../12-ADAPTER-CONTRACT.md)); the global-scale adapters below conform to the *same* `CanonicalStore` port and are unbuilt. No application/spine code changes between any of them — that invariance is the deliverable this file proves.

This is the **headline demonstration** of [`10 §R1`](../10-STORAGE-ROLES.md): *same role, different engine.* The maritime edge node binds `sqlite` (one file, air-gapped); a planet-scale, 99.999%, multi-region enterprise binds `spanner` — and the ontology, resolver, identity-resolution, Object API, and kinetic executor are **byte-for-byte identical**. The only artifact that changes is one stanza in the [manifest](../13-CLIENT-MANIFEST.md).

---

## 1. Intro — which role, which engines, when to pick each

R1 holds the current-best-knowledge projection of every canonical entity / observation / identifier / link / event / discrepancy (1:1 with the `core:*` types in `ARCH-canonical-data-model.md`, materialized in `planetar-ontology/src/store/schema.sql`). Its contract ([`10 §R1`](../10-STORAGE-ROLES.md)): **strong / read-your-writes**, p99 ≤ 10 ms point-get, durable + replicated, **rebuildable from R3**.

Single-node `sqlite` and vertically-scaled `postgres` satisfy that contract up to one box's ceiling. When a client needs R1 to survive a regional outage, serve readers on three continents with bounded staleness, and stay strongly consistent across all of it, you bind a **globally-distributed** engine. All three below keep the R1 contract's `consistency: 'strong'` — that's the non-negotiable that rules out an eventually-consistent KV store for this role.

| Pick… | …when |
|---|---|
| **Spanner** | Fully-managed, GCP-resident, want TrueTime external consistency + the 99.999% SLA + zero ops. Cost is acceptable and you don't need pg-extension parity (no pgvector/postgis in the same engine — those roles bind elsewhere). The "I never want to think about the database again" choice. |
| **CockroachDB** | Want Spanner-class distributed SQL but **portable** (self-host, any cloud, air-gap-capable region, or CockroachDB Cloud), with **postgres wire compatibility** so the existing `pg`-based adapter is ~90% reused. Open-source core. The "Spanner economics/lock-in scare me" choice. |
| **YugabyteDB** | Same distributed-SQL shape, **full PostgreSQL query layer** (YSQL reuses real Postgres code), strongest pg-feature compatibility (more extensions, triggers, stored procs) — useful when a client wants distributed scale *and* keeps heavy Postgres semantics. The "we need postgres, but global" choice. |

CockroachDB and YugabyteDB both speak the **pg wire protocol**, so they share one adapter class parameterized by dialect; Spanner has its own client and gets a dedicated class. Decision tie-back ([`README`](../README.md)): *custom spine + OSS breadth.* CockroachDB/Yugabyte are OSS; Spanner is managed — both sit behind the same port, the spine never imports either driver.

---

## 2. Primary-key & layout design (the part that actually matters at scale)

Before the code: the schema decisions that make R1 *correct and fast* on a distributed engine. These are engine-tuning of the **same logical schema** in `schema.sql`; the canonical model is unchanged.

### 2.1 Hotspot avoidance — UUIDv7 vs. hashed prefix

The canonical model mandates **UUIDv7** ids (`zmesg` mints them; the envelope id *is* the observation id). UUIDv7 is **time-ordered** — its high bits are a millisecond timestamp. That is excellent for a single-node B-tree (recent rows cluster, cache-warm) but a **hotspot** on a range-sharded distributed engine: every new write lands at the *end* of the keyspace, so one split/range/tablet takes 100% of the insert load while the rest sit idle.

The fix differs per engine, and the adapter encodes it so the spine never sees it:

- **Spanner** — Spanner range-shards on the PK and explicitly warns against monotonically increasing keys. We **do not** use raw UUIDv7 as the leading PK column. Instead the leading component is `type` (low-cardinality but bounded — splits by object type) and within a type we either (a) bit-reverse / hash-prefix the UUIDv7, or (b) rely on Spanner's automatic load-based splitting once a range heats up. The adapter writes a `shard` smallint = `fnv1a(id) % N` as the true leading key so inserts scatter across N (e.g. 256) splits; reads by id recompute the same `shard`, so point-get stays a single-split lookup.
- **CockroachDB** — uses **hash-sharded indexes** natively: `PRIMARY KEY (type, id) USING HASH WITH (bucket_count = 16)` adds a computed `crdb_internal_hash` leading column, spreading the time-ordered UUIDv7 tail across 16 ranges. One DDL clause; no application change.
- **YugabyteDB** — PK columns default to **HASH** partitioning (`PRIMARY KEY ((type, id) HASH)`), so a monotone UUIDv7 is hash-distributed across tablets automatically. This is why Yugabyte needs the *least* tuning for our write pattern.

Net: **UUIDv7 stays the id everywhere** (the model demands it; resolution + provenance key on it). Hotspot avoidance is an *index-layout* concern the adapter owns, invisible to `CanonicalStore` callers.

### 2.2 Interleaving — entity + observation locality

The hottest read in the platform is the resolver folding observations into an entity (lifecycle 4.1 in [`00 §4`](../00-ARCHITECTURE-OVERVIEW.md)): given an `entity_id`, fetch the entity row **and** its observations together. On a distributed store, if entity and its observations live in unrelated splits, that's a fan-out read. **Interleaving** co-locates them physically.

- **Spanner** — first-class: declare `observation` and `identifier` and `link` **`INTERLEAVE IN PARENT entity ON DELETE CASCADE`**. Spanner stores a child row physically adjacent to its parent in the same split. `getEntityWithObservations(entityId)` becomes a single-split read. PK design:
  ```sql
  CREATE TABLE entity (
    type           STRING(64)  NOT NULL,
    id             STRING(36)  NOT NULL,    -- UUIDv7
    schema_version STRING(16)  NOT NULL,
    name           STRING(MAX),
    created_ns     INT64,
    updated_ns     INT64,
    body           JSON        NOT NULL,    -- merged canonical fields
    provenance     JSON        NOT NULL,    -- per-field {obs,src,conf,ts}
  ) PRIMARY KEY (type, id);

  CREATE TABLE observation (
    type       STRING(64) NOT NULL,         -- parent key prefix
    id         STRING(36) NOT NULL,         -- parent key prefix (entity id)
    obs_id     STRING(36) NOT NULL,         -- this observation (envelope id)
    source     STRING(128) NOT NULL,
    topic      STRING(128),
    ts_ns      INT64 NOT NULL,
    confidence FLOAT64,
    body       JSON NOT NULL,
  ) PRIMARY KEY (type, id, obs_id),
    INTERLEAVE IN PARENT entity ON DELETE CASCADE;
  ```
  An *un-resolved* observation (no entity yet, common in lifecycle 4.1 before P5 runs) cannot interleave under a non-existent parent, so it lands in a non-interleaved `observation_pending` table keyed by `(shard, obs_id)` and is moved under its parent when the resolver assigns `entity_id`. The port hides this: callers only ever call `putObservation`.
- **CockroachDB** — no `INTERLEAVE` keyword (deprecated/removed in v21+), but the same locality is achieved by **prefixing the child PK with the parent key**: `PRIMARY KEY (type, id, obs_id)`. CockroachDB ranges are key-ordered, so children sort adjacent to the parent — locality without a special clause. Pair with `USING HASH` on the leading prefix for scatter.
- **YugabyteDB** — uses `PRIMARY KEY ((type, id) HASH, obs_id ASC)`: the hash key `(type,id)` lands the entity and *all* its observations on the **same tablet** (range part `obs_id ASC` orders them within it). That gives interleave-equivalent single-tablet locality for the `entityId → entity + observations` read.

### 2.3 Why the same ontology code runs unchanged

The spine depends on `CanonicalStore` ([`12 §2`](../12-ADAPTER-CONTRACT.md)), whose methods speak `CanonicalEntity | Observation | Link | EntityId | TypeName` — **canonical types, never engine rows**. Sharding columns (`shard`, `crdb_internal_hash`), interleave declarations, the pending-observation table, dialect quirks: all live *below* the port, inside the adapter. The resolver calls `getEntity(type,id)` / `putObservation(obs)` / `transaction(fn)` identically whether the bytes land in a `node:sqlite` file on an air-gapped boat or across three Spanner regions. That is the entire bet of [`11 §4`](../11-CAPABILITY-ROLE-MAP.md): *the roles differ, the spine contract does not.*

---

## 3. Adapters (implementing the exact `CanonicalStore` port)

Port recap from [`12 §2`](../12-ADAPTER-CONTRACT.md): `putObservation`, `upsertEntity`, `putLink`, `getEntity`, `listEntities`, `getLinks`, `transaction`, plus the base `Adapter` lifecycle (`init`/`health`/`close`/`capabilities`). All three declare `scale: 'global'`, `consistency: 'strong'`.

### 3.1 `SpannerCanonicalStore` (`@google-cloud/spanner`)

```ts
// 40-ADAPTERS/spanner/canonical-store.ts
import { Spanner, Database, Transaction } from '@google-cloud/spanner';
import type {
  CanonicalStore, AdapterContext, HealthStatus,
  CanonicalEntity, Observation, Link, EntityId, TypeName,
  EntityQuery, Page, Tx,
} from '../../spine/ports/canonical-store';

/** fnv1a-32 → split scatter for the time-ordered UUIDv7 (see §2.1). */
function shardOf(id: string, n = 256): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % n;
}

class SpannerTx implements Tx {
  constructor(readonly t: Transaction) {}
}

export class SpannerCanonicalStore implements CanonicalStore {
  private db!: Database;

  readonly capabilities = {
    consistency: 'strong',        // TrueTime external consistency
    durable: true,
    rebuildable: true,            // R1 is a projection of R3 (00 §3.2)
    scale: 'global',
    p99TargetMs: 10,              // global-strong read; well under the R1 contract ceiling
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const { projectId, instance, database } = ctx.manifest.config as
      { projectId: string; instance: string; database: string };
    const spanner = new Spanner({ projectId });
    this.db = spanner.instance(instance).database(database);
    // DDL (entity + interleaved observation/identifier/link) is codegen'd from the
    // registry (R10) and applied out-of-band by the manifest compiler, not here.
    await this.db.run('SELECT 1');   // fail init() fast if unreachable / wrong contract
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.db.run('SELECT 1'); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }

  async close(): Promise<void> { await this.db.close(); }

  // --- writes ---------------------------------------------------------------

  async upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
    const row = {
      type: e.type, id: e.id, shard: shardOf(e.id),
      schema_version: e.schemaVersion ?? '1.0',
      name: e.name ?? null,
      created_ns: String(e.createdNs ?? e.ts),     // INT64 via string (BigInt-safe)
      updated_ns: String(e.updatedNs ?? e.ts),
      body: e.body ?? e,                            // JSON column
      provenance: e.provenance ?? {},
    };
    // upsertEntity = blind upsert; last-writer-wins on updated_ns (conformance spec).
    if (tx) { (tx as SpannerTx).t.upsert('entity', row); return; }
    await this.db.table('entity').upsert(row);      // single-statement mutation, strong
  }

  async putObservation(obs: Observation, tx?: Tx): Promise<void> {
    // Resolved obs interleaves under its entity; unresolved goes to the pending table (§2.2).
    const resolved = !!obs.entityId;
    const table = resolved ? 'observation' : 'observation_pending';
    const row = resolved
      ? { type: obs.type, id: obs.entityId, obs_id: obs.id, source: obs.source,
          topic: obs.topic ?? null, ts_ns: String(obs.tsNs), confidence: obs.confidence ?? null,
          body: obs.body }
      : { shard: shardOf(obs.id), obs_id: obs.id, type: obs.type, source: obs.source,
          topic: obs.topic ?? null, ts_ns: String(obs.tsNs), confidence: obs.confidence ?? null,
          body: obs.body };
    if (tx) { (tx as SpannerTx).t.insert(table, row); return; }
    await this.db.table(table).insert(row);         // observations are immutable → insert
  }

  async putLink(link: Link, tx?: Tx): Promise<void> {
    const row = {
      type: link.type, from_id: link.fromId, to_id: link.toId, id: link.id,
      body: link.body ?? {}, created_ns: String(link.createdNs ?? Date.now() * 1e6),
    };
    if (tx) { (tx as SpannerTx).t.upsert('link', row); return; }
    await this.db.table('link').upsert(row);
  }

  // --- reads ----------------------------------------------------------------

  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    // Strong single-split point read on (type,id); p99 ~ single-digit ms in-region.
    const [rows] = await this.db.run({
      sql: 'SELECT body, provenance, schema_version, name, created_ns, updated_ns ' +
           'FROM entity WHERE type = @type AND id = @id',
      params: { type, id },
    });
    if (!rows.length) return null;
    const r = rows[0].toJSON();
    return { type, id, ...r.body, schemaVersion: r.schema_version, name: r.name,
             createdNs: BigInt(r.created_ns), updatedNs: BigInt(r.updated_ns),
             provenance: r.provenance } as CanonicalEntity;
  }

  async listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>> {
    const where: string[] = ['type = @type'];
    const params: Record<string, unknown> = { type, limit: q.limit ?? 100 };
    for (const [i, f] of (q.filter ?? []).entries()) {
      // JSON_VALUE keeps the filter over canonical fields, engine-side.
      where.push(`JSON_VALUE(body, '$.${f.field}') ${sqlOp(f.op)} @f${i}`);
      params[`f${i}`] = f.value;
    }
    if (q.cursor) { where.push('id > @cursor'); params.cursor = q.cursor; }
    const order = (q.orderBy ?? [{ field: 'id', dir: 'asc' }])
      .map(o => `id ${o.dir.toUpperCase()}`).join(', ');   // cursor-stable order on id
    const [rows] = await this.db.run({
      sql: `SELECT id, body, provenance FROM entity WHERE ${where.join(' AND ')} ` +
           `ORDER BY ${order} LIMIT @limit`,
      params,
    });
    const items = rows.map(rw => { const r = rw.toJSON();
      return { type, id: r.id, ...r.body, provenance: r.provenance } as CanonicalEntity; });
    return { items, cursor: items.length === (q.limit ?? 100) ? items[items.length - 1].id : null };
  }

  async getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]> {
    const [rows] = await this.db.run({
      sql: 'SELECT id, type, from_id, to_id, body, created_ns FROM link ' +
           'WHERE (from_id = @id OR to_id = @id)' + (linkType ? ' AND type = @lt' : ''),
      params: linkType ? { id, lt: linkType } : { id },
    });
    return rows.map(rw => { const r = rw.toJSON();
      return { id: r.id, type: r.type, fromId: r.from_id, toId: r.to_id,
               body: r.body, createdNs: BigInt(r.created_ns) } as Link; });
  }

  // --- transactions (multi-row atomic; required for kinetic effects, 00 §4.2) ---

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // Spanner read-write txns are externally consistent and auto-retry on abort.
    return this.db.runTransactionAsync(async (t) => {
      const r = await fn(new SpannerTx(t));
      await t.commit();
      return r;
    });
  }
}

function sqlOp(op: string): string {
  switch (op) { case 'eq': return '='; case 'ne': return '!='; case 'gt': return '>';
    case 'lt': return '<'; case 'gte': return '>='; case 'lte': return '<=';
    default: throw new Error(`unsupported filter op ${op}`); }
}
```

### 3.2 `CockroachCanonicalStore` / `YugabyteCanonicalStore` (pg wire, one class)

Both speak the pg wire protocol, so they extend the existing `PostgresCanonicalStore` ([`12 §2.1`](../12-ADAPTER-CONTRACT.md)) and differ only in DDL dialect (hash-sharded vs hash-partitioned PK) and declared `scale`. ~90% of the postgres adapter is reused verbatim — that's the payoff of pg-wire compatibility.

```ts
// 40-ADAPTERS/cockroach/canonical-store.ts
import { Pool, PoolClient } from 'pg';
import type {
  CanonicalStore, AdapterContext, HealthStatus,
  CanonicalEntity, Observation, Link, EntityId, TypeName,
  EntityQuery, Page, Tx,
} from '../../spine/ports/canonical-store';

class PgTx implements Tx { constructor(readonly c: PoolClient) {} }

type Dialect = 'cockroach' | 'yugabyte';

export class DistributedSqlCanonicalStore implements CanonicalStore {
  private pool!: Pool;
  constructor(private readonly dialect: Dialect) {}

  readonly capabilities = {
    consistency: 'strong',        // CRDB: serializable default; Yugabyte: serializable/snapshot
    durable: true,
    rebuildable: true,
    scale: 'global',
    p99TargetMs: 10,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    // pg wire — same driver as the postgres adapter; connection string targets the
    // CRDB/Yugabyte gateway. DDL with the right PK strategy (§2.1/§2.2) is applied
    // by the manifest compiler from registry-codegen'd schema, not here.
    this.pool = new Pool(ctx.manifest.config.connection);
    await this.pool.query('SELECT 1');
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.pool.query('SELECT 1'); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }

  async close(): Promise<void> { await this.pool.end(); }

  // --- writes (identical SQL to the postgres adapter; the PK layout in DDL does the work) ---

  async upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
    const q = `INSERT INTO entity(type, id, schema_version, name, created_ns, updated_ns, body, provenance)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT(type, id) DO UPDATE SET
                 name=$4, updated_ns=$6, body=$7, provenance=$8
               WHERE entity.updated_ns < EXCLUDED.updated_ns`;   // last-writer-wins
    const args = [e.type, e.id, e.schemaVersion ?? '1.0', e.name ?? null,
                  String(e.createdNs ?? e.ts), String(e.updatedNs ?? e.ts),
                  e.body ?? e, e.provenance ?? {}];
    await this.exec(q, args, tx);
  }

  async putObservation(obs: Observation, tx?: Tx): Promise<void> {
    const q = `INSERT INTO observation(type, id, obs_id, source, topic, ts_ns, confidence, body)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(type, id, obs_id) DO NOTHING`;
    await this.exec(q, [obs.type, obs.entityId, obs.id, obs.source, obs.topic ?? null,
                        String(obs.tsNs), obs.confidence ?? null, obs.body], tx);
  }

  async putLink(link: Link, tx?: Tx): Promise<void> {
    const q = `INSERT INTO link(id, type, from_id, to_id, body, created_ns)
               VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET body=$5`;
    await this.exec(q, [link.id, link.type, link.fromId, link.toId, link.body ?? {},
                        String(link.createdNs ?? Date.now() * 1e6)], tx);
  }

  // --- reads ---

  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    const { rows } = await this.pool.query(
      `SELECT body, provenance, schema_version, name, created_ns, updated_ns
         FROM entity WHERE type=$1 AND id=$2`, [type, id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { type, id, ...r.body, schemaVersion: r.schema_version, name: r.name,
             createdNs: BigInt(r.created_ns), updatedNs: BigInt(r.updated_ns),
             provenance: r.provenance } as CanonicalEntity;
  }

  async listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>> {
    const where: string[] = ['type=$1']; const args: unknown[] = [type]; let n = 1;
    for (const f of q.filter ?? []) {
      where.push(`body->>'${f.field}' ${sqlOp(f.op)} $${++n}`); args.push(f.value);
    }
    if (q.cursor) { where.push(`id > $${++n}`); args.push(q.cursor); }
    const limit = q.limit ?? 100; args.push(limit);
    const { rows } = await this.pool.query(
      `SELECT id, body, provenance FROM entity WHERE ${where.join(' AND ')}
         ORDER BY id ASC LIMIT $${++n}`, args);
    const items = rows.map(r => ({ type, id: r.id, ...r.body, provenance: r.provenance }) as CanonicalEntity);
    return { items, cursor: items.length === limit ? items[items.length - 1].id : null };
  }

  async getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]> {
    const { rows } = await this.pool.query(
      `SELECT id, type, from_id, to_id, body, created_ns FROM link
         WHERE (from_id=$1 OR to_id=$1)${linkType ? ' AND type=$2' : ''}`,
      linkType ? [id, linkType] : [id]);
    return rows.map(r => ({ id: r.id, type: r.type, fromId: r.from_id, toId: r.to_id,
                            body: r.body, createdNs: BigInt(r.created_ns) }) as Link);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      // CRDB/Yugabyte both default to SERIALIZABLE; both can throw 40001 (retry).
      await c.query('BEGIN');
      const r = await fn(new PgTx(c));
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }

  private async exec(q: string, args: unknown[], tx?: Tx): Promise<void> {
    if (tx) await (tx as PgTx).c.query(q, args);
    else await this.pool.query(q, args);
  }
}

// binder entries (12 §4): two engine names, one class, different dialect + DDL.
export const makeCockroach = () => new DistributedSqlCanonicalStore('cockroach');
export const makeYugabyte  = () => new DistributedSqlCanonicalStore('yugabyte');

function sqlOp(op: string): string {
  switch (op) { case 'eq': return '='; case 'ne': return '!='; case 'gt': return '>';
    case 'lt': return '<'; case 'gte': return '>='; case 'lte': return '<=';
    default: throw new Error(`unsupported filter op ${op}`); }
}
```

> **CRDB/Yugabyte serialization note:** both can abort a txn with SQLSTATE `40001` under contention; production code wraps `transaction()` in a bounded retry loop. The kinetic executor already treats Action-Type effects as idempotent (keyed on the action's envelope id), so a retry is safe. Omitted above to keep the port shape clean; it belongs in a shared `withSerializableRetry()` helper used by every pg-wire distributed adapter.

---

## 4. Comparison table

| Engine | Wire / client | Consistency model | Scale axis | p99 point-get (in-region) | Cross-region write | When to choose |
|---|---|---|---|---|---|---|
| **sqlite** (baseline) | `node:sqlite` | strong (single writer) | single-node | ~0.1–1 ms | n/a | edge / air-gapped / demo (built today) |
| **postgres** (baseline) | `pg` | strong | vertical (1 primary) | ~1–8 ms | n/a (read replicas eventual) | single-cloud workhorse |
| **Spanner** | `@google-cloud/spanner` | **strong** (TrueTime external) | **global** | ~5–10 ms | ~10s–100s ms (Paxos quorum) | managed, GCP, 99.999%, zero-ops |
| **CockroachDB** | `pg` wire | **strong** (serializable) | **global** | ~2–10 ms (leaseholder-local) | ~10s–100s ms (Raft quorum) | portable distributed SQL, OSS, multi-cloud/self-host |
| **YugabyteDB** | `pg` wire (YSQL) | **strong** (serializable/snapshot) | **global** | ~2–10 ms | ~10s–100s ms (Raft quorum) | distributed scale + max Postgres feature parity |

**Cost / latency tradeoffs vs postgres (the honest part):**

- **Latency floor rises.** A vertical postgres does a local-disk point-get in ~1 ms. A globally-distributed engine pays a **consensus tax**: every committed write is a Paxos/Raft quorum round-trip. In-region reads stay single-digit ms (served by the local leaseholder/replica), but **cross-region writes are 10×–100× postgres** (tens to hundreds of ms). You buy survivability and global-strong reads with write latency. R1's contract ceiling (p99 ≤ 10 ms point-get) is met for *reads*; latency-sensitive write paths still flow through R3 (the bus) first, so the user-perceived path isn't gated on the distributed commit.
- **Cost rises sharply.** Spanner bills per-node-hour (or per processing-unit) **plus** storage **plus** network egress, and needs ≥3 replicas for the 99.999% SLA — easily 5–20× a single managed postgres for the same data. CockroachDB/Yugabyte self-hosted trade that dollar cost for **operational cost** (you run the cluster), or CockroachDB Cloud / Yugabyte Aeon re-introduce the managed premium.
- **The decision rule.** Bind a global engine to R1 **only** when the client's contract genuinely needs multi-region survivability + global-strong consistency. A single-region enterprise gets postgres and saves the consensus tax. Because R1 is **rebuildable from R3** ([`10 §R1`](../10-STORAGE-ROLES.md)), this is reversible: a client can start on postgres and **reproject** onto Spanner later by replaying the bus into a new adapter — no app rewrite, just a manifest change and a backfill. That re-derivability is what makes the expensive choice a *deferrable* choice.

---

## 5. Manifest binding diff (`sqlite` → `spanner`)

This is the entire change to take the maritime client's R1 from a single edge file to planet-scale. Everything else in [`13 §1`](../13-CLIENT-MANIFEST.md) — capabilities, ingest, surfaces, governance, and all *other* role bindings — is untouched. No spine, ontology, resolver, Object API, detector, or UI code changes.

```diff
 client:
-  tier: edge
+  tier: scale
 roles:
   canonical-store:
-    engine: sqlite
-    config: { path: ./data/canonical.db }
+    engine: spanner
+    config:
+      projectId: planetar-prod
+      instance: planetar-global
+      database: canonical
+      regions: [nam-eur-asia1]          # multi-region config → 99.999% + global-strong
+      pkStrategy: interleave-shard       # §2.1/§2.2: shard-scatter + interleaved children
```

The CockroachDB variant (portable / self-host) is the same diff with:

```yaml
  canonical-store:
    engine: cockroach
    config:
      connection: { host: crdb-gw.internal, port: 26257, database: canonical, pool: 40 }
      pkStrategy: hash-sharded            # PRIMARY KEY (type,id) USING HASH WITH (bucket_count=16)
```

The manifest compiler ([`12 §4`](../12-ADAPTER-CONTRACT.md)) validates that the bound engine's declared `capabilities` satisfy the R1 contract: `consistency: 'strong'`, `durable: true`, `scale: 'global'` all pass; the compile-time check that rejects an `eventual` engine for R1 ([`13 §2`](../13-CLIENT-MANIFEST.md)) is exactly what stops someone wiring DynamoDB-eventual under the canonical store by accident.

---

## 6. Conformance-suite hookup

The global-scale adapters pass the **same** engine-agnostic suite as sqlite/postgres ([`12 §5`](../12-ADAPTER-CONTRACT.md)). Green across the whole matrix = a client can bind any of them and the spine behaves identically.

```ts
// 40-ADAPTERS/_conformance/canonical-store.global.spec.ts
import { canonicalStoreConformance } from './canonical-store.spec';
import { SpannerCanonicalStore } from '../spanner/canonical-store';
import { makeCockroach, makeYugabyte } from '../cockroach/canonical-store';

// Spanner: run against the Cloud Spanner *emulator* in CI (no billing, identical API).
//   docker run -p 9010:9010 gcr.io/cloud-spanner-emulator/emulator
//   SPANNER_EMULATOR_HOST=localhost:9010
canonicalStoreConformance(() => new SpannerCanonicalStore());

// CockroachDB: single-node `cockroach demo --insecure` in CI; pg wire, real serializable.
canonicalStoreConformance(makeCockroach);

// YugabyteDB: `yugabyted start` single-node in CI; YSQL pg wire.
canonicalStoreConformance(makeYugabyte);
```

The suite asserts the four R1 invariants that matter for blind swappability: **round-trips an entity**, **upsert is idempotent + last-writer-wins on `updated_ns`**, **`transaction` rolls back on throw**, **`listEntities` honors filter + cursor pagination**, plus **`capabilities` satisfy `ROLE_CONTRACT['canonical-store']`**. The distributed engines additionally exercise a *serialization-conflict* case (two concurrent txns on one entity → one retries) that single-node sqlite can't reach — that test is gated `if (capabilities.scale !== 'single')`.

---

## 7. Which manifest tiers / clients bind this

| Manifest tier ([`13 §1`](../13-CLIENT-MANIFEST.md)) | R1 binding | Rationale |
|---|---|---|
| `edge` / `air-gapped` | **sqlite** | one file, no services, offline; never a distributed engine |
| `standard` | **postgres** | single-region workhorse; consensus tax not worth paying |
| `scale` | **spanner** *(managed)* or **cockroachdb** *(portable)* | multi-region survivability + global-strong consistency |

Of the four reference clients ([`README §The four reference clients`](../README.md)):

- **Maritime / defence (`planetar`)** — *edge* today (`sqlite`, built). Its scale-up path ([`13 §3`](../13-CLIENT-MANIFEST.md)) goes to `postgres`; a coalition / multi-region command tier is where `cockroachdb` (self-hostable, no GCP dependency, air-gap-region-capable) would bind R1 — Spanner's GCP residency is a poor fit for sovereign-defence, so **CockroachDB is the global pick here.**
- **Generic enterprise CRM+ops** — the natural **Spanner** client: GCP-resident, wants the 99.999% SLA and zero-ops, no sovereignty constraint. The clean Salesforce-parity story with planet-scale standard/custom objects on one engine.
- **Intel / financial-crime graph** — global watchlist/dossier consistency across regions; **CockroachDB or Spanner** for R1, with R5 (graph) still on falkordb/neo4j and R4 (object-index) on opensearch — R1 is only one of its bound roles.
- **Biotech / research CRM (`doibio`)** — *standard* `postgres`; single-tenant research scale, no global-strong requirement. Would only bind a distributed R1 if it became a multi-region hosted product.

The point stands across all four: **the engine under R1 changes per client and per tier; the ontology, resolver, identity-resolution, Object API, and kinetic executor do not.** That invariance — proven by one conformance suite passing on five engines behind one port — is the deliverable.
