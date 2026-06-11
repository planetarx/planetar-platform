# 40-ADAPTERS · Graph (R5) (falkordb, neo4j, memgraph, postgres+age)

**Role:** R5 · graph — typed entity/link traversal: link charts, neighborhood expansion ("search around"), shortest path, subgraph/cycle pattern match.
**Engines:** FalkorDB (Redis module, Cypher via `ioredis` `GRAPH.QUERY`), Neo4j (`neo4j-driver`, Cypher), Memgraph (`neo4j-driver`, Bolt + Cypher), PostgreSQL + Apache AGE (`pg`, `cypher()` over SQL).
**Status:** **designed** at the adapter layer; the *data it projects* is **built**. R5 is a rebuildable projection of R1's `link` table — and R1+links are built against `sqlite` in `planetar-ontology` (`src/store/store.ts`, `link(id,type,from_id,to_id,body,created_ns)`, `linksFrom()`; the dark-vessel re-ID writes `same_vessel` links there; 30 tests green). The graph engines below give that link set *traversal* superpowers (k-hop, shortest path, cycle detection) that a relational `WHERE from_id = ?` can't do in bounded latency. No spine code changes between the four engines — that invariance is what this file proves.

This is the **Gotham Graph/Vertex** layer: link analysis, dossiers, "search around an entity," and financial-crime ring detection — the same traversals `doibio`'s ontology graph view does over its 35-schema object/link model, expressed once against the `GraphStore` port and run on whichever engine the [manifest](../13-CLIENT-MANIFEST.md) binds.

---

## 1. Intro — which role, which engines, when to pick each

R5 holds **typed nodes** (canonical entities) and **typed edges** (canonical links) optimized for *traversal*, not for point-get (that's R1) or full-text (that's R4). Its contract ([`10 §R5`](../10-STORAGE-ROLES.md)): **read-your-writes-within-seconds**, p99 ≤ 100 ms for a *bounded* traversal, durable, **rebuildable from R1 links**. The access patterns are: neighbor expansion, k-hop traversal, shortest path, subgraph/cycle pattern (Cypher-ish).

The crucial framing ([`§3`](#3-r5-is-a-projection-of-r1-not-a-second-source-of-truth)): **R5 is never a source of truth.** Every node and edge in it is a copy of a `CanonicalEntity` / `Link` that already lives in R1, kept in sync by a stream (R3) consumer. You can drop the entire graph database and rebuild it from R1 in one scan. That is *why* it's safe to bind a fast-but-lossy in-memory graph engine here: losing R5 loses nothing.

All four engines below speak **Cypher** (AGE speaks a Cypher subset embedded in SQL), so the query bodies for the three flagship traversals — k-hop "search around," shortest path, financial-crime ring — are **nearly identical strings** across engines. The adapter differs only in *how it ships the Cypher to the driver and shreds the result*.

| Pick… | …when |
|---|---|
| **FalkorDB** *(default)* | You already run Redis (R2 hot-cache) and want graph as a **module on the box you have** — no second service, no second ops story. Sparse-matrix/GraphBLAS core makes bounded k-hop and pattern-match very fast and very light. The "graph should be cheap and ride the Redis I already bound" choice. The maritime edge and any Redis-centric standard tier bind this. |
| **Neo4j** | You want the **mature, batteries-included** graph: the richest Cypher surface, APOC + Graph Data Science (PageRank, community detection, betweenness for *ranking* a link chart), Bloom for analyst-facing exploration, and a large hiring pool. The "this is a graph-*first* product (Gotham-class link analysis is the headline) and I'll pay for the ecosystem" choice. The intel / financial-crime client binds this. |
| **Memgraph** | You want **Neo4j-Bolt/Cypher compatibility** (same `neo4j-driver`, same query strings) but **in-memory, streaming-native** performance and MAGE algorithms — built for *real-time* graph over a moving feed. The "Neo4j semantics, but the graph mutates continuously from a sensor stream and I need streaming triggers" choice. A real-time fusion tier that outgrows FalkorDB but wants Cypher parity binds this. |
| **Postgres + Apache AGE** | You are already running Postgres for R1/R4/R7/R8 and **refuse to add a second datastore** (one-database shops, air-gapped sites, compliance teams that approve exactly one engine). AGE adds `openCypher` *inside* Postgres, so graph traversal joins the same transaction as the canonical write. The "no new engine, even at some traversal-speed cost" choice. The collapse-everything-onto-pg standard tier binds this. |

Decision tie-back ([`README`](../README.md)): *custom spine + OSS breadth.* All four are OSS (FalkorDB, Neo4j Community, Memgraph, AGE); the spine imports the **`GraphStore` port**, never `ioredis` / `neo4j-driver` / `pg`. Swapping FalkorDB→Neo4j for a client is one manifest line.

---

## 2. The `GraphStore` port (recap from `12 §3`)

The contract is fixed in [`12-ADAPTER-CONTRACT.md §3`](../12-ADAPTER-CONTRACT.md); every adapter below implements exactly this, plus the base `Adapter` lifecycle (`init`/`health`/`close`/`capabilities`):

```ts
// spine/ports/graph-store.ts
import type { Adapter, EntityId, TypeName, Json } from './adapter';

export interface GraphNode {
  id: EntityId;                 // == the R1 CanonicalEntity id (UUIDv7); R5 mirrors it
  type: TypeName;               // 'planetar:Vessel' | 'fincrime:Account' | ...
  labels?: string[];            // optional extra labels (e.g. ['Watchlisted'])
  props: Json;                  // denormalized display/filter props (name, mmsi, risk)
}

export interface GraphEdge {
  id: EntityId;                 // == the R1 Link id
  type: TypeName;               // link type: 'same_vessel' | 'transfers_to' | 'owns'
  from: EntityId;               // R1 link.from_id
  to: EntityId;                 // R1 link.to_id
  props: Json;                  // weight, confidence, ts, amount, ...
}

export interface TraversalSpec {
  edgeTypes?: TypeName[];       // restrict to these link types (undefined = all)
  direction?: 'out' | 'in' | 'both';   // default 'both'
  maxHops?: number;             // bound the expansion (k); default 2
  limit?: number;               // cap returned nodes/edges
  nodeFilter?: Json;            // prop predicates on reached nodes (e.g. {type:'planetar:Vessel'})
  maxCostMs?: number;           // soft budget; adapter sets a query timeout from this
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  root: EntityId;
}

export interface Path {
  nodes: EntityId[];            // ordered, a..b inclusive
  edges: EntityId[];            // length nodes.length - 1
  cost: number;                 // hop count or summed edge weight
}

export interface GraphStore extends Adapter {
  upsertNode(n: GraphNode): Promise<void>;
  upsertEdge(e: GraphEdge): Promise<void>;
  neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph>;
  shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null>;
}
```

`neighbors` is "search around" (Gotham's right-click → *Expand*). `shortestPath` is "how are these two connected." A fifth, **pattern/cycle** match (financial-crime ring), rides through `neighbors` with a `nodeFilter`/`edgeTypes` shape in the simple case, and is exposed as a typed **ontology Function** for the complex case (see [`§5.3`](#53-financial-crime-ring-cycle-detection)) — but the Cypher behind all three is shown below so the engine differences are concrete.

---

## 3. R5 is a projection of R1, not a second source of truth

The single most important architectural fact about this role, straight from the design principles ([`00 §3.2`](../00-ARCHITECTURE-OVERVIEW.md): *"the bus is the spine of record… stores are projections of the event log… a new engine for a role is just a new projection consumer"*):

> **Every node and edge in R5 is a copy of an R1 entity/link.** R5 is kept in sync by a **stream (R3) consumer** that tails the bus and applies `upsertNode`/`upsertEdge`. R5 is **rebuildable** ([`10 §R5`](../10-STORAGE-ROLES.md)) — drop it and re-derive from R1's `entity` + `link` tables (or replay R3 from offset 0).

The sync consumer is small and engine-agnostic — it depends only on the `GraphStore` port and the canonical types:

```ts
// spine/projectors/graph-projector.ts  —  the R3→R5 sync consumer
import type { Stream } from '../ports/stream';
import type { GraphStore, GraphNode, GraphEdge } from '../ports/graph-store';
import type { Envelope } from '../model';

/**
 * Tails R3 and projects entity/link state into R5. One consumer per graph engine
 * binding; replaceable; replayable from offset 0 to rebuild the graph from scratch.
 */
export async function runGraphProjector(stream: Stream, graph: GraphStore, from: 'latest' | 0 = 'latest') {
  for await (const env of stream.subscribe(['canonical.entity.*', 'canonical.link.*'], from)) {
    const p = env.payload as Record<string, unknown>;
    if (env.topic.startsWith('canonical.entity.')) {
      const node: GraphNode = {
        id: p.id as string,
        type: p.type as string,
        labels: (p.labels as string[]) ?? [],
        // denormalize only what the link chart shows/filters on — NOT the whole body
        props: { name: p.name ?? null, mmsi: (p.body as any)?.mmsi, risk: (p.body as any)?.risk },
      };
      await graph.upsertNode(node);
    } else {
      const edge: GraphEdge = {
        id: p.id as string,
        type: p.type as string,           // 'same_vessel' | 'transfers_to' | ...
        from: p.from_id as string,
        to: p.to_id as string,
        props: { ...(p.body as object), ts: Number(p.created_ns) },
      };
      await graph.upsertEdge(edge);
    }
    await stream.ack(env.offset);
  }
}
```

Consequences that drop out of "R5 is a projection":

- **Blind engine swap is safe.** Re-pointing a client from FalkorDB to Neo4j is: bind the new engine, run `runGraphProjector(stream, newGraph, 0)` to rebuild, cut over reads. No data migration, because R1 is the source.
- **In-memory engines are legitimate.** Memgraph (RAM-resident) and FalkorDB lose nothing irreplaceable on restart; the projector replays R1. That's why the R5 contract allows `durable` to be *nice-to-have* relative to R1's *must*.
- **`upsertNode`/`upsertEdge` are idempotent.** The projector may re-deliver (at-least-once R3 consume); every adapter's upsert uses `MERGE` (Cypher) or `ON CONFLICT` (AGE/SQL) so replay is a no-op. This is checked by the conformance suite ([`§7`](#7-conformance-suite-hookup)).
- **No write path goes *through* R5.** Surfaces and the kinetic executor write to R1 (via R3). The graph is read-only to everything except the projector — there is exactly one writer, so there's no two-master reconciliation.

The links themselves come from two spine sources, both already built in `planetar-ontology`: the **resolver** emits `same_vessel` links when the dark-vessel kinematic matcher re-identifies a track (`src/resolve/`), and **kinetic Action Types** emit semantic links (`owns`, `transfers_to`, `member_of`) as audited effects (`src/actions/executor.ts`). Both land in R1's `link` table; the projector mirrors both into R5.

---

## 4. Adapters (implementing the exact `GraphStore` port)

All four declare `consistency: 'read-your-writes'` (the projector applies within seconds), `rebuildable: true`, and a p99 target ≤ 100 ms for bounded traversal. They differ in `durable` and `scale`.

### 4.1 `FalkorCanonicalGraph` — FalkorDB (Redis module, `GRAPH.QUERY`)

FalkorDB is a Redis module: one graph key, Cypher shipped via the `GRAPH.QUERY` command over the existing Redis connection. We reuse the same `ioredis` client the R2 hot-cache adapter holds.

```ts
// 40-ADAPTERS/falkordb/graph-store.ts
import Redis from 'ioredis';
import type {
  GraphStore, GraphNode, GraphEdge, Subgraph, Path, TraversalSpec,
  AdapterContext, HealthStatus, EntityId,
} from '../../spine/ports/graph-store';

/** FalkorDB returns Cypher results as [header, rows, stats]; rows are arrays of typed cells. */
type FalkorReply = [string[], unknown[][], string[]];

export class FalkorCanonicalGraph implements GraphStore {
  private redis!: Redis;
  private key!: string;            // the graph name (one FalkorDB graph per client)

  readonly capabilities = {
    consistency: 'read-your-writes',
    durable: true,                 // RDB/AOF persistence; still rebuildable from R1
    rebuildable: true,
    scale: 'vertical',
    p99TargetMs: 100,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { url: string; graph: string };
    this.redis = new Redis(cfg.url);
    this.key = cfg.graph;          // e.g. 'planetar'
    // Index id/type for O(1) anchor lookup; idempotent (IF NOT EXISTS).
    await this.query(`CREATE INDEX FOR (n:Entity) ON (n.id)`).catch(() => {});
  }

  private async query(cypher: string, params: Record<string, unknown> = {}): Promise<FalkorReply> {
    // FalkorDB supports CYPHER param prelude: "CYPHER k=$v <query>" — but ioredis can't bind,
    // so we use the GRAPH.QUERY params form: GRAPH.QUERY key "CYPHER a=1 b='x' <q>".
    const prelude = Object.entries(params)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const q = prelude ? `CYPHER ${prelude} ${cypher}` : cypher;
    return (await this.redis.call('GRAPH.QUERY', this.key, q, '--compact')) as FalkorReply;
  }

  async upsertNode(n: GraphNode): Promise<void> {
    // MERGE on id keeps the projector idempotent; SET overwrites denormalized props.
    await this.query(
      `MERGE (n:Entity {id:$id})
       SET n.type=$type, n.props=$props ${(n.labels ?? []).map((l) => `SET n:${l}`).join(' ')}`,
      { id: n.id, type: n.type, props: JSON.stringify(n.props) },
    );
  }

  async upsertEdge(e: GraphEdge): Promise<void> {
    await this.query(
      `MERGE (a:Entity {id:$from}) MERGE (b:Entity {id:$to})
       MERGE (a)-[r:LINK {id:$id}]->(b)
       SET r.type=$type, r.props=$props`,
      { from: e.from, to: e.to, id: e.id, type: e.type, props: JSON.stringify(e.props) },
    );
  }

  async neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph> {
    const k = spec.maxHops ?? 2;
    const dir = arrow(spec.direction);
    const rel = relPattern(spec.edgeTypes);
    // k-hop "search around": variable-length path 1..k from the anchor.
    const cy = `
      MATCH p = (root:Entity {id:$id})${dir.l}[r${rel}*1..${k}]${dir.r}(m:Entity)
      ${spec.nodeFilter ? `WHERE m.type = $nodeType` : ``}
      WITH nodes(p) AS ns, relationships(p) AS rs
      UNWIND ns AS n WITH collect(DISTINCT n) AS nodes, rs
      UNWIND rs AS e RETURN nodes, collect(DISTINCT e) AS edges
      LIMIT ${spec.limit ?? 500}`;
    const reply = await this.query(cy, {
      id, ...(spec.nodeFilter ? { nodeType: (spec.nodeFilter as any).type } : {}),
    });
    return shredSubgraph(reply, id);
  }

  async shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null> {
    const k = spec.maxHops ?? 6;
    const rel = relPattern(spec.edgeTypes);
    const cy = `
      MATCH (x:Entity {id:$a}), (y:Entity {id:$b}),
            p = shortestPath((x)-[r${rel}*..${k}]-(y))
      RETURN [n IN nodes(p) | n.id] AS nodeIds,
             [e IN relationships(p) | e.id] AS edgeIds,
             length(p) AS cost`;
    const [, rows] = await this.query(cy, { a, b });
    if (!rows.length) return null;
    const [nodeIds, edgeIds, cost] = rows[0] as [string[], string[], number];
    return { nodes: nodeIds, edges: edgeIds, cost };
  }

  async health(): Promise<HealthStatus> {
    try { await this.query(`RETURN 1`); return { ok: true }; }
    catch (e) { return { ok: false, detail: String(e) }; }
  }
  async close(): Promise<void> { this.redis.disconnect(); }
}

// --- small shared Cypher helpers (reused by the Neo4j/Memgraph adapters too) ---
function arrow(d?: 'out' | 'in' | 'both') {
  return d === 'out' ? { l: '-', r: '->' } : d === 'in' ? { l: '<-', r: '-' } : { l: '-', r: '-' };
}
function relPattern(types?: string[]) {
  return types?.length ? `:LINK` : `:LINK`; // FalkorDB: filter type in WHERE (below) for portability
}
function shredSubgraph(reply: FalkorReply, root: EntityId): Subgraph {
  const [, rows] = reply;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const row of rows) {
    for (const n of (row[0] as any[]) ?? []) {
      const props = JSON.parse(n.properties?.props ?? '{}');
      nodes.set(n.properties.id, { id: n.properties.id, type: n.properties.type, props });
    }
    for (const e of (row[1] as any[]) ?? []) {
      edges.set(e.properties.id, {
        id: e.properties.id, type: e.properties.type,
        from: e.src, to: e.dst, props: JSON.parse(e.properties?.props ?? '{}'),
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], root };
}
```

### 4.2 `Neo4jCanonicalGraph` — Neo4j (`neo4j-driver`, Bolt)

The mature engine. The Cypher bodies are the *same shapes* as FalkorDB; the difference is the official driver's parameterized sessions and record-stream API. **Memgraph reuses this exact class** (same `neo4j-driver`, same Bolt protocol, same Cypher) — see [`§4.3`](#43-memgraphcanonicalgraph-memgraph-neo4j-driver-bolt).

```ts
// 40-ADAPTERS/neo4j/graph-store.ts
import neo4j, { Driver, Session, int } from 'neo4j-driver';
import type {
  GraphStore, GraphNode, GraphEdge, Subgraph, Path, TraversalSpec,
  AdapterContext, HealthStatus, EntityId,
} from '../../spine/ports/graph-store';

export class Neo4jCanonicalGraph implements GraphStore {
  protected driver!: Driver;
  protected database = 'neo4j';

  readonly capabilities = {
    consistency: 'read-your-writes',
    durable: true,
    rebuildable: true,
    scale: 'vertical',             // 'sharded' in Neo4j Fabric / clustered enterprise
    p99TargetMs: 100,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { url: string; user: string; password: string; database?: string };
    this.driver = neo4j.driver(cfg.url, neo4j.auth.basic(cfg.user, cfg.password));
    this.database = cfg.database ?? 'neo4j';
    const s = this.session();
    try {
      // Idempotent constraint = the upsert anchor index. Neo4j-specific DDL lives in the adapter.
      await s.run(`CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE`);
    } finally { await s.close(); }
  }

  protected session(mode: 'READ' | 'WRITE' = 'WRITE'): Session {
    return this.driver.session({ database: this.database, defaultAccessMode: mode });
  }

  async upsertNode(n: GraphNode): Promise<void> {
    const s = this.session();
    try {
      const extraLabels = (n.labels ?? []).map((l) => `SET n:\`${l}\``).join(' ');
      await s.run(
        `MERGE (n:Entity {id:$id}) SET n.type=$type, n.props=$props ${extraLabels}`,
        { id: n.id, type: n.type, props: JSON.stringify(n.props) },
      );
    } finally { await s.close(); }
  }

  async upsertEdge(e: GraphEdge): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MERGE (a:Entity {id:$from}) MERGE (b:Entity {id:$to})
         MERGE (a)-[r:LINK {id:$id}]->(b) SET r.type=$type, r.props=$props`,
        { from: e.from, to: e.to, id: e.id, type: e.type, props: JSON.stringify(e.props) },
      );
    } finally { await s.close(); }
  }

  async neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph> {
    const s = this.session('READ');
    try {
      const k = spec.maxHops ?? 2;
      const dir = spec.direction ?? 'both';
      const lr = dir === 'out' ? ['-', '->'] : dir === 'in' ? ['<-', '-'] : ['-', '-'];
      // k-hop "search around"; edge-type + node-type filters as WHERE so they're portable.
      const res = await s.run(
        `MATCH p = (root:Entity {id:$id})${lr[0]}[r:LINK*1..${k}]${lr[1]}(m:Entity)
         WHERE ($edgeTypes IS NULL OR all(e IN relationships(p) WHERE e.type IN $edgeTypes))
           AND ($nodeType  IS NULL OR m.type = $nodeType)
         WITH collect(DISTINCT m) + collect(DISTINCT root) AS ns,
              apoc.coll.toSet([e IN apoc.coll.flatten(collect(relationships(p)))]) AS es
         RETURN ns, es LIMIT 1`,
        { id, edgeTypes: spec.edgeTypes ?? null, nodeType: (spec.nodeFilter as any)?.type ?? null },
        { timeout: int(spec.maxCostMs ?? 1000) },
      );
      return shredBolt(res.records[0], id);
    } finally { await s.close(); }
  }

  async shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null> {
    const s = this.session('READ');
    try {
      const k = spec.maxHops ?? 6;
      const res = await s.run(
        `MATCH (x:Entity {id:$a}),(y:Entity {id:$b}),
               p = shortestPath((x)-[r:LINK*..${k}]-(y))
         WHERE ($edgeTypes IS NULL OR all(e IN relationships(p) WHERE e.type IN $edgeTypes))
         RETURN [n IN nodes(p)|n.id] AS nodeIds,
                [e IN relationships(p)|e.id] AS edgeIds, length(p) AS cost`,
        { a, b, edgeTypes: spec.edgeTypes ?? null },
      );
      if (!res.records.length) return null;
      const r = res.records[0];
      return {
        nodes: r.get('nodeIds'),
        edges: r.get('edgeIds'),
        cost: (r.get('cost') as any).toNumber?.() ?? Number(r.get('cost')),
      };
    } finally { await s.close(); }
  }

  async health(): Promise<HealthStatus> {
    try { await this.driver.verifyConnectivity(); return { ok: true }; }
    catch (e) { return { ok: false, detail: String(e) }; }
  }
  async close(): Promise<void> { await this.driver.close(); }
}

function shredBolt(record: any, root: EntityId): Subgraph {
  if (!record) return { nodes: [], edges: [], root };
  const nodes = (record.get('ns') as any[]).map((n) => ({
    id: n.properties.id, type: n.properties.type, props: JSON.parse(n.properties.props ?? '{}'),
  }));
  const edges = (record.get('es') as any[]).map((e) => ({
    id: e.properties.id, type: e.properties.type,
    from: e.startNodeElementId, to: e.endNodeElementId,
    props: JSON.parse(e.properties.props ?? '{}'),
  }));
  return { nodes, edges, root };
}
```

### 4.3 `MemgraphCanonicalGraph` — Memgraph (`neo4j-driver`, Bolt)

Memgraph is Bolt- and Cypher-compatible, so the adapter is a **subclass of the Neo4j adapter** — it inherits `upsertNode`/`upsertEdge`/`neighbors`/`shortestPath`/`health`/`close` verbatim and only overrides the two engine-specific bits: the schema-index DDL dialect and the capability flags (in-memory).

```ts
// 40-ADAPTERS/memgraph/graph-store.ts
import { Neo4jCanonicalGraph } from '../neo4j/graph-store';
import type { AdapterContext } from '../../spine/ports/graph-store';

export class MemgraphCanonicalGraph extends Neo4jCanonicalGraph {
  // In-memory engine: faster, but a cold restart re-derives from R1 via the projector.
  readonly capabilities = {
    consistency: 'read-your-writes',
    durable: false,                // RAM-resident (periodic snapshots optional); rebuildable covers it
    rebuildable: true,
    scale: 'vertical',
    p99TargetMs: 50,               // in-memory traversal is faster than disk-backed
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { url: string; user?: string; password?: string };
    // Memgraph default has no auth; the driver still wants a (possibly empty) basic auth.
    const url = cfg.url;                                   // e.g. bolt://localhost:7687
    // @ts-expect-error reuse parent driver setup with Memgraph-flavored config
    this.driver = (await import('neo4j-driver')).default
      .driver(url, (await import('neo4j-driver')).default.auth.basic(cfg.user ?? '', cfg.password ?? ''));
    const s = this.session();
    try {
      // Memgraph DDL dialect: index, not CONSTRAINT ... REQUIRE. Same anchor on (Entity, id).
      await s.run(`CREATE INDEX ON :Entity(id)`).catch(() => {});
    } finally { await s.close(); }
  }
}
```

> **The payoff of Bolt compatibility:** one class, `Neo4jCanonicalGraph`, serves two engines. The Cypher for k-hop, shortest path, and ring detection is *byte-for-byte identical* between Neo4j and Memgraph — only the index DDL and the durability flag differ. That is the role/port thesis at its tightest.

### 4.4 `AgeCanonicalGraph` — PostgreSQL + Apache AGE (`pg`, `cypher()` in SQL)

AGE embeds openCypher in Postgres: every Cypher query is wrapped in a `SELECT * FROM cypher('graph', $$ ... $$) AS (...)` SQL call. The win is **no second datastore** — the graph lives in the same Postgres that holds R1/R4/R7/R8, so a graph traversal can join the canonical write transaction.

```ts
// 40-ADAPTERS/age/graph-store.ts
import { Pool, PoolClient } from 'pg';
import type {
  GraphStore, GraphNode, GraphEdge, Subgraph, Path, TraversalSpec,
  AdapterContext, HealthStatus, EntityId,
} from '../../spine/ports/graph-store';

export class AgeCanonicalGraph implements GraphStore {
  private pool!: Pool;
  private graph!: string;            // AGE graph name

  readonly capabilities = {
    consistency: 'read-your-writes',
    durable: true,                   // it's Postgres; full WAL durability
    rebuildable: true,
    scale: 'vertical',
    p99TargetMs: 100,                // AGE traversal is slower than native graph engines; still in budget for bounded k
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { connection: any; graph: string };
    this.pool = new Pool(cfg.connection);
    this.graph = cfg.graph;          // e.g. 'planetar'
    const c = await this.pool.connect();
    try {
      await c.query(`LOAD 'age'`);
      await c.query(`SET search_path = ag_catalog, "$user", public`);
      // create_graph is not idempotent; guard it.
      await c.query(
        `SELECT create_graph($1) WHERE NOT EXISTS
           (SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1)`, [this.graph]);
    } finally { c.release(); }
  }

  /** Every AGE call: LOAD 'age' + search_path on the connection, then the cypher() wrapper. */
  private async cypher<R = any>(client: PoolClient, body: string, columns: string): Promise<R[]> {
    await client.query(`LOAD 'age'`);
    await client.query(`SET search_path = ag_catalog, "$user", public`);
    const sql = `SELECT * FROM cypher('${this.graph}', $$ ${body} $$) AS (${columns})`;
    const { rows } = await client.query(sql);
    return rows as R[];
  }

  async upsertNode(n: GraphNode): Promise<void> {
    const c = await this.pool.connect();
    try {
      // AGE doesn't bind params into cypher() like Bolt; inline a JSON-escaped literal map.
      const props = jsonLit({ id: n.id, type: n.type, props: n.props });
      await this.cypher(c, `MERGE (x:Entity {id:'${esc(n.id)}'}) SET x = ${props}`, `x agtype`);
    } finally { c.release(); }
  }

  async upsertEdge(e: GraphEdge): Promise<void> {
    const c = await this.pool.connect();
    try {
      const props = jsonLit({ id: e.id, type: e.type, props: e.props });
      await this.cypher(c,
        `MERGE (a:Entity {id:'${esc(e.from)}'})
         MERGE (b:Entity {id:'${esc(e.to)}'})
         MERGE (a)-[r:LINK {id:'${esc(e.id)}'}]->(b) SET r = ${props}`,
        `r agtype`);
    } finally { c.release(); }
  }

  async neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph> {
    const c = await this.pool.connect();
    try {
      const k = spec.maxHops ?? 2;
      const dir = spec.direction ?? 'both';
      const lr = dir === 'out' ? ['-', '->'] : dir === 'in' ? ['<-', '-'] : ['-', '-'];
      const rows = await this.cypher<{ vlabel: string; v: any }>(c,
        `MATCH p = (root:Entity {id:'${esc(id)}'})${lr[0]}[r:LINK*1..${k}]${lr[1]}(m:Entity)
         UNWIND nodes(p) AS v RETURN DISTINCT v
         LIMIT ${spec.limit ?? 500}`,
        `v agtype`);
      // AGE returns agtype JSON; shred nodes, then a second query for the edges on the same paths.
      const edgeRows = await this.cypher<{ e: any }>(c,
        `MATCH p = (root:Entity {id:'${esc(id)}'})${lr[0]}[r:LINK*1..${k}]${lr[1]}(m:Entity)
         UNWIND relationships(p) AS e RETURN DISTINCT e`,
        `e agtype`);
      return shredAge(rows, edgeRows, id, spec);
    } finally { c.release(); }
  }

  async shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null> {
    const c = await this.pool.connect();
    try {
      const k = spec.maxHops ?? 6;
      // AGE has no shortestPath() builtin yet; bound the variable-length match and take the min by length.
      const rows = await this.cypher<{ ids: any; eids: any; cost: any }>(c,
        `MATCH p = (x:Entity {id:'${esc(a)}'})-[r:LINK*..${k}]-(y:Entity {id:'${esc(b)}'})
         RETURN [n IN nodes(p) | n.id] AS ids,
                [e IN relationships(p) | e.id] AS eids,
                length(p) AS cost
         ORDER BY cost ASC LIMIT 1`,
        `ids agtype, eids agtype, cost agtype`);
      if (!rows.length) return null;
      const r = rows[0];
      return { nodes: ag(r.ids), edges: ag(r.eids), cost: Number(ag(r.cost)) };
    } finally { c.release(); }
  }

  async health(): Promise<HealthStatus> {
    try { const c = await this.pool.connect(); await c.query(`SELECT 1`); c.release(); return { ok: true }; }
    catch (e) { return { ok: false, detail: String(e) }; }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

// --- AGE helpers: agtype literal encoding + parsing ---
const esc = (s: string) => s.replace(/'/g, "''");
const jsonLit = (o: unknown) => JSON.stringify(o).replace(/'/g, "''");
const ag = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);   // agtype → JS
function shredAge(nodeRows: { v: any }[], edgeRows: { e: any }[], root: EntityId, spec: TraversalSpec): Subgraph {
  const want = (spec.nodeFilter as any)?.type;
  const nodes = nodeRows.map((r) => ag(r.v)).filter((v) => !want || v.properties.type === want)
    .map((v) => ({ id: v.properties.id, type: v.properties.type, props: v.properties.props ?? {} }));
  const edges = edgeRows.map((r) => ag(r.e))
    .filter((e) => !spec.edgeTypes?.length || spec.edgeTypes.includes(e.properties.type))
    .map((e) => ({ id: e.properties.id, type: e.properties.type,
                   from: String(e.start_id), to: String(e.end_id), props: e.properties.props ?? {} }));
  return { nodes, edges, root };
}
```

---

## 5. The three flagship traversals (the Cypher that earns R5)

These are the queries the adapters wrap. Shown standalone so the engine differences are visible; the bodies are what the [`§4`](#4-adapters-implementing-the-exact-graphstore-port) methods send.

### 5.1 k-hop neighborhood expansion — "search around" (Gotham *Expand*)

Right-click a vessel in the link chart → *Expand 2 hops* → see everything within two links. This is `neighbors(id, {maxHops:2})`.

```cypher
// "search around" entityId out to 2 hops, any link type, undirected
MATCH p = (root:Entity {id: $id})-[r:LINK*1..2]-(m:Entity)
RETURN nodes(p) AS nodes, relationships(p) AS edges
LIMIT 500
```

Filtered variant — expand only `same_vessel` + `owns` links, only reach `planetar:Vessel` nodes (the spine passes these via `TraversalSpec.edgeTypes` / `nodeFilter`):

```cypher
MATCH p = (root:Entity {id: $id})-[r:LINK*1..2]-(m:Entity)
WHERE all(e IN relationships(p) WHERE e.type IN ['same_vessel','owns'])
  AND m.type = 'planetar:Vessel'
RETURN nodes(p) AS nodes, relationships(p) AS edges
LIMIT 500
```

In `doibio` this is the **ontology graph view**: click a `Compound` → expand to its `Target`, `Assay`, `Paper` neighbors — same query shape, different `type` values, run over the 35-schema object/link model.

### 5.2 shortest path — "how are these two connected"

Given two accounts (or a vessel and a person of interest), the shortest chain of links between them. This is `shortestPath(a, b, {maxHops:6})`.

```cypher
// shortest connection between two entities, ≤ 6 hops
MATCH (x:Entity {id: $a}), (y:Entity {id: $b}),
      p = shortestPath((x)-[r:LINK*..6]-(y))
RETURN [n IN nodes(p) | n.id]      AS nodeIds,
       [e IN relationships(p) | e.id] AS edgeIds,
       length(p)                   AS cost
```

(FalkorDB and Neo4j/Memgraph have `shortestPath()` natively; AGE [`§4.4`](#44-agecanonicalgraph-postgresql--apache-age-pg-cypher-in-sql) emulates it by taking the min-length variable-length match — same result, the adapter hides the difference.)

### 5.3 financial-crime ring (cycle) detection

The intel/financial-crime flagship: find **money-movement rings** — a chain of `transfers_to` edges that returns to where it started (a laundering cycle), or two accounts that share an owner *and* transact (structuring). This is a cycle pattern, exposed as a typed ontology **Function** `detectTransferRing(seed, maxLen)`:

```cypher
// closed loop of `transfers_to` of length 2..6 starting and ending at $seed
MATCH p = (a:Entity {id: $seed})-[r:LINK*2..6]->(a)
WHERE all(e IN relationships(p) WHERE e.type = 'transfers_to')
  AND reduce(amt = 0.0, e IN relationships(p) | amt + coalesce(e.props.amount, 0.0)) > $minTotal
RETURN [n IN nodes(p) | n.id]      AS ringNodeIds,
       [e IN relationships(p) | e.id] AS ringEdgeIds,
       length(p)                   AS ringLength
ORDER BY ringLength ASC
LIMIT 50
```

A second classic — **shared-beneficiary structuring** (two accounts feeding one mule, common owner) — is a fixed-shape pattern, not a variable-length cycle:

```cypher
// two distinct accounts that both transfer to a common account AND share an owner
MATCH (o:Entity)-[:LINK {type:'owns'}]->(a1:Entity)-[:LINK {type:'transfers_to'}]->(mule:Entity),
      (o)-[:LINK {type:'owns'}]->(a2:Entity)-[:LINK {type:'transfers_to'}]->(mule)
WHERE a1.id < a2.id                       // unordered pair, once
RETURN o.id AS owner, a1.id, a2.id, mule.id AS beneficiary
```

These run on the **same projected graph** the maritime client uses for `same_vessel` expansion — the role is identical; only the `type` vocabulary (`transfers_to`/`owns` vs `same_vessel`/`co_transited`) and the surface (a financial-crime dossier vs a vessel link chart) differ. That is the [`11 §4`](../11-CAPABILITY-ROLE-MAP.md) universality claim made concrete: *Gotham link analysis and a dark-vessel link chart are the same role footprint over one spine.*

---

## 6. Comparison table

| Engine | Consistency (R5) | Scale | p99 (bounded k-hop) | Durability | When to choose |
|---|---|---|---|---|---|
| **FalkorDB** *(default)* | read-your-writes | vertical (Redis cluster) | **~5–30 ms** (GraphBLAS sparse-matrix core) | RDB/AOF; rebuildable from R1 | already run Redis; want graph cheap on the box you have; edge + Redis-centric standard tiers |
| **Neo4j** | read-your-writes | vertical → sharded (Fabric/cluster) | ~10–60 ms | full, disk-backed | graph-*first* product; need APOC + GDS (PageRank/community) + Bloom; large ecosystem; intel/fincrime client |
| **Memgraph** | read-your-writes | vertical (in-memory) | **~3–20 ms** (RAM-resident) | not durable (snapshots); rebuildable from R1 | Neo4j Cypher/Bolt parity *and* in-memory streaming-real-time; continuously-mutating sensor graph |
| **Postgres + AGE** | read-your-writes | vertical | ~30–150 ms (slower; SQL-wrapped Cypher, no `shortestPath()` builtin) | full WAL durability | refuse a second datastore; one-engine/air-gapped/compliance shops; graph joins the canonical write txn |

p99 figures are order-of-magnitude expectations for a *bounded* (k ≤ 3, limit ≤ 500) traversal on a graph that fits the box — the R5 contract's ≤ 100 ms ([`10 §R5`](../10-STORAGE-ROLES.md)) is met by all four for bounded k; **AGE is the one that needs k kept small** and is why the adapter sets a query timeout from `TraversalSpec.maxCostMs`. None of these are measured planetar benchmarks (the broker's `p50 80–140 ns` is the only measured number in the platform); they are the engines' documented ballparks and must be re-measured per client graph before being quoted.

---

## 7. Conformance-suite hookup

All four adapters pass the **same** engine-agnostic `GraphStore` suite ([`12 §5`](../12-ADAPTER-CONTRACT.md) pattern). Green across the matrix = a client can bind any of them and the spine (resolver link-emit, ontology graph view, financial-crime Functions) behaves identically.

```ts
// 40-ADAPTERS/_conformance/graph-store.spec.ts
import { test, expect } from 'vitest';
import type { GraphStore } from '../../spine/ports/graph-store';
import { ROLE_CONTRACT, satisfies } from '../../spine/ports/contracts';

export function graphStoreConformance(make: () => GraphStore) {
  test('upsertNode/upsertEdge round-trip via neighbors', async () => {
    const g = make(); await g.init(testCtx());
    await g.upsertNode({ id: 'A', type: 'fincrime:Account', props: { risk: 0.9 } });
    await g.upsertNode({ id: 'B', type: 'fincrime:Account', props: {} });
    await g.upsertEdge({ id: 'e1', type: 'transfers_to', from: 'A', to: 'B', props: { amount: 9000 } });
    const sub = await g.neighbors('A', { maxHops: 1 });
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(sub.edges.map((e) => e.id)).toEqual(['e1']);
  });

  test('upserts are IDEMPOTENT (projector may re-deliver from R3)', async () => {
    const g = make(); await g.init(testCtx());
    await g.upsertNode({ id: 'A', type: 'X', props: {} });
    await g.upsertNode({ id: 'A', type: 'X', props: {} });          // replay
    await g.upsertEdge({ id: 'e', type: 't', from: 'A', to: 'A', props: {} });
    await g.upsertEdge({ id: 'e', type: 't', from: 'A', to: 'A', props: {} }); // replay
    const sub = await g.neighbors('A', { maxHops: 1 });
    expect(sub.nodes.filter((n) => n.id === 'A')).toHaveLength(1);   // no dup node
    expect(sub.edges.filter((e) => e.id === 'e')).toHaveLength(1);   // no dup edge
  });

  test('k-hop bound is honored (search-around does not over-expand)', async () => {
    const g = make(); await g.init(testCtx());
    // chain A->B->C->D ; from A, maxHops:2 must reach C but NOT D
    for (const id of ['A', 'B', 'C', 'D']) await g.upsertNode({ id, type: 'X', props: {} });
    await g.upsertEdge({ id: 'ab', type: 't', from: 'A', to: 'B', props: {} });
    await g.upsertEdge({ id: 'bc', type: 't', from: 'B', to: 'C', props: {} });
    await g.upsertEdge({ id: 'cd', type: 't', from: 'C', to: 'D', props: {} });
    const ids = (await g.neighbors('A', { maxHops: 2, direction: 'out' })).nodes.map((n) => n.id);
    expect(ids).toContain('C'); expect(ids).not.toContain('D');
  });

  test('shortestPath finds the minimal chain (and null when disconnected)', async () => {
    const g = make(); await g.init(testCtx());
    for (const id of ['A', 'B', 'C', 'Z']) await g.upsertNode({ id, type: 'X', props: {} });
    await g.upsertEdge({ id: 'ab', type: 't', from: 'A', to: 'B', props: {} });
    await g.upsertEdge({ id: 'bc', type: 't', from: 'B', to: 'C', props: {} });
    const p = await g.shortestPath('A', 'C', { maxHops: 6 });
    expect(p?.cost).toBe(2);
    expect(p?.nodes).toEqual(['A', 'B', 'C']);
    expect(await g.shortestPath('A', 'Z', { maxHops: 6 })).toBeNull();
  });

  test('edgeType filter restricts the traversal', async () => {
    const g = make(); await g.init(testCtx());
    for (const id of ['A', 'B', 'C']) await g.upsertNode({ id, type: 'X', props: {} });
    await g.upsertEdge({ id: 'good', type: 'transfers_to', from: 'A', to: 'B', props: {} });
    await g.upsertEdge({ id: 'noise', type: 'follows', from: 'A', to: 'C', props: {} });
    const sub = await g.neighbors('A', { maxHops: 1, edgeTypes: ['transfers_to'] });
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);   // C excluded
  });

  test('declares capabilities that satisfy the R5 contract', () => {
    expect(satisfies(ROLE_CONTRACT['graph'], make().capabilities)).toBe(true);
  });
}
```

```ts
// 40-ADAPTERS/_conformance/graph-store.matrix.spec.ts  — same suite, every engine
import { graphStoreConformance } from './graph-store.spec';
import { FalkorCanonicalGraph } from '../falkordb/graph-store';
import { Neo4jCanonicalGraph } from '../neo4j/graph-store';
import { MemgraphCanonicalGraph } from '../memgraph/graph-store';
import { AgeCanonicalGraph } from '../age/graph-store';

// CI services (docker): falkordb/falkordb, neo4j:5, memgraph/memgraph, apache/age.
graphStoreConformance(() => new FalkorCanonicalGraph());
graphStoreConformance(() => new Neo4jCanonicalGraph());
graphStoreConformance(() => new MemgraphCanonicalGraph());   // inherits Neo4j class; Bolt-compatible
graphStoreConformance(() => new AgeCanonicalGraph());
```

The suite asserts the five R5 invariants that matter for blind swappability: **round-trip via `neighbors`**, **idempotent upsert** (the projector re-delivers), **k-hop bound honored**, **`shortestPath` minimal + null-on-disconnect**, **edge-type filter restricts**, plus **`capabilities` satisfy `ROLE_CONTRACT['graph']`**. The idempotency test is the load-bearing one here: it's what licenses the at-least-once R3→R5 projector ([`§3`](#3-r5-is-a-projection-of-r1-not-a-second-source-of-truth)).

---

## 8. Which manifest tiers / clients bind this

R5 is bound **only when a capability needs it** — `link-analysis`, `dark-vessel-reid` (uses graph for the `same_vessel` chart), or any dossier/financial-crime feature ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md): `link-analysis = {R5, R1}`). A pure CRM-reporting client never binds R5 ([`11 §3`](../11-CAPABILITY-ROLE-MAP.md)).

| Manifest tier ([`13 §1`](../13-CLIENT-MANIFEST.md)) | R5 binding | Rationale |
|---|---|---|
| `edge` / `air-gapped` | **postgres-age** *(or unbound)* | maritime edge ([`13 §1`](../13-CLIENT-MANIFEST.md)) binds `graph: postgres-age` — one small pg, no second service offline; if the box already runs Redis, **falkordb** instead |
| `standard` | **falkordb** | ride the Redis the standard tier already binds for R2; cheap, fast, one fewer service than Neo4j |
| `scale` | **neo4j** *(graph-first)* or **memgraph** *(real-time)* | dedicated graph cluster when link analysis is the headline (Neo4j + GDS) or the graph mutates continuously from the feed (Memgraph) |

Across the four reference clients ([`README §The four reference clients`](../README.md)):

- **Intel / financial-crime graph** — the **graph-first** client; R5 is its *primary* role, not an accessory. Binds **Neo4j** for APOC + Graph Data Science (PageRank to rank a watchlist, community detection to cluster a network, betweenness to find the broker in a ring) + Bloom for analyst exploration. The ring-detection Cypher in [`§5.3`](#53-financial-crime-ring-cycle-detection) is its signature query; dossiers are `neighbors()` expansions rendered as a chart.
- **Maritime / defence (`planetar`)** — binds **postgres-age** at the edge today ([`13 §1`](../13-CLIENT-MANIFEST.md): `graph: postgres-age`) so an air-gapped boat runs zero extra services; the `same_vessel` links the dark-vessel matcher emits (built, `planetar-ontology/src/resolve/`) are the graph. Its scale-up tier ([`13 §3`](../13-CLIENT-MANIFEST.md)) would move R5 to **falkordb** (already running Redis) or **Memgraph** (real-time fusion graph).
- **Biotech / research CRM (`doibio`)** — binds a graph engine to power the **ontology graph view** over its 35-schema object/link model (Compound↔Target↔Assay↔Paper); **falkordb** is the natural fit (light, single-tenant research scale). The traversals are the same `neighbors()`/`shortestPath()` shapes as maritime, different `type` vocabulary.
- **Generic enterprise CRM+ops** — typically **does not bind R5** (clean Salesforce parity: objects + reporting + automation needs `{R1, R4, R9, R14}`, not graph). It binds R5 only if it adds an account-hierarchy / influence-graph feature, in which case **postgres-age** (no new engine on the pg-centric topology) is the default.

The point holds across all four: **the engine under R5 changes per client and tier (falkordb / neo4j / memgraph / postgres-age); the resolver's link-emit, the ontology's graph view, the financial-crime ring Functions, and the link-chart surface do not.** And because R5 is a rebuildable projection of R1, the swap is *bind new engine → run the projector from offset 0 → cut over reads* — no migration. That invariance, proven by one conformance suite passing on four engines behind one port, is the deliverable.
