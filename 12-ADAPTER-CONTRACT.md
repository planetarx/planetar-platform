# 12 — Adapter Contract

Every storage role ([`10`](./10-STORAGE-ROLES.md)) is a **port**: a TypeScript interface the spine depends on. Every engine is an **adapter**: an implementation of that port. The [manifest](./13-CLIENT-MANIFEST.md) names which adapter fills each role; the **compiler** instantiates it at boot. The spine never imports an engine driver.

This is classic ports-and-adapters (hexagonal) — but the novelty is that the *set of ports is fixed and small* (14 roles), so any engine that implements a port drops into any client.

> Sample code is TypeScript (the spine — ontology, registry — is zero-dep TS on Node ≥ 22). The same contracts have Python/C mirrors at the detector and broker edges; only the *shape* matters here.

---

## 1. The adapter lifecycle (base port)

```ts
// spine/ports/adapter.ts
export interface AdapterContext {
  role: RoleId;                 // 'canonical-store' | 'stream' | ...
  manifest: ResolvedBinding;    // engine name + connection config + declared capabilities
  logger: Logger;
  marking: MarkingResolver;     // P1 governance: adapters are Policy Enforcement Points
}

export interface Adapter {
  /** Validate config + declared contract; throw if this engine can't meet the role's contract. */
  init(ctx: AdapterContext): Promise<void>;
  /** Liveness + contract self-check (e.g. round-trip a write). */
  health(): Promise<HealthStatus>;
  /** Graceful drain. */
  close(): Promise<void>;
  /** What this adapter actually supports — the compiler checks these against the role's required contract. */
  readonly capabilities: AdapterCapabilities;
}

export interface AdapterCapabilities {
  consistency: 'strong' | 'read-your-writes' | 'eventual' | 'append-only';
  durable: boolean;
  rebuildable: boolean;          // can be re-derived from the R3 stream?
  scale: 'single' | 'vertical' | 'sharded' | 'global';
  p99TargetMs: number;
}
```

The compiler's rule: **`adapter.capabilities` must satisfy the role's declared contract** (from [`10` §1](./10-STORAGE-ROLES.md)). Binding an `eventual` cache to a role that a capability marked `strong` is a *compile-time* manifest error, not a runtime surprise.

---

## 2. Role port — `CanonicalStore` (R1)

The most-used port. Note: it speaks **canonical types**, never engine rows.

```ts
// spine/ports/canonical-store.ts
import type { CanonicalEntity, Observation, Link, EntityId, TypeName } from '../model';

export interface CanonicalStore extends Adapter {
  // --- writes (only ever called by the kinetic executor / projectors, never by surfaces) ---
  putObservation(obs: Observation, tx?: Tx): Promise<void>;
  upsertEntity(entity: CanonicalEntity, tx?: Tx): Promise<void>;
  putLink(link: Link, tx?: Tx): Promise<void>;

  // --- reads ---
  getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null>;
  listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>>;
  getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]>;

  // --- transactions (multi-row atomic; required for kinetic effects) ---
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface EntityQuery {
  filter?: FieldFilter[];        // structured predicates over canonical fields
  orderBy?: { field: string; dir: 'asc' | 'desc' }[];
  cursor?: string; limit?: number;
}
```

### 2.1 Two engines, one port (the headline demonstration)

`sqlite` for the edge, `postgres` for the cloud — **identical interface, swapped by one manifest line.**

```ts
// 40-ADAPTERS/sqlite/canonical-store.ts   (edge / air-gapped / demo)
import { DatabaseSync } from 'node:sqlite';   // zero-dep, matches planetar-ontology today

export class SqliteCanonicalStore implements CanonicalStore {
  private db!: DatabaseSync;
  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: true,
    scale: 'single', p99TargetMs: 5,
  } as const;

  async init(ctx: AdapterContext) {
    this.db = new DatabaseSync(ctx.manifest.config.path);   // e.g. ./data/canonical.db
    this.db.exec(DDL);                                       // codegen'd from the registry (R10)
  }
  async upsertEntity(e: CanonicalEntity) {
    this.db.prepare(
      `INSERT INTO entity(type,id,body,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(type,id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`
    ).run(e.type, e.id, JSON.stringify(e), e.ts);
  }
  async getEntity(type: TypeName, id: EntityId) {
    const row = this.db.prepare(`SELECT body FROM entity WHERE type=? AND id=?`).get(type, id);
    return row ? JSON.parse(row.body as string) as CanonicalEntity : null;
  }
  async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    this.db.exec('BEGIN');
    try { const r = await fn(new SqliteTx(this.db)); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  /* listEntities/getLinks/putObservation/putLink/health/close omitted for brevity */
}
```

```ts
// 40-ADAPTERS/postgres/canonical-store.ts   (single-cloud workhorse)
import { Pool } from 'pg';

export class PostgresCanonicalStore implements CanonicalStore {
  private pool!: Pool;
  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: true,
    scale: 'vertical', p99TargetMs: 8,
  } as const;

  async init(ctx: AdapterContext) {
    this.pool = new Pool(ctx.manifest.config.connection);
    await this.pool.query(DDL_PG);                          // same logical schema, pg dialect
  }
  async upsertEntity(e: CanonicalEntity) {
    await this.pool.query(
      `INSERT INTO entity(type,id,body,updated_at) VALUES($1,$2,$3,$4)
       ON CONFLICT(type,id) DO UPDATE SET body=$3, updated_at=$4`,
      [e.type, e.id, e, e.ts],
    );
  }
  async getEntity(type: TypeName, id: EntityId) {
    const { rows } = await this.pool.query(
      `SELECT body FROM entity WHERE type=$1 AND id=$2`, [type, id]);
    return rows[0]?.body ?? null;
  }
  async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(new PgTx(c)); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
}
```

A `spanner` adapter for the same port (global scale) is in `40-ADAPTERS/spanner/`. **The ontology, resolver, and Object API import `CanonicalStore` — none of them know which of the three is running.**

---

## 3. Other role ports (signatures)

Full implementations live in `40-ADAPTERS/`; here are the contracts so the shape is fixed.

```ts
// R3 stream — broker (native) | kafka | redis-streams all implement this
export interface Stream extends Adapter {
  publish(env: Envelope): Promise<void>;                       // append to the log + fan-out
  subscribe(topics: TopicPattern[], from: Offset | 'latest'): AsyncIterable<Envelope>;
  ack(offset: Offset): Promise<void>;
}

// R4 object-index — opensearch | postgres-fts | typesense
export interface ObjectIndex extends Adapter {
  index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void>;
  search(q: SearchQuery): Promise<SearchResult>;               // full-text + filter + facet + sort
  aggregate(q: AggQuery): Promise<AggResult>;
}

// R5 graph — falkordb | neo4j | postgres+age
export interface GraphStore extends Adapter {
  upsertNode(n: GraphNode): Promise<void>;
  upsertEdge(e: GraphEdge): Promise<void>;
  neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph>;
  shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null>;
}

// R6 blob-cas — minio/s3 | filesystem | gcs
export interface BlobCas extends Adapter {
  put(bytes: Uint8Array, mime: string): Promise<BlobHandle>;   // returns {sha256,size,mime}
  get(handle: BlobHandle): Promise<Uint8Array>;
  presignRead(handle: BlobHandle, ttlSec: number): Promise<string>;
}

// R7 vector — pgvector | qdrant | milvus
export interface VectorStore extends Adapter {
  upsert(id: string, vec: Float32Array, meta: Json): Promise<void>;
  knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]>;
}

// R2 cache — redis | memcached | in-proc
export interface Cache extends Adapter {
  get(k: string): Promise<Json | null>;
  set(k: string, v: Json, ttlSec?: number): Promise<void>;
  incr(k: string, by?: number): Promise<number>;
}

// R14 work-queue — postgres-skiplocked | redis | temporal
export interface WorkQueue extends Adapter {
  enqueue(job: Job): Promise<JobId>;
  claim(worker: string, max: number): Promise<Job[]>;          // exactly-once / SKIP LOCKED
  complete(id: JobId, result?: Json): Promise<void>;
  fail(id: JobId, retryInSec?: number): Promise<void>;
}
```

R8 (timeseries-geo), R9 (analytics-olap), R10 (registry), R11 (audit-log), R12 (lineage), R13 (policy-identity) ports are specified the same way in `40-ADAPTERS/`.

---

## 4. Binding: how the manifest compiler wires adapters

```ts
// spine/control/binder.ts
const REGISTRY: Record<RoleId, Record<EngineName, () => Adapter>> = {
  'canonical-store': {
    sqlite:   () => new SqliteCanonicalStore(),
    postgres: () => new PostgresCanonicalStore(),
    mysql:    () => new MysqlCanonicalStore(),
    spanner:  () => new SpannerCanonicalStore(),
  },
  'stream':   { broker: () => new BrokerStream(), kafka: () => new KafkaStream(), 'redis-streams': () => new RedisStream() },
  'object-index': { opensearch: () => new OpenSearchIndex(), 'postgres-fts': () => new PgFtsIndex() },
  // ...one row per role
};

export async function bind(manifest: ClientManifest, logger: Logger): Promise<BoundPlatform> {
  const bound: Partial<Record<RoleId, Adapter>> = {};
  for (const [role, binding] of Object.entries(manifest.roles)) {
    const make = REGISTRY[role as RoleId]?.[binding.engine];
    if (!make) throw new ManifestError(`no adapter for ${role}/${binding.engine}`);
    const adapter = make();
    // CONTRACT CHECK: adapter capabilities must satisfy the role contract (10 §1)
    assertSatisfies(ROLE_CONTRACT[role as RoleId], adapter.capabilities, role);
    await adapter.init({ role, manifest: binding, logger, marking: manifest.marking });
    bound[role as RoleId] = adapter;
  }
  return new BoundPlatform(bound);   // the spine receives this; it sees only ports
}
```

The spine then asks the `BoundPlatform` for ports by role:

```ts
const store = platform.role<CanonicalStore>('canonical-store');   // typed; engine-agnostic
await store.upsertEntity(entity);
```

---

## 5. Conformance test suite (one suite, every adapter must pass)

Each port ships a shared, engine-agnostic test suite. An engine is "supported for a role" only when it passes. This is what makes adapters trustworthy enough to swap blindly per client.

```ts
// 40-ADAPTERS/_conformance/canonical-store.spec.ts
export function canonicalStoreConformance(make: () => CanonicalStore) {
  test('round-trips an entity', async () => {
    const s = make(); await s.init(testCtx());
    await s.upsertEntity(sampleVessel);
    expect(await s.getEntity('planetar:Vessel', sampleVessel.id)).toMatchObject(sampleVessel);
  });
  test('upsert is idempotent + last-writer-wins on updated_at', async () => { /* ... */ });
  test('transaction rolls back on throw', async () => { /* ... */ });
  test('listEntities honors filter + cursor pagination', async () => { /* ... */ });
  test('declares capabilities that satisfy the R1 contract', () => {
    expect(satisfies(ROLE_CONTRACT['canonical-store'], make().capabilities)).toBe(true);
  });
}
// then: canonicalStoreConformance(() => new SqliteCanonicalStore())
//       canonicalStoreConformance(() => new PostgresCanonicalStore())
//       canonicalStoreConformance(() => new SpannerCanonicalStore())
```

**Same suite, every engine.** Green across the matrix = a client can bind any of them and the spine behaves identically.
