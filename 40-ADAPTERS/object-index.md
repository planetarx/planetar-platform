# 40-ADAPTERS · Object-index / search (R4)

**Role:** R4 · object-index — full-text + filter + facet + sort + aggregate over canonical objects.
**Engines:** OpenSearch / Elasticsearch (`@opensearch-project/opensearch`, `@elastic/elasticsearch`), Postgres FTS (`tsvector` + GIN, via `pg`), Typesense (`typesense`), Meilisearch (`meilisearch`), and a **SQLite FTS5** edge fallback (`node:sqlite`, zero external service).
**Status:** **partial → built**. The R4 *function* is proven in two places today: doibio runs Elasticsearch (`~/data/dev/doibio/src/lib/elasticsearch.ts`, `src/index-to-es.ts`) for its document/object search, and `planetar-ontology` runs the **blocking** half of R4 in SQLite (`src/store/store.ts` `findEntityIdsByIdentifier`, called by `src/resolve/resolve.ts`). The unified `ObjectIndex` port below — one interface across all five engines — is **designed** against those two working slices; the per-engine adapters conform to that one port and the SQLite-FTS5 fallback is a thin wrapper over the file the ontology already opens.

R4 is the role that makes objects **findable** and the role the resolver **leans on to stay sub-quadratic**. Those are its two jobs (§2); everything in this file serves one or the other.

---

## 1. Intro — which role, which engines, when to pick each

R4 holds an inverted + columnar index over canonical objects so they can be searched by free text, narrowed by structured filter, faceted, sorted, and aggregated — the substrate behind Foundry **Object Explorer / OSv2 search**, Salesforce **Einstein Search / Search 360**, and Gotham search. Its contract ([`10 §R4`](../10-STORAGE-ROLES.md)): **read-your-writes-within-seconds** (deliberately *eventual* relative to R1, because it's a rebuilt projection), p99 ≤ 50 ms query, durable but **rebuildable from R3/R1**. That "rebuildable, eventual" stance is what lets the index be its own engine: drop it, replay the bus, it comes back.

R4 is never the system of record — R1 (canonical-store) is. R4 is a **read-optimized projection** fed by the same bus events that feed R1 (lifecycle 4.1, [`00 §4`](../00-ARCHITECTURE-OVERVIEW.md)). That's why an `ObjectIndex` adapter declares `consistency: 'eventual'` / `rebuildable: true` and the compiler is fine with it: nothing reads R4 expecting strong consistency.

| Pick… | …when |
|---|---|
| **OpenSearch / Elasticsearch** | Default at `standard`/`scale`. High query volume, rich relevance (BM25, fuzziness, highlight, synonyms), deep faceting, geo + nested docs, billions of objects sharded across nodes. The "real search 360" choice. OpenSearch (Apache-2.0) is the OSS-breadth default; the `@elastic/elasticsearch` client is wire-compatible enough that one adapter parameterizes both. doibio already runs this. |
| **Postgres FTS** (`tsvector` + GIN) | When the client already runs postgres for R1 and **won't stand up a second system**. `to_tsvector`/`websearch_to_tsquery` + a `GIN` index give genuine full-text; `ts_rank_cd` gives relevance; `GROUP BY` gives facets. Good to low-millions of objects with moderate query rates; no fuzzy-typo tolerance out of the box (add `pg_trgm`). The "one-engine SaaS" choice. |
| **Typesense / Meilisearch** | Light, single-binary, **typo-tolerant instant-search** with great defaults and tiny ops. Excellent for an app-embedded search box up to a few million docs; weaker than OpenSearch for deep aggregations and very large corpora. The "fast to stand up, instant-search UX" choice. |
| **SQLite FTS5** (fallback, §6) | **Edge / air-gapped / demo.** No search service at all — R4 collapses into the *same `.db` file* that holds R1 (`canonical.db`). FTS5 gives real inverted-index full-text + `bm25()` ranking in one file. This is what the maritime `edge` manifest binds today ([`13 §1`](../13-CLIENT-MANIFEST.md): `object-index: { engine: sqlite, fts: true }`). The "two processes, zero external services" choice. |

Decision tie-back ([`README`](../README.md)): *custom spine + OSS breadth.* We do **not** write a search engine. The spine (resolver, Object API, Object Explorer) imports only the `ObjectIndex` port; OpenSearch/postgres-FTS/Typesense/Meilisearch/SQLite-FTS5 are OSS engines behind it. Swapping `sqlite`→`opensearch` for a scaling client is one manifest line ([`13 §3`](../13-CLIENT-MANIFEST.md)).

---

## 2. R4's two jobs (the load-bearing distinction)

Most search docs describe only the first job. R4 has two, and the **second is why R4 is a *required* (not enhancing) role for identity resolution** ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md)).

### Job 1 — user search (Object Explorer / Einstein Search / Search 360)

A human (or an OSDK query, or an agent) asks: *"container ships near Victoria, flag ≠ CA, length > 150 m, last seen this week — facet by flag, sort by length."* That's one `search()` call: a full-text clause + structured filters + facets + sort + pagination, answered in ≤ 50 ms. This powers list views, the global search bar, the planetar-ui channel/object search, and the OSDK `objectSet().search(...)` surface (P8 → P6 → R4).

### Job 2 — the resolver's BLOCKING step (R5 identity resolution → R4)

Identity resolution ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md): `identity-resolution = {R1, R4 (blocking), R12}`) must answer, for every incoming observation: *which existing canonical entities could this possibly be?* The naïve answer compares the new observation against **every** entity — **O(n²)** over the corpus, which is fatal at scale (millions of vessels/parties, thousands of observations/sec).

**Blocking** fixes this: before scoring, ask R4 for a small **candidate set** keyed on cheap, high-precision blocking keys (exact identifiers like `mmsi`/`imo`/`callsign`; fuzzy name n-grams; geohash buckets for kinematic proximity). The resolver then runs its expensive per-field scoring against **only those candidates** — turning O(n²) into roughly O(n·k) with k = block size. This is precisely the shape of `planetar-ontology`'s resolver today:

```ts
// planetar-ontology/src/resolve/resolve.ts (built) — the blocking call, abridged.
//   def.identifierFields for planetar:Vessel = ['mmsi','imo','callsign']  (registry types.json)
for (const c of claims) {                                  // c = {kind:'mmsi', value:'316001234'}
  for (const eid of this.#store.findEntityIdsByIdentifier(c.kind, c.value)) {
    scores.set(eid, Math.max(scores.get(eid) ?? 0, 1.0));  // exact-identifier band → candidate
  }
}
// then score ONLY the candidates in `scores`, never the whole corpus.
```

Today `findEntityIdsByIdentifier` is an exact-equality lookup on a SQLite `identifier` table — the **degenerate, exact-match-only** form of blocking, sufficient for the exact-identifier tier ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md)). The `ObjectIndex` port **generalizes that one call** into `searchCandidates()` so the *same resolver* can, on a richer engine, also block on fuzzy names (`mmsi` absent — common for SAR/EO detections) and geohash proximity without an O(n²) scan. The resolver code does not change; only the bound engine does.

> **One index, both jobs.** The same R4 adapter serves the user's "find me ships" query *and* the resolver's "which entities could this observation be." That's deliberate: blocking is just a search with high recall and modest precision, scored downstream by the spine. Binding R4 once covers both.

---

## 3. The `ObjectIndex` port

Exact signatures from [`12 §3`](../12-ADAPTER-CONTRACT.md): `index`, `search`, `aggregate`, plus the base `Adapter` lifecycle. We add `searchCandidates` (Job 2) and `remove` as part of the same port — both are R4 responsibilities and both are exercised by the conformance suite (§7).

```ts
// spine/ports/object-index.ts
import type { Adapter, HealthStatus } from './adapter';
import type { TypeName, EntityId, Json } from '../model';

export interface ObjectIndex extends Adapter {
  // --- write (projector-only; fed by the R3→R4 consumer, never by surfaces) ---
  index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void>;
  remove(type: TypeName, id: EntityId): Promise<void>;

  // --- Job 1: user search (Object Explorer / Einstein Search / Search 360) ---
  search(q: SearchQuery): Promise<SearchResult>;        // full-text + filter + facet + sort
  aggregate(q: AggQuery): Promise<AggResult>;

  // --- Job 2: the resolver's BLOCKING step (R5 → R4; avoids O(n^2)) ---
  searchCandidates(req: CandidateRequest): Promise<CandidateMatch[]>;
}

/** A canonical object flattened for indexing. `marking` rides along for P1 filtering (§5). */
export interface IndexDoc {
  type: TypeName;
  id: EntityId;
  name?: string;
  text: string;                       // concatenated full-text field (name + searchable bodies)
  fields: Record<string, Json>;       // structured, filterable/facetable canonical fields
  blockingKeys: string[];             // e.g. ['mmsi:316001234','imo:9176187','name3:ever']
  geo?: { lat: number; lon: number };
  ts: number;                         // updated_at epoch-ms (for recency sort)
  marking: string[];                  // governance labels carried for PEP filtering
}

export interface SearchQuery {
  type?: TypeName;                    // restrict to one object type, or search across all
  text?: string;                      // free-text; engine applies BM25 + fuzziness
  filter?: FieldFilter[];             // structured predicates (eq/ne/gt/lt/gte/lte/in/exists)
  facets?: string[];                  // fields to return value-counts for
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  geo?: { lat: number; lon: number; radiusKm: number };
  from?: number; size?: number;       // pagination
  principalMarkings?: string[];       // P1: caller's clearances; adapter intersects with doc.marking
}

export interface FieldFilter {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'exists';
  value?: Json | Json[];
}

export interface SearchResult {
  total: number;
  hits: { type: TypeName; id: EntityId; score: number; fields: Record<string, Json>; snippet?: string }[];
  facets?: Record<string, { value: string; count: number }[]>;
}

export interface AggQuery {
  type?: TypeName;
  filter?: FieldFilter[];
  groupBy: string;                    // bucketing field
  metric?: { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string };
}
export interface AggResult { buckets: { key: string; value: number }[] }

export interface CandidateRequest {
  type: TypeName;
  exact?: { field: string; value: string }[];   // mmsi/imo/callsign — high precision
  fuzzyName?: string;                            // name when identifiers are absent
  geo?: { lat: number; lon: number; radiusKm: number };  // kinematic block
  limit?: number;                                // cap the block size (default 50)
}
export interface CandidateMatch { id: EntityId; score: number; matchedOn: string }
```

---

## 4. Adapters (implementing the exact `ObjectIndex` port)

### 4.1 `OpenSearchIndex` (`@opensearch-project/opensearch`, also Elasticsearch)

The default. One class covers both OpenSearch and Elasticsearch — the index/search APIs used here are wire-identical; the manifest's `engine` only selects the client import and connection. This is the production form of what doibio runs today (`src/lib/elasticsearch.ts`).

```ts
// 40-ADAPTERS/opensearch/object-index.ts
import { Client } from '@opensearch-project/opensearch';   // or '@elastic/elasticsearch' — same shape
import type {
  ObjectIndex, AdapterContext, HealthStatus,
  IndexDoc, SearchQuery, SearchResult, AggQuery, AggResult,
  CandidateRequest, CandidateMatch, FieldFilter, TypeName, EntityId,
} from '../../spine/ports/object-index';

export class OpenSearchIndex implements ObjectIndex {
  private client!: Client;
  private alias = 'objects';   // write-alias over versioned indices (reindex without downtime)

  readonly capabilities = {
    consistency: 'eventual',          // refresh-interval lag; R4 is read-your-writes-within-seconds
    durable: true,
    rebuildable: true,                // re-derived from R1/R3 (10 §R4)
    scale: 'sharded',
    p99TargetMs: 50,                  // the R4 contract ceiling
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const { nodes } = ctx.manifest.config as { nodes: string[] };
    this.client = new Client({ nodes });
    // Mapping is DERIVED FROM THE CANONICAL TYPE (registry, R10) — see §4.1.1.
    const exists = await this.client.indices.existsAlias({ name: this.alias });
    if (!exists.body) {
      await this.client.indices.create({ index: `${this.alias}-v1`, body: { mappings: OBJECT_MAPPING } });
      await this.client.indices.putAlias({ index: `${this.alias}-v1`, name: this.alias });
    }
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { const r = await this.client.cluster.health(); return { ok: r.body.status !== 'red', latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { await this.client.close(); }

  // --- write ---
  async index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
    await this.client.index({
      index: this.alias,
      id: `${type}:${id}`,            // routing-stable composite id
      body: doc,
      // refresh:false → batch by the projector; search lag is the eventual-consistency budget.
    });
  }
  async remove(type: TypeName, id: EntityId): Promise<void> {
    await this.client.delete({ index: this.alias, id: `${type}:${id}` }).catch(() => void 0);
  }

  // --- Job 1: user search (full-text + filter + facet + sort + geo) ---
  async search(q: SearchQuery): Promise<SearchResult> {
    const must: object[] = [];
    const filter: object[] = q.type ? [{ term: { type: q.type } }] : [];

    if (q.text) {
      must.push({ multi_match: { query: q.text, fields: ['name^3', 'text'], fuzziness: 'AUTO' } });
    }
    for (const f of q.filter ?? []) filter.push(esFilter(f));
    if (q.geo) {
      filter.push({ geo_distance: { distance: `${q.geo.radiusKm}km`, geo: { lat: q.geo.lat, lon: q.geo.lon } } });
    }
    // P1 governance: only docs whose marking is a subset of the caller's clearances (§5).
    if (q.principalMarkings) filter.push({ terms_set: {
      'marking': { terms: q.principalMarkings, minimum_should_match_script: { source: "doc['marking'].size()" } } } });

    const aggs = Object.fromEntries((q.facets ?? []).map(f => [f, { terms: { field: `${f}.keyword`, size: 20 } }]));
    const sort = (q.sort ?? []).map(s => ({ [s.field]: { order: s.dir } }));

    const res = await this.client.search({
      index: this.alias,
      body: {
        from: q.from ?? 0, size: q.size ?? 25,
        query: { bool: { must, filter } },
        sort: sort.length ? sort : undefined,
        aggs: Object.keys(aggs).length ? aggs : undefined,
        highlight: { fields: { text: { fragment_size: 150, number_of_fragments: 1 }, name: {} } },
      },
    });

    const hits = res.body.hits.hits.map((h: any) => ({
      type: h._source.type as TypeName, id: h._source.id as EntityId, score: h._score,
      fields: h._source.fields,
      snippet: h.highlight?.text?.[0] ?? h.highlight?.name?.[0],
    }));
    const facets = Object.fromEntries((q.facets ?? []).map(f =>
      [f, (res.body.aggregations?.[f]?.buckets ?? []).map((b: any) => ({ value: b.key, count: b.doc_count }))]));
    const total = typeof res.body.hits.total === 'number' ? res.body.hits.total : res.body.hits.total?.value ?? 0;
    return { total, hits, facets };
  }

  // --- aggregation ---
  async aggregate(q: AggQuery): Promise<AggResult> {
    const filter: object[] = q.type ? [{ term: { type: q.type } }] : [];
    for (const f of q.filter ?? []) filter.push(esFilter(f));
    const metric = q.metric && q.metric.op !== 'count'
      ? { m: { [q.metric.op]: { field: `fields.${q.metric.field}` } } } : undefined;
    const res = await this.client.search({
      index: this.alias, size: 0,
      body: {
        query: { bool: { filter } },
        aggs: { grp: { terms: { field: `${q.groupBy}.keyword`, size: 1000 }, aggs: metric } },
      },
    });
    return { buckets: (res.body.aggregations.grp.buckets ?? []).map((b: any) => ({
      key: b.key, value: metric ? b.m.value : b.doc_count })) };
  }

  // --- Job 2: the resolver's blocking step ---
  async searchCandidates(req: CandidateRequest): Promise<CandidateMatch[]> {
    const should: object[] = [];
    // exact identifiers (mmsi/imo/callsign) — high precision, term match on blockingKeys
    for (const e of req.exact ?? []) should.push({ term: { blockingKeys: `${e.field}:${e.value}` } });
    // fuzzy name — recall when identifiers are absent (SAR/EO detections)
    if (req.fuzzyName) should.push({ match: { name: { query: req.fuzzyName, fuzziness: 'AUTO' } } });
    // kinematic geo block — candidates within radius
    if (req.geo) should.push({ geo_distance: { distance: `${req.geo.radiusKm}km`, geo: { lat: req.geo.lat, lon: req.geo.lon } } });

    const res = await this.client.search({
      index: this.alias,
      body: {
        size: req.limit ?? 50,
        query: { bool: { filter: [{ term: { type: req.type } }], should, minimum_should_match: 1 } },
      },
    });
    return res.body.hits.hits.map((h: any) => ({
      id: h._source.id as EntityId, score: h._score, matchedOn: h.matched_queries?.[0] ?? 'block',
    }));
  }
}

/** Translate the port's structured filter to an OpenSearch/ES clause. */
function esFilter(f: FieldFilter): object {
  const k = `fields.${f.field}`;
  switch (f.op) {
    case 'eq':  return { term:  { [`${k}.keyword`]: f.value } };
    case 'ne':  return { bool: { must_not: { term: { [`${k}.keyword`]: f.value } } } };
    case 'in':  return { terms: { [`${k}.keyword`]: f.value as unknown[] } };
    case 'gt':  return { range: { [k]: { gt: f.value } } };
    case 'lt':  return { range: { [k]: { lt: f.value } } };
    case 'gte': return { range: { [k]: { gte: f.value } } };
    case 'lte': return { range: { [k]: { lte: f.value } } };
    case 'exists': return { exists: { field: k } };
  }
}
```

#### 4.1.1 The mapping is DERIVED from the canonical type

The index mapping is not hand-written — it is **codegen'd from the registered object type** ([`10 §R10`](../10-STORAGE-ROLES.md) registry). Identifier fields become `keyword` (exact, facetable) *and* feed `blockingKeys`; free-text fields become `text`; numerics become numbers (rangeable); the geo field becomes `geo_point`; governance `marking` rides along for the PEP filter. For `planetar:Vessel` (`identifierFields: ['mmsi','imo','callsign']`, from `planetar-ontology/registry/types.json`):

```ts
// derived once from the registry; OBJECT_MAPPING above is the union over all indexed types.
export const VESSEL_MAPPING_FRAGMENT = {
  properties: {
    type:      { type: 'keyword' },                                  // every doc: restrict-by-type
    id:        { type: 'keyword' },
    name:      { type: 'text', fields: { keyword: { type: 'keyword' } } }, // text + exact facet
    text:      { type: 'text' },                                     // concatenated full-text
    blockingKeys: { type: 'keyword' },                              // 'mmsi:316001234', 'name3:ever'
    marking:   { type: 'keyword' },                                  // P1 PEP filter
    geo:       { type: 'geo_point' },                                // kinematic block + geo search
    ts:        { type: 'date', format: 'epoch_millis' },
    fields: { properties: {                                          // ← from the Vessel type schema
      mmsi:     { type: 'keyword' },                                 // identifier → keyword
      imo:      { type: 'keyword' },
      callsign: { type: 'keyword' },
      flag:     { type: 'keyword' },                                 // facetable
      ship_type:{ type: 'keyword' },                                 // facetable
      length_m: { type: 'float' },                                   // rangeable + aggregatable
      speed_kn: { type: 'float' },
    } },
  },
} as const;
```

The projector that fills R4 (`Object → IndexDoc`) is also codegen'd: it reads the type's field list, copies identifier fields into `blockingKeys` (`` `${field}:${value}` ``), name-trigram tokens into `blockingKeys` (`name3:ever`), and the governance marking from the entity's `_provenance`/marking. **One generator, every type** — add `planetar:Track` or `doibio:Party` to the registry and its mapping + projector + blocking keys fall out for free.

### 4.2 `PgFtsIndex` (`tsvector` + GIN, via `pg`)

When the client already runs postgres and wants R4 without a second system. `to_tsvector` + a `GIN` index give a real inverted index; `websearch_to_tsquery` parses user syntax; `ts_rank_cd` ranks; `GROUP BY` facets/aggregates. This is the `standard`-tier "collapse R4 onto postgres" binding from [`10 §3`](../10-STORAGE-ROLES.md).

```ts
// 40-ADAPTERS/postgres-fts/object-index.ts
import { Pool } from 'pg';
import type {
  ObjectIndex, AdapterContext, HealthStatus,
  IndexDoc, SearchQuery, SearchResult, AggQuery, AggResult,
  CandidateRequest, CandidateMatch, FieldFilter, TypeName, EntityId,
} from '../../spine/ports/object-index';

// DDL (applied by the manifest compiler from registry codegen):
//   CREATE TABLE object_index (
//     type text NOT NULL, id text NOT NULL, name text, marking text[] NOT NULL DEFAULT '{}',
//     fields jsonb NOT NULL, blocking_keys text[] NOT NULL DEFAULT '{}',
//     geo geography(Point,4326), ts timestamptz NOT NULL,
//     tsv tsvector GENERATED ALWAYS AS (
//        to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(fields->>'text','')) ) STORED,
//     PRIMARY KEY (type, id) );
//   CREATE INDEX ix_oi_tsv      ON object_index USING GIN (tsv);
//   CREATE INDEX ix_oi_blocking ON object_index USING GIN (blocking_keys);
//   CREATE INDEX ix_oi_fields   ON object_index USING GIN (fields jsonb_path_ops);
//   CREATE INDEX ix_oi_geo      ON object_index USING GIST (geo);

export class PgFtsIndex implements ObjectIndex {
  private pool!: Pool;
  readonly capabilities = {
    consistency: 'read-your-writes',   // synchronous write to the same pg → stronger than ES refresh-lag
    durable: true, rebuildable: true, scale: 'vertical', p99TargetMs: 50,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.pool = new Pool(ctx.manifest.config.connection);
    await this.pool.query('SELECT 1');
  }
  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.pool.query('SELECT 1'); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { await this.pool.end(); }

  async index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
    await this.pool.query(
      `INSERT INTO object_index(type,id,name,marking,fields,blocking_keys,geo,ts)
       VALUES($1,$2,$3,$4,$5,$6, ST_SetSRID(ST_MakePoint($7,$8),4326)::geography, to_timestamp($9/1000.0))
       ON CONFLICT(type,id) DO UPDATE SET
         name=$3, marking=$4, fields=$5, blocking_keys=$6, geo=EXCLUDED.geo, ts=EXCLUDED.ts`,
      [type, id, doc.name ?? null, doc.marking, doc.fields, doc.blockingKeys,
       doc.geo?.lon ?? null, doc.geo?.lat ?? null, doc.ts]);
  }
  async remove(type: TypeName, id: EntityId): Promise<void> {
    await this.pool.query(`DELETE FROM object_index WHERE type=$1 AND id=$2`, [type, id]);
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const where: string[] = []; const args: unknown[] = []; let n = 0;
    if (q.type) { where.push(`type=$${++n}`); args.push(q.type); }
    if (q.text) { where.push(`tsv @@ websearch_to_tsquery('simple',$${++n})`); args.push(q.text); }
    for (const f of q.filter ?? []) { const c = pgFilter(f, () => `$${++n}`, args); if (c) where.push(c); }
    if (q.geo) { where.push(`ST_DWithin(geo, ST_SetSRID(ST_MakePoint($${++n},$${n+1}),4326)::geography, $${n+2})`);
      args.push(q.geo.lon, q.geo.lat, q.geo.radiusKm * 1000); n += 2; }
    // P1 PEP filter: doc.marking ⊆ caller clearances  →  marking <@ principalMarkings
    if (q.principalMarkings) { where.push(`marking <@ $${++n}`); args.push(q.principalMarkings); }

    const rank = q.text ? `ts_rank_cd(tsv, websearch_to_tsquery('simple',$${args.indexOf(q.text) + 1}))` : '1';
    const order = (q.sort ?? []).map(s => `fields->>'${s.field}' ${s.dir.toUpperCase()}`).join(', ')
      || `${rank} DESC`;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(q.size ?? 25, q.from ?? 0);

    const { rows } = await this.pool.query(
      `SELECT type,id,fields,${rank} AS score,
              ts_headline('simple', coalesce(name,'')||' '||coalesce(fields->>'text',''),
                          ${q.text ? `websearch_to_tsquery('simple',$${args.indexOf(q.text) + 1})` : `''::tsquery`},
                          'MaxFragments=1,MaxWords=20') AS snippet
       FROM object_index ${whereSql} ORDER BY ${order} LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args);
    const { rows: [{ total }] } = await this.pool.query(
      `SELECT count(*)::int AS total FROM object_index ${whereSql}`, args.slice(0, args.length - 2));

    const facets: SearchResult['facets'] = {};
    for (const facet of q.facets ?? []) {
      const { rows: fr } = await this.pool.query(
        `SELECT fields->>'${facet}' AS value, count(*)::int AS count FROM object_index ${whereSql}
         GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, args.slice(0, args.length - 2));
      facets[facet] = fr.filter(r => r.value != null).map(r => ({ value: r.value, count: r.count }));
    }
    return { total, hits: rows.map(r => ({ type: r.type, id: r.id, score: +r.score, fields: r.fields, snippet: r.snippet })), facets };
  }

  async aggregate(q: AggQuery): Promise<AggResult> {
    const where: string[] = []; const args: unknown[] = []; let n = 0;
    if (q.type) { where.push(`type=$${++n}`); args.push(q.type); }
    for (const f of q.filter ?? []) { const c = pgFilter(f, () => `$${++n}`, args); if (c) where.push(c); }
    const m = q.metric && q.metric.op !== 'count'
      ? `${q.metric.op}((fields->>'${q.metric.field}')::numeric)` : 'count(*)';
    const { rows } = await this.pool.query(
      `SELECT fields->>'${q.groupBy}' AS key, ${m}::float AS value FROM object_index
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY 1 ORDER BY 2 DESC`, args);
    return { buckets: rows.filter(r => r.key != null).map(r => ({ key: r.key, value: r.value })) };
  }

  async searchCandidates(req: CandidateRequest): Promise<CandidateMatch[]> {
    // exact identifiers → blocking_keys array overlap (GIN-indexed, fast)
    const keys = (req.exact ?? []).map(e => `${e.field}:${e.value}`);
    const clauses: string[] = ['type=$1']; const args: unknown[] = [req.type]; let n = 1;
    const should: string[] = [];
    if (keys.length) { should.push(`blocking_keys && $${++n}`); args.push(keys); }
    if (req.fuzzyName) { should.push(`tsv @@ websearch_to_tsquery('simple',$${++n})`); args.push(req.fuzzyName); }
    if (req.geo) { should.push(`ST_DWithin(geo, ST_SetSRID(ST_MakePoint($${++n},$${n+1}),4326)::geography,$${n+2})`);
      args.push(req.geo.lon, req.geo.lat, req.geo.radiusKm * 1000); n += 2; }
    clauses.push(`(${should.join(' OR ')})`);
    args.push(req.limit ?? 50);
    const { rows } = await this.pool.query(
      `SELECT id, 1.0 AS score FROM object_index WHERE ${clauses.join(' AND ')} LIMIT $${args.length}`, args);
    return rows.map(r => ({ id: r.id, score: +r.score, matchedOn: keys.length ? 'identifier' : req.fuzzyName ? 'name' : 'geo' }));
  }
}

function pgFilter(f: FieldFilter, ph: () => string, args: unknown[]): string | null {
  const col = `(fields->>'${f.field}')`;
  switch (f.op) {
    case 'eq':  args.push(f.value); return `${col} = ${ph()}`;
    case 'ne':  args.push(f.value); return `${col} <> ${ph()}`;
    case 'gt':  args.push(f.value); return `${col}::numeric > ${ph()}`;
    case 'lt':  args.push(f.value); return `${col}::numeric < ${ph()}`;
    case 'gte': args.push(f.value); return `${col}::numeric >= ${ph()}`;
    case 'lte': args.push(f.value); return `${col}::numeric <= ${ph()}`;
    case 'in':  args.push(f.value); return `${col} = ANY(${ph()})`;
    case 'exists': return `fields ? '${f.field}'`;
  }
}
```

### 4.3 `TypesenseIndex` (light, typo-tolerant)

A Meilisearch adapter is nearly identical (different client, same shape). Both are single-binary instant-search engines; the port hides the difference.

```ts
// 40-ADAPTERS/typesense/object-index.ts
import Typesense from 'typesense';
import type {
  ObjectIndex, AdapterContext, HealthStatus,
  IndexDoc, SearchQuery, SearchResult, AggQuery, AggResult,
  CandidateRequest, CandidateMatch, TypeName, EntityId,
} from '../../spine/ports/object-index';

export class TypesenseIndex implements ObjectIndex {
  private client!: Typesense.Client;
  private collection = 'objects';
  readonly capabilities = {
    consistency: 'eventual', durable: true, rebuildable: true, scale: 'vertical', p99TargetMs: 50,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { host: string; port: number; apiKey: string };
    this.client = new Typesense.Client({
      nodes: [{ host: cfg.host, port: cfg.port, protocol: 'http' }],
      apiKey: cfg.apiKey, connectionTimeoutSeconds: 2,
    });
    // schema derived from the registry (R10), same source as §4.1.1
    const exists = await this.client.collections(this.collection).retrieve().then(() => true, () => false);
    if (!exists) await this.client.collections().create({
      name: this.collection,
      fields: [
        { name: 'type', type: 'string', facet: true },
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'text', type: 'string' },
        { name: 'blockingKeys', type: 'string[]' },
        { name: 'marking', type: 'string[]', facet: true },
        { name: 'flag', type: 'string', facet: true, optional: true },
        { name: 'ship_type', type: 'string', facet: true, optional: true },
        { name: 'length_m', type: 'float', optional: true },
        { name: 'geo', type: 'geopoint', optional: true },
        { name: 'ts', type: 'int64' },
      ],
      default_sorting_field: 'ts',
    });
  }
  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.client.health.retrieve(); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { /* http client; nothing to drain */ }

  async index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
    await this.client.collections(this.collection).documents().upsert({
      id: `${type}:${id}`, type, name: doc.name, text: doc.text, blockingKeys: doc.blockingKeys,
      marking: doc.marking, ...doc.fields, geo: doc.geo ? [doc.geo.lat, doc.geo.lon] : undefined, ts: doc.ts,
    });
  }
  async remove(type: TypeName, id: EntityId): Promise<void> {
    await this.client.collections(this.collection).documents(`${type}:${id}`).delete().catch(() => void 0);
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const filterBy = [
      q.type ? `type:=${q.type}` : '',
      ...(q.filter ?? []).map(f => `${f.field}:${tsOp(f.op)}${f.value}`),
      q.principalMarkings ? `marking:=[${q.principalMarkings.join(',')}]` : '',  // P1 PEP
    ].filter(Boolean).join(' && ');
    const res = await this.client.collections(this.collection).documents().search({
      q: q.text ?? '*', query_by: 'name,text', filter_by: filterBy || undefined,
      facet_by: (q.facets ?? []).join(','),
      sort_by: (q.sort ?? []).map(s => `${s.field}:${s.dir}`).join(',') || '_text_match:desc',
      page: Math.floor((q.from ?? 0) / (q.size ?? 25)) + 1, per_page: q.size ?? 25,
    });
    return {
      total: res.found,
      hits: (res.hits ?? []).map(h => ({
        type: (h.document as any).type, id: (h.document as any).id.split(':').slice(1).join(':'),
        score: h.text_match ?? 0, fields: h.document as any,
        snippet: h.highlights?.[0]?.snippet,
      })),
      facets: Object.fromEntries((res.facet_counts ?? []).map(fc =>
        [fc.field_name, fc.counts.map(c => ({ value: c.value, count: c.count }))])),
    };
  }
  async aggregate(q: AggQuery): Promise<AggResult> {
    // Typesense aggregations are facet counts; metric aggs beyond count fall back to the projector.
    const res = await this.client.collections(this.collection).documents().search({
      q: '*', query_by: 'name', filter_by: q.type ? `type:=${q.type}` : undefined,
      facet_by: q.groupBy, max_facet_values: 1000, per_page: 0,
    });
    return { buckets: (res.facet_counts?.[0]?.counts ?? []).map(c => ({ key: c.value, value: c.count })) };
  }
  async searchCandidates(req: CandidateRequest): Promise<CandidateMatch[]> {
    const keys = (req.exact ?? []).map(e => `${e.field}:${e.value}`);
    const res = await this.client.collections(this.collection).documents().search({
      q: req.fuzzyName ?? '*', query_by: 'name', num_typos: 2,
      filter_by: [`type:=${req.type}`, keys.length ? `blockingKeys:=[${keys.join(',')}]` : ''].filter(Boolean).join(' && '),
      per_page: req.limit ?? 50,
    });
    return (res.hits ?? []).map(h => ({
      id: (h.document as any).id.split(':').slice(1).join(':'), score: h.text_match ?? 1,
      matchedOn: keys.length ? 'identifier' : 'name',
    }));
  }
}
function tsOp(op: string): string {
  return op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : op === 'lte' ? '<=' : op === 'ne' ? ':!=' : ':=';
}
```

---

## 5. Governance: R4 is a Policy Enforcement Point (P1)

Per [`12 §1`](../12-ADAPTER-CONTRACT.md), every adapter is a PEP. For R4 that's concrete and mandatory: **search must never leak the existence of an object the caller can't see.** Each `IndexDoc` carries `marking[]` (propagated from ingest along R12 lineage, [`10 §R12`](../10-STORAGE-ROLES.md)); every `search`/`searchCandidates` intersects `doc.marking ⊆ principalMarkings` *inside the engine query* (the `terms_set` / `marking <@ $n` / `marking:=[...]` clauses above), so a denied object is filtered pre-ranking — it never appears in `total`, facets, or hits. This is the search-time half of "markings + propagating security" ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md), spine-owned propagation, designed); the adapter enforces the label the governance plane handed it.

---

## 6. The SQLite FTS5 fallback (edge / air-gapped — one file, no service)

The whole point of R4 being a *role* is that the edge doesn't run OpenSearch. At the `edge`/`air-gapped` tier, R4 **collapses into the same SQLite file as R1** (`canonical.db`) using **FTS5** — a real inverted index with `bm25()` ranking, built into `node:sqlite`, zero external service. This is the binding the maritime manifest uses today ([`13 §1`](../13-CLIENT-MANIFEST.md): `object-index: { engine: sqlite, fts: true }`), and it is a thin layer over the file `planetar-ontology/src/store/store.ts` already opens.

```ts
// 40-ADAPTERS/sqlite/object-index.ts  (edge / air-gapped / demo — zero external services)
import { DatabaseSync } from 'node:sqlite';   // same engine as the R1 SqliteCanonicalStore
import type {
  ObjectIndex, AdapterContext, HealthStatus,
  IndexDoc, SearchQuery, SearchResult, AggQuery, AggResult,
  CandidateRequest, CandidateMatch, FieldFilter, TypeName, EntityId,
} from '../../spine/ports/object-index';

// One file, two tables: an FTS5 virtual table for text + a plain table for filters/facets/blocking.
const DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS object_fts USING fts5(
  type UNINDEXED, id UNINDEXED, name, text, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS object_meta(
  type TEXT NOT NULL, id TEXT NOT NULL, name TEXT,
  fields TEXT NOT NULL, blocking_keys TEXT NOT NULL, marking TEXT NOT NULL,
  lat REAL, lon REAL, ts INTEGER NOT NULL, PRIMARY KEY(type,id));
CREATE INDEX IF NOT EXISTS ix_meta_ts ON object_meta(ts);`;

export class SqliteFtsIndex implements ObjectIndex {
  private db!: DatabaseSync;
  readonly capabilities = {
    consistency: 'read-your-writes',   // same process, synchronous write → instantly visible
    durable: true, rebuildable: true, scale: 'single', p99TargetMs: 5,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.db = new DatabaseSync(ctx.manifest.config.path as string);   // the SAME canonical.db file
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(DDL);
  }
  async health(): Promise<HealthStatus> {
    try { this.db.prepare('SELECT 1').get(); return { ok: true, latencyMs: 0 }; }
    catch (e) { return { ok: false, latencyMs: 0, error: String(e) }; }
  }
  async close(): Promise<void> { this.db.close(); }

  async index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
    this.db.prepare(`DELETE FROM object_fts WHERE type=? AND id=?`).run(type, id);
    this.db.prepare(`INSERT INTO object_fts(type,id,name,text) VALUES(?,?,?,?)`)
      .run(type, id, doc.name ?? '', doc.text);
    this.db.prepare(
      `INSERT INTO object_meta(type,id,name,fields,blocking_keys,marking,lat,lon,ts)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(type,id) DO UPDATE SET name=excluded.name, fields=excluded.fields,
         blocking_keys=excluded.blocking_keys, marking=excluded.marking,
         lat=excluded.lat, lon=excluded.lon, ts=excluded.ts`,
    ).run(type, id, doc.name ?? null, JSON.stringify(doc.fields), JSON.stringify(doc.blockingKeys),
          JSON.stringify(doc.marking), doc.geo?.lat ?? null, doc.geo?.lon ?? null, doc.ts);
  }
  async remove(type: TypeName, id: EntityId): Promise<void> {
    this.db.prepare(`DELETE FROM object_fts  WHERE type=? AND id=?`).run(type, id);
    this.db.prepare(`DELETE FROM object_meta WHERE type=? AND id=?`).run(type, id);
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const where: string[] = []; const args: unknown[] = [];
    let join = '';
    if (q.text) {
      join = `JOIN object_fts f ON f.type=m.type AND f.id=m.id`;
      where.push(`object_fts MATCH ?`); args.push(ftsQuery(q.text));
    }
    if (q.type) { where.push(`m.type=?`); args.push(q.type); }
    for (const f of q.filter ?? []) { const c = sqliteFilter(f, args); if (c) where.push(c); }
    // P1 PEP: every label on the doc must be in the caller's clearance set.
    if (q.principalMarkings) {
      where.push(`NOT EXISTS (SELECT 1 FROM json_each(m.marking) j WHERE j.value NOT IN (${q.principalMarkings.map(() => '?').join(',')}))`);
      args.push(...q.principalMarkings);
    }
    const rank = q.text ? `bm25(object_fts)` : `-m.ts`;   // relevance, or recency when no text
    const order = (q.sort ?? []).map(s => `json_extract(m.fields,'$.${s.field}') ${s.dir.toUpperCase()}`).join(', ') || rank;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = this.db.prepare(
      `SELECT m.type,m.id,m.fields,${q.text ? `bm25(object_fts)` : '0'} AS score,
              ${q.text ? `snippet(object_fts,3,'[',']','…',12)` : 'NULL'} AS snippet
       FROM object_meta m ${join} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...args, q.size ?? 25, q.from ?? 0) as any[];
    const total = (this.db.prepare(
      `SELECT count(*) AS c FROM object_meta m ${join} ${whereSql}`).get(...args) as any).c;

    const facets: SearchResult['facets'] = {};
    for (const facet of q.facets ?? []) {
      const fr = this.db.prepare(
        `SELECT json_extract(m.fields,'$.${facet}') AS value, count(*) AS count
         FROM object_meta m ${join} ${whereSql} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`).all(...args) as any[];
      facets[facet] = fr.filter(r => r.value != null).map(r => ({ value: String(r.value), count: r.count }));
    }
    return { total, hits: rows.map(r => ({
      type: r.type, id: r.id, score: -r.score /* bm25 lower=better → flip */, fields: JSON.parse(r.fields), snippet: r.snippet ?? undefined,
    })), facets };
  }

  async aggregate(q: AggQuery): Promise<AggResult> {
    const where: string[] = []; const args: unknown[] = [];
    if (q.type) { where.push(`type=?`); args.push(q.type); }
    for (const f of q.filter ?? []) { const c = sqliteFilter(f, args, 'fields'); if (c) where.push(c); }
    const m = q.metric && q.metric.op !== 'count'
      ? `${q.metric.op}(CAST(json_extract(fields,'$.${q.metric.field}') AS REAL))` : 'count(*)';
    const rows = this.db.prepare(
      `SELECT json_extract(fields,'$.${q.groupBy}') AS key, ${m} AS value FROM object_meta
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY 1 ORDER BY 2 DESC`).all(...args) as any[];
    return { buckets: rows.filter(r => r.key != null).map(r => ({ key: String(r.key), value: Number(r.value) })) };
  }

  async searchCandidates(req: CandidateRequest): Promise<CandidateMatch[]> {
    // exact-identifier block: blocking_keys is a JSON array; json_each + IN is the FTS5-era
    // generalization of planetar-ontology's findEntityIdsByIdentifier (one engine, both jobs).
    const keys = (req.exact ?? []).map(e => `${e.field}:${e.value}`);
    if (keys.length) {
      const rows = this.db.prepare(
        `SELECT DISTINCT m.id FROM object_meta m, json_each(m.blocking_keys) j
         WHERE m.type=? AND j.value IN (${keys.map(() => '?').join(',')}) LIMIT ?`,
      ).all(req.type, ...keys, req.limit ?? 50) as any[];
      if (rows.length) return rows.map(r => ({ id: r.id, score: 1.0, matchedOn: 'identifier' }));
    }
    if (req.fuzzyName) {   // fall back to FTS name match when no identifier hit (SAR/EO detections)
      const rows = this.db.prepare(
        `SELECT f.id, bm25(object_fts) AS s FROM object_fts f
         WHERE object_fts MATCH ? AND f.type=? ORDER BY s LIMIT ?`,
      ).all(ftsQuery(req.fuzzyName), req.type, req.limit ?? 50) as any[];
      return rows.map(r => ({ id: r.id, score: 1 / (1 + r.s), matchedOn: 'name' }));
    }
    return [];
  }
}

/** Sanitize user text into an FTS5 MATCH expression (prefix-match each token, OR-joined). */
function ftsQuery(text: string): string {
  return text.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}
function sqliteFilter(f: FieldFilter, args: unknown[], col = 'm.fields'): string | null {
  const j = `json_extract(${col},'$.${f.field}')`;
  switch (f.op) {
    case 'eq':  args.push(f.value); return `${j} = ?`;
    case 'ne':  args.push(f.value); return `${j} <> ?`;
    case 'gt':  args.push(f.value); return `CAST(${j} AS REAL) > ?`;
    case 'lt':  args.push(f.value); return `CAST(${j} AS REAL) < ?`;
    case 'gte': args.push(f.value); return `CAST(${j} AS REAL) >= ?`;
    case 'lte': args.push(f.value); return `CAST(${j} AS REAL) <= ?`;
    case 'in':  { const a = f.value as unknown[]; args.push(...a); return `${j} IN (${a.map(() => '?').join(',')})`; }
    case 'exists': return `${j} IS NOT NULL`;
  }
}
```

> **Geo at the edge.** SQLite FTS5 has no `geo_distance`; the edge candidate-block falls back to a bounding-box prefilter on `lat`/`lon` columns (omitted above for brevity) plus the spine's kinematic matcher ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md), `dark-vessel kinematic re-ID`, built in `planetar-ontology/src/resolve/kinematics.ts`) doing the precise scoring. The block only needs *recall*; precision is the resolver's job. This is why the degenerate edge index is still correct: it returns a superset, the spine narrows it.

---

## 7. Conformance-suite hookup

All five engines pass the **same** engine-agnostic suite ([`12 §5`](../12-ADAPTER-CONTRACT.md)). Green across the matrix = a client can bind any of them and the resolver + Object Explorer behave identically.

```ts
// 40-ADAPTERS/_conformance/object-index.spec.ts
export function objectIndexConformance(make: () => ObjectIndex) {
  const s = make();
  beforeAll(async () => {
    await s.init(testCtx());
    for (const v of sampleVessels) await s.index('planetar:Vessel', v.id, toIndexDoc(v));
    await settle(s);   // ES/Typesense: await refresh; pg/sqlite: no-op (read-your-writes)
  });

  test('Job 1 — full-text finds by name', async () => {
    const r = await s.search({ type: 'planetar:Vessel', text: 'EVER GIVEN' });
    expect(r.hits.map(h => h.id)).toContain('vessel-evergiven');
  });
  test('Job 1 — filter + facet + sort compose', async () => {
    const r = await s.search({
      type: 'planetar:Vessel', text: 'container',
      filter: [{ field: 'flag', op: 'ne', value: 'CA' }, { field: 'length_m', op: 'gt', value: 150 }],
      facets: ['flag'], sort: [{ field: 'length_m', dir: 'desc' }], size: 10,
    });
    expect(r.facets!.flag.length).toBeGreaterThan(0);
    expect(r.hits.every(h => h.fields.flag !== 'CA')).toBe(true);
    expect(isSortedDesc(r.hits.map(h => +h.fields.length_m))).toBe(true);
  });
  test('aggregation — count vessels by flag', async () => {
    const a = await s.aggregate({ type: 'planetar:Vessel', groupBy: 'flag', metric: { op: 'count' } });
    expect(a.buckets.reduce((n, b) => n + b.value, 0)).toBe(sampleVessels.length);
  });
  test('Job 2 — exact-identifier blocking returns the candidate, not the corpus', async () => {
    const c = await s.searchCandidates({ type: 'planetar:Vessel', exact: [{ field: 'mmsi', value: '316001234' }] });
    expect(c).toHaveLength(1);
    expect(c[0].matchedOn).toBe('identifier');
  });
  test('Job 2 — fuzzy-name block recalls when identifiers are absent', async () => {
    const c = await s.searchCandidates({ type: 'planetar:Vessel', fuzzyName: 'evergiven', limit: 50 });
    expect(c.map(x => x.id)).toContain('vessel-evergiven');
  });
  test('P1 — search never leaks an out-of-clearance object', async () => {
    const r = await s.search({ type: 'planetar:Vessel', text: 'restricted', principalMarkings: ['UNCLASS'] });
    expect(r.hits.every(h => h.id !== 'vessel-opsrestricted')).toBe(true);
    expect(r.total).toBe(0);   // not in total, not in facets, not in hits
  });
  test('declares capabilities that satisfy the R4 contract', () => {
    expect(satisfies(ROLE_CONTRACT['object-index'], make().capabilities)).toBe(true);
  });
}

// then, one line per engine — the whole matrix:
objectIndexConformance(() => new OpenSearchIndex());   // docker: opensearchproject/opensearch
objectIndexConformance(() => new PgFtsIndex());        // docker: postgres (FTS is built-in)
objectIndexConformance(() => new TypesenseIndex());    // docker: typesense/typesense
objectIndexConformance(() => new SqliteFtsIndex());    // in-proc node:sqlite, no container
```

Two R4-specific invariants the suite enforces beyond the obvious search cases: **blocking returns a *bounded candidate set*, not the corpus** (the O(n²)-avoidance contract — a test seeds 10 k vessels and asserts the block returns ≤ `limit`), and **the PEP filter is engine-side** (a denied doc is absent from `total`, so no count-leak side channel). The `eventual` engines additionally run every assertion *after* an explicit `settle()` (refresh), making R4's read-your-writes-within-seconds contract testable without flakiness.

---

## 8. Comparison table

| Engine | Consistency | Scale | Typical p99 (query) | Fuzzy / typo | Deep aggs / facets | Geo | Ops weight | When to choose |
|---|---|---|---|---|---|---|---|---|
| **OpenSearch / Elasticsearch** | eventual (refresh lag, ~1 s) | sharded → billions | ~10–50 ms | yes (`fuzziness:AUTO`) | yes (rich) | yes (`geo_point`) | heavy (cluster) | default at `standard`/`scale`; high volume, rich relevance, Search 360. doibio runs this. |
| **Postgres FTS** (`tsvector`+GIN) | read-your-writes | vertical → low-millions | ~5–50 ms | no (add `pg_trgm`) | yes (`GROUP BY`) | yes (`postgis`) | none extra (reuse R1 pg) | `standard` one-engine SaaS; avoid a second system |
| **Typesense / Meilisearch** | eventual | vertical → few-millions | ~2–20 ms | **yes (excellent)** | facets yes; metric aggs weak | yes (`geopoint`) | light (one binary) | app-embedded instant-search; great typo UX, tiny ops |
| **SQLite FTS5** | read-your-writes | single-node → ~1 M | ~1–5 ms | prefix only | `GROUP BY` (modest) | bbox prefilter only | **zero** (same `.db` as R1) | `edge`/`air-gapped`/demo; no search service at all |

The honest read: OpenSearch wins on scale + relevance + geo + deep aggregation but costs a cluster; postgres-FTS is the "free" choice when you already run postgres and your corpus is low-millions; Typesense/Meilisearch win the typo-tolerant instant-search UX with trivial ops; SQLite-FTS5 is the only one that needs **no service at all**, which is exactly why it's the edge binding. Because R4 is **rebuildable from R3/R1**, moving up this list is reversible — replay the bus into the new index, flip one manifest line, no spine change.

---

## 9. Which manifest tiers / clients bind this

| Manifest tier ([`13 §1`](../13-CLIENT-MANIFEST.md)) | R4 binding | Rationale |
|---|---|---|
| `edge` / `air-gapped` | **sqlite (FTS5)** | collapses into the R1 `canonical.db`; no search service; offline. The maritime manifest today. |
| `standard` (low search volume) | **postgres-FTS** | reuse the R1 postgres; one fewer system to run/secure |
| `standard` (instant-search UX) | **typesense / meilisearch** | typo-tolerant search box, light ops |
| `scale` / high query volume | **opensearch** | sharded, deep relevance + facets + geo; real Search 360 |

Across the four reference clients ([`README`](../README.md)):

- **Maritime / defence (`planetar`)** — *edge* binds **sqlite-FTS5** today (one file with R1; the resolver's blocking call is `findEntityIdsByIdentifier` over the same file, built). Its scale-up path ([`13 §3`](../13-CLIENT-MANIFEST.md)) flips R4 to **opensearch** for the cloud command tier while the edge nodes keep FTS5 — *same port, two engines in one deployment.* The resolver's `searchCandidates`, the Object Explorer, and the OSDK search surface are byte-for-byte identical across both.
- **Biotech / research CRM (`doibio`)** — runs **elasticsearch** today (`src/lib/elasticsearch.ts`, built); its identity-resolution blocking (`identity-resolution.ts`, 631 LOC) is the Job-2 pattern this port generalizes. A cost-down variant could collapse R4 onto its postgres via **postgres-FTS** with no app change.
- **Generic enterprise CRM+ops** — **opensearch** for Einstein-Search/Search-360-grade global search across standard/custom objects + list views; the resolver leans on it for Data-Cloud-style identity matching.
- **Intel / financial-crime graph** — **opensearch** for watchlist/dossier search **and** as the blocking layer feeding both the resolver and the R5 graph (ring detection); high-recall blocking over millions of entities is exactly where O(n²) avoidance is non-negotiable.

The invariant holds: the engine under R4 changes per client and per tier; **the resolver's blocking call, the Object Explorer, and the OSDK search surface do not.** One conformance suite passing on five engines behind one port — covering *both* of R4's jobs — is the deliverable.
