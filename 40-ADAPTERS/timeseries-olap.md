# 40-ADAPTERS · Timeseries-geo (R8) + Analytics-OLAP (R9)

**Roles:** R8 · timeseries-geo and R9 · analytics-olap — the two scan-heavy roles, paired here because the same engines (`clickhouse`, `duckdb`, `postgres`) routinely fill both, and the headline engine for R8 (`timescaledb` + `postgis`) lets **one postgres serve R1 + R8 at once**.
**R8 engines:** TimescaleDB + PostGIS (`pg`), ClickHouse (`@clickhouse/client`), DuckDB (`duckdb`/`@duckdb/node-api`), plain PostGIS (`pg`).
**R9 engines:** ClickHouse (`@clickhouse/client`), DuckDB (`duckdb`), BigQuery / Snowflake / Databricks (federated — *query-in-place*, the zero-copy pattern), postgres (`pg`).
**Status:** **partial → designed.** The data that R8 holds is **built today** — `planetar-ontology/src/store/schema.sql` stores `observation(ts_ns, topic, source, body)` (the de-facto time series), `planetar-ais` emits per-vessel geo envelopes (`src/victoria.mjs`: BBox + `insideBBox` + `nmBetween`), and `planetar-ontology/src/resolve/kinematics.ts` does dead-reckon **track playback** (`projectPosition`, `distanceNm`, `DarkVesselMatcher`). What is **designed** here is lifting those queries out of ad-hoc SQLite scans onto purpose-built R8/R9 engines behind the two ports below, so the spine asks for "tracks in this box over this window" and "roll this fact table up by hour" without knowing whether timescale, clickhouse, duckdb, or a federated warehouse answers. doibio's analytics are **canned SQL + a Redis-sorted-set rollup** (`src/lib/metrics.ts`) — *not* a report builder; R9 is what closes that gap to Contour/CRM-Analytics parity.

R8 powers **Gotham Geotime/Gaia + Salesforce Maps**; R9 powers **Foundry Contour/Quiver + Salesforce Reports & Dashboards / CRM Analytics + Data Cloud Calculated Insights** ([`10 §R8/§R9`](../10-STORAGE-ROLES.md)). The federated R9 binding (`bigquery`/`snowflake`/`databricks`) is the **zero-copy federation** capability ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md)) — *Foundry virtual tables* / *Data Cloud zero-copy* — where the platform reports over a warehouse it never ingests.

---

## 1. Intro — which role, which engines, when to pick each

### R8 · timeseries-geo

R8 holds high-frequency, time-stamped, usually geospatial observations: AIS tracks, telemetry, PSD waterfalls, SAR/EO detection histories. Its contract ([`10 §R8`](../10-STORAGE-ROLES.md)): **read-recent-fast**, p99 ≤ 50 ms on a recent window, durable, high write throughput, **rebuildable from R3**. Its access patterns are specific: *time-range scan*, *downsample / continuous-aggregate*, *geo-within / geo-near*, *track playback* (ordered positions per entity over a window).

| Pick… | …when |
|---|---|
| **TimescaleDB + PostGIS** | You already run postgres for R1. Timescale (hypertables + continuous aggregates) and PostGIS (geometry/geography + GiST) are **extensions on the same engine** — so **one postgres serves R1 *and* R8** (and R4-FTS, R7-pgvector, R12, R14). The standard-tier default: zero new services, real geospatial, real continuous aggregates. The "don't add a system" choice. |
| **ClickHouse** | Track/telemetry volume is huge (10⁸–10¹⁰ rows), writes are append-heavy, and you want sub-second scans over months of history. ClickHouse's columnar + `AggregatingMergeTree` materialized views give continuous-aggregate-equivalent rollups at far higher ingest. Geo is via `pointInPolygon` / `geoDistance` / H3 functions (less rich than PostGIS, enough for box/radius). The "fire-hose telemetry" choice. |
| **DuckDB** | Embedded, single-process analytics — air-gapped boat, notebook, CI, a Foundry-Contour-style local exploration. Reads Parquet/Arrow zero-copy, has the `spatial` extension (GEOS/GDAL → PostGIS-class predicates) and `icu`/time functions. No server. The "analytics in-process" choice; also the natural R9 embedded engine, so one DuckDB file can cover R8 *and* R9 at the edge. |
| **plain PostGIS** | You want first-class geospatial but *not* Timescale's hypertable management (smaller volume, or Timescale licensing avoided). Same `pg` adapter, geo predicates intact, time handled with a plain BRIN-indexed timestamp column. The "geo without the hypertable" choice. |

### R9 · analytics-olap

R9 holds wide, columnar, append-mostly fact tables for scan-heavy analytics over millions–billions of rows. Contract ([`10 §R9`](../10-STORAGE-ROLES.md)): **eventual**, seconds-scale for big scans, durable, horizontally scalable, **rebuildable**. Access: columnar aggregate scan, group-by-rollup, window functions, materialized cubes.

| Pick… | …when |
|---|---|
| **ClickHouse** | Default. Billions of rows, dashboards that must stay sub-second, materialized-view cubes. The same cluster can serve R8 *and* R9 for a scale-tier client. |
| **DuckDB** | Embedded / single-node. A report or calculated-insight that runs in-process over Parquet exported from R1/R3. Foundry-Contour-locally. |
| **BigQuery / Snowflake / Databricks (federated)** | **The client's data already lives in a warehouse and they will not let us copy it.** Bind R9 to a *federated, query-in-place* engine: the platform issues columnar SQL against the warehouse and reads results, never landing the rows. This is the **zero-copy** binding — Foundry **virtual tables**, Salesforce Data Cloud **zero-copy**. The dashboard/Calculated-Insight is over data the platform does not own. |
| **postgres** | Small reporting (thousands–low-millions of rows), reuse the R1 workhorse, no new system. Below ClickHouse's cross-over point. |

**The collapse worth naming:** for a *standard* client, `postgres` + the **timescaledb** and **postgis** extensions covers **R1, R8, and small-R9 on one engine**. For a *scale* client, one **clickhouse** cluster covers **R8 and R9** together. The manifest never binds four databases when one extension-loaded postgres satisfies four role contracts — that collapse is exactly what [`11 §3`](../11-CAPABILITY-ROLE-MAP.md) computes.

Decision tie-back ([`README`](../README.md)): *custom spine + OSS breadth.* Every engine here is OSS or a managed warehouse; all four R8 engines and all five R9 engines sit behind the two ports below, and the spine — the track model, the report/insight definitions in the registry (R10), the kinematic matcher — imports neither a `pg`, `clickhouse`, `duckdb`, nor a `bigquery` driver.

---

## 2. The two ports (specified in `12`-style)

These extend [`12 §3`](../12-ADAPTER-CONTRACT.md)'s "specified the same way in `40-ADAPTERS/`" placeholder for R8/R9. They speak **canonical track / fact rows**, never engine rows, and carry the `Adapter` lifecycle (`init`/`health`/`close`/`capabilities`).

```ts
// spine/ports/timeseries-geo.ts  (R8)
import type { Adapter, AdapterContext, HealthStatus } from './adapter';
import type { EntityId, TypeName } from '../model';

/** A single time-stamped, optionally geospatial sample (one AIS fix, one detection). */
export interface TimePoint {
  series: string;            // logical stream, e.g. 'ais.position' | 'sar.detection'
  entityId?: EntityId;       // the canonical entity this sample belongs to (a vessel)
  tsNs: bigint;              // nanoseconds since epoch (zmesg envelope time)
  lat?: number; lon?: number;
  fields: Record<string, number | string | null>;  // sog, cog, heading, rcs, snr, …
}

/** Aggregation bucket spec for downsample / continuous aggregate. */
export interface BucketSpec {
  every: string;             // '1 minute' | '1 hour' | '1 day'
  aggregates: { field: string; fn: 'avg' | 'min' | 'max' | 'last' | 'count'; as: string }[];
}

export interface TimeWindow { fromNs: bigint; toNs: bigint; }

/** A geographic constraint: bounding box OR radius-around-a-point (nautical miles). */
export type GeoFilter =
  | { kind: 'bbox'; sw: [number, number]; ne: [number, number] }     // [lat,lon]
  | { kind: 'radius'; lat: number; lon: number; nm: number };

export interface TimeSeriesGeo extends Adapter {
  /** Append samples (called by the R3→R8 projector; never by surfaces). */
  ingest(points: TimePoint[]): Promise<void>;

  /** Time-range scan, optionally geo-filtered, optionally per-entity. */
  range(series: string, win: TimeWindow, geo?: GeoFilter, entityId?: EntityId): Promise<TimePoint[]>;

  /** Downsample / continuous-aggregate a window into buckets (Geotime histograms, dashboards). */
  downsample(series: string, win: TimeWindow, bucket: BucketSpec, geo?: GeoFilter): Promise<AggRow[]>;

  /** Ordered positions for one entity over a window — track playback (Geotime/Gaia/SF Maps). */
  track(entityId: EntityId, win: TimeWindow): Promise<TimePoint[]>;

  /** Declare/refresh a continuous aggregate so `downsample` is a cheap read, not a scan. */
  ensureContinuousAggregate(series: string, bucket: BucketSpec): Promise<void>;
}

export interface AggRow { bucketNs: bigint; lat?: number; lon?: number; values: Record<string, number>; }
```

```ts
// spine/ports/analytics-olap.ts  (R9)
import type { Adapter } from './adapter';

export interface OlapQuery {
  from: string;                       // logical fact table, e.g. 'fact_detection'
  select: { expr: string; as: string }[];   // 'count(*)', 'avg(rcs)', 'sum(amount)' …
  where?: OlapPredicate[];
  groupBy?: string[];                 // dimensions / rollup keys
  orderBy?: { col: string; dir: 'asc' | 'desc' }[];
  limit?: number;
}
export interface OlapPredicate { col: string; op: 'eq'|'ne'|'gt'|'lt'|'gte'|'lte'|'in'; value: unknown; }

export interface OlapResult { columns: string[]; rows: Record<string, unknown>[]; scannedRows?: number; engineMs?: number; }

export interface AnalyticsOlap extends Adapter {
  /** One columnar roll-up (powers a report / dashboard panel / Contour board / calculated insight). */
  query(q: OlapQuery): Promise<OlapResult>;

  /** Materialize a cube/rollup so a dashboard reads a small table instead of scanning the fact. */
  ensureRollup(name: string, q: OlapQuery): Promise<void>;

  /** Register an EXTERNAL warehouse table as a virtual fact — zero-copy, query-in-place.
   *  `query()` against this `from` is pushed down to the warehouse; rows are never ingested. */
  registerVirtualTable(name: string, source: VirtualSource): Promise<void>;
}

export interface VirtualSource {
  engine: 'bigquery' | 'snowflake' | 'databricks';
  ref: string;                        // 'project.dataset.table' | 'DB.SCHEMA.TABLE' | catalog.schema.table
  pushdown: boolean;                  // true → filters/aggregates execute in the warehouse
}
```

The compiler checks each adapter's `capabilities` against `ROLE_CONTRACT['timeseries-geo']` / `['analytics-olap']` exactly as it does for R1 ([`12 §1`](../12-ADAPTER-CONTRACT.md)): R8 wants `consistency: 'read-your-writes'`-or-stronger with `p99TargetMs ≤ 50`; R9 accepts `eventual` and a seconds-scale `p99TargetMs`. A federated warehouse declaring `rebuildable: false` (it's external, not a projection of our R3) is *allowed* for R9 — R9's contract says rebuildable, but a **virtual** table is explicitly the exception, flagged below.

---

## 3. R8 adapters

### 3.1 `TimescalePostgisTimeSeries` — **one postgres serves R1 + R8** (the collapse)

The default. Timescale hypertable for time partitioning + continuous aggregates; PostGIS `geography` column + GiST index for geo-within/near. Both are extensions on the **same** postgres instance that already runs `PostgresCanonicalStore` ([`12 §2.1`](../12-ADAPTER-CONTRACT.md)) — so the manifest binds R1 and R8 to the *same connection* and the client runs one database.

```ts
// 40-ADAPTERS/timescale/timeseries-geo.ts
import { Pool } from 'pg';
import type {
  TimeSeriesGeo, TimePoint, TimeWindow, BucketSpec, GeoFilter, AggRow,
} from '../../spine/ports/timeseries-geo';
import type { AdapterContext, HealthStatus } from '../../spine/ports/adapter';
import type { EntityId } from '../../spine/model';

// nanoseconds (zmesg) ↔ postgres timestamptz (microsecond resolution). We keep ns in a
// bigint column for exact replay and a generated timestamptz for Timescale partitioning.
const nsToIso = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toISOString();

export class TimescalePostgisTimeSeries implements TimeSeriesGeo {
  private pool!: Pool;

  readonly capabilities = {
    consistency: 'read-your-writes',
    durable: true,
    rebuildable: true,          // R8 is a projection of R3 (10 §R8)
    scale: 'vertical',
    p99TargetMs: 25,            // recent-window scan with hypertable chunk exclusion
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.pool = new Pool(ctx.manifest.config.connection);   // SAME pg as R1 when collapsed
    // Extensions + hypertable + geo index are codegen'd from the registry (R10) and applied
    // by the manifest compiler; shown here so the contract is legible:
    //   CREATE EXTENSION IF NOT EXISTS timescaledb; CREATE EXTENSION IF NOT EXISTS postgis;
    //   CREATE TABLE ts_point (
    //     series text NOT NULL, entity_id text, ts_ns bigint NOT NULL,
    //     ts timestamptz GENERATED ALWAYS AS (to_timestamp(ts_ns/1e9)) STORED,
    //     geom geography(Point,4326), fields jsonb NOT NULL);
    //   SELECT create_hypertable('ts_point','ts', chunk_time_interval => INTERVAL '1 day');
    //   CREATE INDEX ON ts_point USING gist (geom);
    //   CREATE INDEX ON ts_point (series, entity_id, ts DESC);
    await this.pool.query('SELECT 1');
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.pool.query('SELECT 1'); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { await this.pool.end(); }

  // --- writes (R3 → R8 projector) -------------------------------------------

  async ingest(points: TimePoint[]): Promise<void> {
    if (!points.length) return;
    // Single multi-row INSERT; ST_MakePoint(lon,lat) — PostGIS is (x=lon, y=lat).
    const vals: string[] = []; const args: unknown[] = []; let n = 0;
    for (const p of points) {
      const geom = p.lon != null && p.lat != null
        ? `ST_SetSRID(ST_MakePoint($${++n},$${++n}),4326)::geography` : 'NULL';
      if (p.lon != null && p.lat != null) { args.push(p.lon, p.lat); }
      vals.push(`($${++n},$${++n},$${++n},${geom},$${++n})`);
      args.push(p.series, p.entityId ?? null, String(p.tsNs), JSON.stringify(p.fields));
    }
    await this.pool.query(
      `INSERT INTO ts_point(series, entity_id, ts_ns, geom, fields) VALUES ${vals.join(',')}`, args);
  }

  // --- reads ----------------------------------------------------------------

  async range(series: string, win: TimeWindow, geo?: GeoFilter, entityId?: EntityId): Promise<TimePoint[]> {
    const where = [`series=$1`, `ts >= $2`, `ts < $3`];
    const args: unknown[] = [series, nsToIso(win.fromNs), nsToIso(win.toNs)];
    if (entityId) { where.push(`entity_id=$${args.length + 1}`); args.push(entityId); }
    where.push(this.geoClause(geo, args));   // appends params, returns SQL
    const { rows } = await this.pool.query(
      `SELECT series, entity_id, ts_ns, ST_Y(geom::geometry) lat, ST_X(geom::geometry) lon, fields
         FROM ts_point WHERE ${where.filter(Boolean).join(' AND ')} ORDER BY ts ASC`, args);
    return rows.map(this.toPoint);
  }

  async downsample(series: string, win: TimeWindow, bucket: BucketSpec, geo?: GeoFilter): Promise<AggRow[]> {
    // time_bucket() is the Timescale continuous-aggregate primitive (Geotime histogram).
    const aggs = bucket.aggregates.map(a => `${a.fn}((fields->>'${a.field}')::float8) AS "${a.as}"`).join(', ');
    const where = [`series=$1`, `ts >= $2`, `ts < $3`];
    const args: unknown[] = [series, nsToIso(win.fromNs), nsToIso(win.toNs)];
    where.push(this.geoClause(geo, args));
    const { rows } = await this.pool.query(
      `SELECT time_bucket($${args.push(bucket.every) && args.length}, ts) AS bucket,
              ${aggs}, ST_Y(ST_Centroid(ST_Collect(geom::geometry))) lat,
                       ST_X(ST_Centroid(ST_Collect(geom::geometry))) lon
         FROM ts_point WHERE ${where.filter(Boolean).join(' AND ')}
         GROUP BY bucket ORDER BY bucket ASC`, args);
    return rows.map(r => ({
      bucketNs: BigInt(new Date(r.bucket).getTime()) * 1_000_000n,
      lat: r.lat ?? undefined, lon: r.lon ?? undefined,
      values: Object.fromEntries(bucket.aggregates.map(a => [a.as, Number(r[a.as])])),
    }));
  }

  async track(entityId: EntityId, win: TimeWindow): Promise<TimePoint[]> {
    // Ordered positions for ONE vessel — track playback. The (series,entity_id,ts) index
    // makes this a chunk-excluded index scan, p99 well under the R8 ceiling.
    const { rows } = await this.pool.query(
      `SELECT series, entity_id, ts_ns, ST_Y(geom::geometry) lat, ST_X(geom::geometry) lon, fields
         FROM ts_point WHERE entity_id=$1 AND ts >= $2 AND ts < $3 AND geom IS NOT NULL
         ORDER BY ts ASC`,
      [entityId, nsToIso(win.fromNs), nsToIso(win.toNs)]);
    return rows.map(this.toPoint);
  }

  async ensureContinuousAggregate(series: string, bucket: BucketSpec): Promise<void> {
    // A real continuous aggregate is a materialized, incrementally-refreshed view —
    // downsample() then reads the cagg, not the raw hypertable. One per (series,every).
    const view = `cagg_${series.replace(/\W/g, '_')}_${bucket.every.replace(/\W/g, '_')}`;
    const aggs = bucket.aggregates.map(a => `${a.fn}((fields->>'${a.field}')::float8) AS "${a.as}"`).join(', ');
    await this.pool.query(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${view}
         WITH (timescaledb.continuous) AS
         SELECT series, time_bucket($1, ts) AS bucket, ${aggs}
           FROM ts_point WHERE series=$2 GROUP BY series, bucket WITH NO DATA`,
      [bucket.every, series]);
    await this.pool.query(
      `SELECT add_continuous_aggregate_policy($1,
         start_offset => NULL, end_offset => INTERVAL '1 hour',
         schedule_interval => INTERVAL '1 hour')`, [view]);
  }

  // --- geo predicate (PostGIS) ----------------------------------------------
  private geoClause(geo: GeoFilter | undefined, args: unknown[]): string {
    if (!geo) return '';
    if (geo.kind === 'bbox') {
      // ST_MakeEnvelope is (minLon,minLat,maxLon,maxLat).
      args.push(geo.sw[1], geo.sw[0], geo.ne[1], geo.ne[0]);
      const b = args.length;
      return `ST_Within(geom::geometry, ST_MakeEnvelope($${b-3},$${b-2},$${b-1},$${b},4326))`;
    }
    // radius: ST_DWithin on geography is metres; 1 nm = 1852 m.
    args.push(geo.lon, geo.lat, geo.nm * 1852);
    const b = args.length;
    return `ST_DWithin(geom, ST_SetSRID(ST_MakePoint($${b-2},$${b-1}),4326)::geography, $${b})`;
  }

  private toPoint = (r: any): TimePoint => ({
    series: r.series, entityId: r.entity_id ?? undefined, tsNs: BigInt(r.ts_ns),
    lat: r.lat ?? undefined, lon: r.lon ?? undefined, fields: r.fields,
  });
}
```

This adapter is the **direct lift** of what `planetar-ais` + the ontology SQLite store do today (geo BBox in `victoria.mjs`, position history in `observation`), onto a single engine that also holds R1 — *no application code changes*, the manifest just points `timeseries-geo` at the same connection as `canonical-store`.

### 3.2 `ClickHouseTimeSeries` — fire-hose volume (also serves R9, §4.1)

ClickHouse with `geoDistance`/`pointInPolygon` for geo and an `AggregatingMergeTree` materialized view as the continuous-aggregate equivalent.

```ts
// 40-ADAPTERS/clickhouse/timeseries-geo.ts
import { createClient, ClickHouseClient } from '@clickhouse/client';
import type {
  TimeSeriesGeo, TimePoint, TimeWindow, BucketSpec, GeoFilter, AggRow,
} from '../../spine/ports/timeseries-geo';
import type { AdapterContext, HealthStatus } from '../../spine/ports/adapter';
import type { EntityId } from '../../spine/model';

const NM_M = 1852;
const everyToCH: Record<string, string> = { '1 minute': 'toStartOfMinute', '1 hour': 'toStartOfHour', '1 day': 'toStartOfDay' };

export class ClickHouseTimeSeries implements TimeSeriesGeo {
  private ch!: ClickHouseClient;

  readonly capabilities = {
    consistency: 'eventual',     // async inserts + eventual MV refresh; R8 tolerates recent-read
    durable: true,
    rebuildable: true,
    scale: 'sharded',
    p99TargetMs: 30,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.ch = createClient(ctx.manifest.config.connection);  // { url, database, username, password }
    // DDL applied by the compiler from R10 codegen:
    //   CREATE TABLE ts_point (series LowCardinality(String), entity_id String,
    //     ts DateTime64(9), lat Float64, lon Float64, fields String /*json*/)
    //   ENGINE = MergeTree ORDER BY (series, entity_id, ts);
    await this.ch.query({ query: 'SELECT 1' });
  }
  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.ch.query({ query: 'SELECT 1' }); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { await this.ch.close(); }

  async ingest(points: TimePoint[]): Promise<void> {
    await this.ch.insert({
      table: 'ts_point', format: 'JSONEachRow',
      values: points.map(p => ({
        series: p.series, entity_id: p.entityId ?? '',
        ts: Number(p.tsNs) / 1e9, lat: p.lat ?? 0, lon: p.lon ?? 0,
        fields: JSON.stringify(p.fields),
      })),
    });
  }

  async range(series: string, win: TimeWindow, geo?: GeoFilter, entityId?: EntityId): Promise<TimePoint[]> {
    const where = [`series = {series:String}`, `ts >= {from:Float64}`, `ts < {to:Float64}`];
    const params: Record<string, unknown> = { series, from: Number(win.fromNs) / 1e9, to: Number(win.toNs) / 1e9 };
    if (entityId) { where.push(`entity_id = {eid:String}`); params.eid = entityId; }
    where.push(this.geoExpr(geo, params));
    const rs = await this.ch.query({
      query: `SELECT series, entity_id, toUnixTimestamp64Nano(ts) AS ts_ns, lat, lon, fields
                FROM ts_point WHERE ${where.filter(Boolean).join(' AND ')} ORDER BY ts ASC`,
      query_params: params, format: 'JSONEachRow',
    });
    return (await rs.json<any>()).map(this.toPoint);
  }

  async downsample(series: string, win: TimeWindow, bucket: BucketSpec, geo?: GeoFilter): Promise<AggRow[]> {
    const fn = everyToCH[bucket.every] ?? 'toStartOfHour';
    const aggs = bucket.aggregates.map(a => `${chAgg(a.fn)}(JSONExtractFloat(fields, '${a.field}')) AS "${a.as}"`).join(', ');
    const where = [`series = {series:String}`, `ts >= {from:Float64}`, `ts < {to:Float64}`];
    const params: Record<string, unknown> = { series, from: Number(win.fromNs) / 1e9, to: Number(win.toNs) / 1e9 };
    where.push(this.geoExpr(geo, params));
    const rs = await this.ch.query({
      query: `SELECT toUnixTimestamp64Nano(${fn}(ts)) AS bucket_ns, ${aggs},
                     avg(lat) AS lat, avg(lon) AS lon
                FROM ts_point WHERE ${where.filter(Boolean).join(' AND ')}
                GROUP BY ${fn}(ts) ORDER BY bucket_ns ASC`,
      query_params: params, format: 'JSONEachRow',
    });
    return (await rs.json<any>()).map((r: any) => ({
      bucketNs: BigInt(r.bucket_ns), lat: r.lat, lon: r.lon,
      values: Object.fromEntries(bucket.aggregates.map(a => [a.as, Number(r[a.as])])),
    }));
  }

  async track(entityId: EntityId, win: TimeWindow): Promise<TimePoint[]> {
    const rs = await this.ch.query({
      query: `SELECT series, entity_id, toUnixTimestamp64Nano(ts) AS ts_ns, lat, lon, fields
                FROM ts_point WHERE entity_id = {eid:String}
                  AND ts >= {from:Float64} AND ts < {to:Float64} ORDER BY ts ASC`,
      query_params: { eid: entityId, from: Number(win.fromNs) / 1e9, to: Number(win.toNs) / 1e9 },
      format: 'JSONEachRow',
    });
    return (await rs.json<any>()).map(this.toPoint);
  }

  async ensureContinuousAggregate(series: string, bucket: BucketSpec): Promise<void> {
    // ClickHouse continuous-aggregate equivalent: a materialized view into an
    // AggregatingMergeTree, refreshed incrementally on every insert.
    const fn = everyToCH[bucket.every] ?? 'toStartOfHour';
    const view = `mv_${series.replace(/\W/g, '_')}_${bucket.every.replace(/\W/g, '_')}`;
    const aggs = bucket.aggregates.map(a => `${chAggState(a.fn)}(JSONExtractFloat(fields, '${a.field}')) AS "${a.as}"`).join(', ');
    await this.ch.command({ query:
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${view}
         ENGINE = AggregatingMergeTree ORDER BY (series, bucket)
         AS SELECT series, ${fn}(ts) AS bucket, ${aggs}
              FROM ts_point WHERE series = '${series}' GROUP BY series, bucket` });
  }

  private geoExpr(geo: GeoFilter | undefined, params: Record<string, unknown>): string {
    if (!geo) return '';
    if (geo.kind === 'bbox') {
      params.minLat = geo.sw[0]; params.minLon = geo.sw[1]; params.maxLat = geo.ne[0]; params.maxLon = geo.ne[1];
      return `lat BETWEEN {minLat:Float64} AND {maxLat:Float64} AND lon BETWEEN {minLon:Float64} AND {maxLon:Float64}`;
    }
    params.clat = geo.lat; params.clon = geo.lon; params.rm = geo.nm * NM_M;
    return `geoDistance(lon, lat, {clon:Float64}, {clat:Float64}) <= {rm:Float64}`;
  }
  private toPoint = (r: any): TimePoint => ({
    series: r.series, entityId: r.entity_id || undefined, tsNs: BigInt(r.ts_ns),
    lat: r.lat, lon: r.lon, fields: typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields,
  });
}

const chAgg = (f: string) => f === 'last' ? 'anyLast' : f;
const chAggState = (f: string) => `${chAgg(f)}State`;
```

### 3.3 DuckDB (embedded) and plain PostGIS

- **DuckDB** (`40-ADAPTERS/duckdb/timeseries-geo.ts`) implements the same port over the in-process engine with the `spatial` extension (`ST_Within`, `ST_DWithin` via GEOS, identical predicate shapes to §3.1) and `time_bucket()` from the `icu` extension. `downsample()` runs over a Parquet file or an in-memory table; `ensureContinuousAggregate()` materializes a DuckDB table refreshed on a timer (no server-side incremental refresh — the embedded tradeoff). One DuckDB file can back **R8 *and* R9** at the edge.
- **plain PostGIS** is the §3.1 class **minus** the Timescale calls: drop `create_hypertable`, `time_bucket`, and `ensureContinuousAggregate` becomes a plain `CREATE MATERIALIZED VIEW` refreshed by the R14 work-queue. `range`/`track`/geo are byte-identical. The binder registers it as `engine: postgis`; the same `pg` driver, a BRIN index on `ts_ns` instead of a hypertable.

---

## 4. R9 adapters

### 4.1 `ClickHouseOlap` — columnar roll-ups powering reports / dashboards / Contour / calculated insights

The default R9. A roll-up `query()` is the unit that backs one report row, one CRM-Analytics lens, one Contour board node, one Data-Cloud Calculated Insight.

```ts
// 40-ADAPTERS/clickhouse/analytics-olap.ts
import { createClient, ClickHouseClient } from '@clickhouse/client';
import type {
  AnalyticsOlap, OlapQuery, OlapResult, VirtualSource,
} from '../../spine/ports/analytics-olap';
import type { AdapterContext, HealthStatus } from '../../spine/ports/adapter';

const OP: Record<string, string> = { eq: '=', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=', in: 'IN' };

export class ClickHouseOlap implements AnalyticsOlap {
  private ch!: ClickHouseClient;

  readonly capabilities = {
    consistency: 'eventual',
    durable: true,
    rebuildable: true,           // R9 fact tables are projections of R3/R1
    scale: 'sharded',
    p99TargetMs: 1000,           // seconds-scale big scans; sub-second on a rollup MV
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.ch = createClient(ctx.manifest.config.connection);
    await this.ch.query({ query: 'SELECT 1' });
  }
  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.ch.query({ query: 'SELECT 1' }); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { await this.ch.close(); }

  async query(q: OlapQuery): Promise<OlapResult> {
    const { sql, params } = this.compile(q);
    const t0 = Date.now();
    const rs = await this.ch.query({ query: sql, query_params: params, format: 'JSONEachRow' });
    const rows = await rs.json<Record<string, unknown>>();
    return {
      columns: q.select.map(s => s.as),
      rows,
      engineMs: Date.now() - t0,
    };
  }

  async ensureRollup(name: string, q: OlapQuery): Promise<void> {
    // Materialize the group-by cube so a dashboard reads a tiny table, not the fact scan.
    const { sql } = this.compile(q, /*forMv*/ true);
    await this.ch.command({ query:
      `CREATE MATERIALIZED VIEW IF NOT EXISTS rollup_${name}
         ENGINE = SummingMergeTree ORDER BY (${(q.groupBy ?? []).join(', ') || 'tuple()'})
         AS ${sql}` });
  }

  async registerVirtualTable(name: string, source: VirtualSource): Promise<void> {
    // ClickHouse can itself federate to an external warehouse, but the canonical
    // zero-copy binding lives in §4.3. Here we wire ClickHouse's own external-table
    // engines (e.g. the `postgresql`/`s3`/`iceberg` table functions) when the
    // warehouse is reachable that way; otherwise the manifest binds §4.3 directly.
    throw new Error(`use the federated R9 adapter (§4.3) for ${source.engine}; ` +
      `ClickHouse virtual tables cover postgres/s3/iceberg only`);
  }

  private compile(q: OlapQuery, forMv = false): { sql: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = {};
    const sel = q.select.map(s => `${s.expr} AS "${s.as}"`).join(', ');
    const where = (q.where ?? []).map((p, i) => {
      params[`p${i}`] = p.value;
      return p.op === 'in'
        ? `${p.col} IN ({p${i}:Array(String)})`
        : `${p.col} ${OP[p.op]} {p${i}:String}`;
    });
    const grp = q.groupBy?.length ? ` GROUP BY ${q.groupBy.join(', ')}` : '';
    const ord = !forMv && q.orderBy?.length
      ? ` ORDER BY ${q.orderBy.map(o => `"${o.col}" ${o.dir.toUpperCase()}`).join(', ')}` : '';
    const lim = !forMv && q.limit ? ` LIMIT ${q.limit}` : '';
    const sql = `SELECT ${q.groupBy?.length ? q.groupBy.join(', ') + ', ' : ''}${sel} ` +
                `FROM ${q.from}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${grp}${ord}${lim}`;
    return { sql, params };
  }
}
```

A worked roll-up — *"detections per sensor per hour over the last day"*, the kind of panel that drives the maritime UI's signal-summary or a financial-crime "alerts by typology" dashboard:

```ts
const olap = platform.role<AnalyticsOlap>('analytics-olap');
const report = await olap.query({
  from: 'fact_detection',
  select: [{ expr: 'count()', as: 'detections' }, { expr: 'uniqExact(entity_id)', as: 'vessels' }],
  where: [{ col: 'ts', op: 'gte', value: '2026-06-08 00:00:00' }],
  groupBy: ['sensor', 'toStartOfHour(ts)'],
  orderBy: [{ col: 'detections', dir: 'desc' }],
  limit: 200,
});   // → { columns:['detections','vessels'], rows:[…], engineMs: 14 }
```

`ensureRollup('detection_hourly', q)` turns that into a `SummingMergeTree` MV so the dashboard reads a pre-aggregated table — the Contour/CRMA "this board is fast because the cube is materialized" property.

### 4.2 DuckDB / postgres OLAP

- **`DuckDbOlap`** (`40-ADAPTERS/duckdb/analytics-olap.ts`) implements the identical port over an in-process DuckDB, with `query()` running SQL over Parquet/Arrow exported from R1/R3 and `registerVirtualTable()` using DuckDB's own scanners (`postgres_scan`, `iceberg_scan`, `read_parquet` over S3) — DuckDB is itself a competent federation engine for a single-node footprint, which is why it doubles as a lightweight §4.3.
- **`PostgresOlap`** is the §4.1 shape against the R1 postgres for small reporting volumes — reuses the `pg` pool already bound to R1, so a *standard* client gets R9-small for free with zero new services (the postgres-covers-R1+R8+small-R9 collapse).

### 4.3 Federated `WarehouseOlap` — **zero-copy query-in-place** (Foundry virtual tables / Data Cloud zero-copy)

The keystone of this file. The client's data lives in BigQuery / Snowflake / Databricks and **will not be ingested**. We bind R9 to a federated adapter: `query()` is *pushed down* to the warehouse, which scans its own columnar storage; only the small aggregated result crosses the wire. The platform reports over data it never copies — exactly Foundry's **virtual tables** and Salesforce Data Cloud's **zero-copy** federation.

```ts
// 40-ADAPTERS/warehouse/analytics-olap.ts
import type {
  AnalyticsOlap, OlapQuery, OlapResult, VirtualSource,
} from '../../spine/ports/analytics-olap';
import type { AdapterContext, HealthStatus } from '../../spine/ports/adapter';

/** A warehouse driver: BigQuery / Snowflake / Databricks each provide one of these. */
interface WarehouseDriver {
  run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; bytesScanned?: number }>;
  quoteRef(ref: string): string;     // dialect-correct fully-qualified table name
  ping(): Promise<void>;
  dispose(): Promise<void>;
}

const OP: Record<string, string> = { eq: '=', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=', in: 'IN' };

export class WarehouseOlap implements AnalyticsOlap {
  private driver!: WarehouseDriver;
  private virtual = new Map<string, VirtualSource>();   // logical name → external ref

  readonly capabilities = {
    consistency: 'eventual',
    durable: true,
    rebuildable: false,          // EXCEPTION: a virtual table is NOT a projection of our R3 —
                                 // it is the client's external warehouse. The compiler allows
                                 // rebuildable:false ONLY for the federated R9 binding.
    scale: 'global',
    p99TargetMs: 3000,           // network + warehouse scan; reports tolerate seconds
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { engine: VirtualSource['engine']; connection: unknown };
    this.driver = await loadWarehouseDriver(cfg.engine, cfg.connection);  // dynamic; never imported by the spine
    await this.driver.ping();
  }
  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.driver.ping(); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }
  async close(): Promise<void> { await this.driver.dispose(); }

  /** Register an external warehouse table as a zero-copy virtual fact. No data moves. */
  async registerVirtualTable(name: string, source: VirtualSource): Promise<void> {
    if (!source.pushdown) throw new Error(`virtual table ${name} must allow pushdown for zero-copy`);
    this.virtual.set(name, source);
    // Optionally CREATE EXTERNAL/VIRTUAL TABLE so the warehouse exposes it under `name`;
    // for pure pushdown we just remember the ref and rewrite `from` at query time.
  }

  async query(q: OlapQuery): Promise<OlapResult> {
    const v = this.virtual.get(q.from);
    if (!v) throw new Error(`R9-federated: '${q.from}' is not a registered virtual table`);

    // Compile to the warehouse dialect and PUSH DOWN: the GROUP BY / aggregate executes
    // inside BigQuery/Snowflake/Databricks; only the rolled-up result is returned.
    const sel = q.select.map(s => `${s.expr} AS ${s.as}`).join(', ');
    const grpCols = q.groupBy ?? [];
    const params: unknown[] = [];
    const where = (q.where ?? []).map(p => {
      params.push(p.value);
      return p.op === 'in' ? `${p.col} IN (?)` : `${p.col} ${OP[p.op]} ?`;
    });
    const sql =
      `SELECT ${grpCols.length ? grpCols.join(', ') + ', ' : ''}${sel} ` +
      `FROM ${this.driver.quoteRef(v.ref)}` +                       // the EXTERNAL table, in place
      `${where.length ? ' WHERE ' + where.join(' AND ') : ''}` +
      `${grpCols.length ? ' GROUP BY ' + grpCols.join(', ') : ''}` +
      `${q.orderBy?.length ? ' ORDER BY ' + q.orderBy.map(o => `${o.col} ${o.dir}`).join(', ') : ''}` +
      `${q.limit ? ' LIMIT ' + q.limit : ''}`;

    const t0 = Date.now();
    const { rows, bytesScanned } = await this.driver.run(sql, params);   // executes IN the warehouse
    return {
      columns: [...grpCols, ...q.select.map(s => s.as)],
      rows,
      scannedRows: bytesScanned,        // warehouse reports bytes; surfaced for cost visibility
      engineMs: Date.now() - t0,
    };
  }

  async ensureRollup(name: string, q: OlapQuery): Promise<void> {
    // Zero-copy means we do NOT materialize the client's data on our side. The "rollup"
    // is a saved query pushed down on read (Foundry virtual-table semantics), or — if the
    // client opts in — a warehouse-side materialized view we ask the warehouse to maintain.
    this.virtual.set(name, { ...this.virtual.get(q.from)!, ref: q.from });
  }
}

/** Loaded dynamically per engine so the spine bundle never imports @google-cloud/bigquery etc. */
async function loadWarehouseDriver(engine: VirtualSource['engine'], conn: unknown): Promise<WarehouseDriver> {
  switch (engine) {
    case 'bigquery': {
      const { BigQuery } = await import('@google-cloud/bigquery');
      const bq = new BigQuery(conn as any);
      return {
        run: async (sql, params) => {
          const [rows, , meta] = await bq.query({ query: sql, params, parameterMode: 'positional' });
          return { rows, bytesScanned: Number((meta as any)?.totalBytesProcessed ?? 0) };
        },
        quoteRef: (ref) => '`' + ref.replace(/`/g, '') + '`',
        ping: async () => { await bq.query('SELECT 1'); },
        dispose: async () => {},
      };
    }
    case 'snowflake': {
      const sf = await import('snowflake-sdk');
      const conn2 = sf.createConnection(conn as any);
      await new Promise<void>((res, rej) => conn2.connect((e) => e ? rej(e) : res()));
      return {
        run: (sql, params) => new Promise((res, rej) =>
          conn2.execute({ sqlText: sql, binds: params as any[],
            complete: (e, _s, rows) => e ? rej(e) : res({ rows: rows ?? [] }) })),
        quoteRef: (ref) => ref.split('.').map(p => `"${p}"`).join('.'),
        ping: () => new Promise((res, rej) => conn2.execute({ sqlText: 'SELECT 1',
          complete: (e) => e ? rej(e) : res() })),
        dispose: async () => conn2.destroy(() => {}),
      };
    }
    case 'databricks': {
      const { DBSQLClient } = await import('@databricks/sql');
      const client = new DBSQLClient();
      await client.connect(conn as any);
      return {
        run: async (sql, params) => {
          const session = await client.openSession();
          const op = await session.executeStatement(sql, { ordinalParameters: params as any[] });
          const rows = await op.fetchAll(); await op.close(); await session.close();
          return { rows: rows as Record<string, unknown>[] };
        },
        quoteRef: (ref) => ref.split('.').map(p => `\`${p}\``).join('.'),
        ping: async () => { const s = await client.openSession(); await s.close(); },
        dispose: async () => client.close(),
      };
    }
  }
}

export const makeWarehouseOlap = () => new WarehouseOlap();
```

Worked zero-copy report — a Data-Cloud-style Calculated Insight over a client's **Snowflake** sales fact, never copied into our R1:

```ts
const fed = platform.role<AnalyticsOlap>('analytics-olap');   // engine: snowflake (federated)
await fed.registerVirtualTable('fact_opportunity', {
  engine: 'snowflake', ref: 'SALES.PUBLIC.OPPORTUNITIES', pushdown: true,
});
const pipeline = await fed.query({
  from: 'fact_opportunity',
  select: [{ expr: 'SUM(amount)', as: 'pipeline' }, { expr: 'COUNT(*)', as: 'deals' }],
  where: [{ col: 'stage', op: 'ne', value: 'Closed Lost' }],
  groupBy: ['owner_region', 'fiscal_quarter'],
});   // the SUM/GROUP BY runs INSIDE Snowflake; only the rolled-up grid returns. Zero rows copied.
```

The Object API can surface `pipeline` as a derived metric on the ontology's `Opportunity` object **without** that warehouse ever becoming a projection of our bus — the lineage edge (R12) records `Opportunity.pipeline ← snowflake://SALES.PUBLIC.OPPORTUNITIES` so governance and Monocle still see provenance into the external source, even though no bytes were ingested.

---

## 5. Comparison table

### R8 · timeseries-geo

| Engine | Driver | Consistency | Geo support | Continuous-aggregate primitive | Scale | p99 (recent window) | When to choose |
|---|---|---|---|---|---|---|---|
| **timescaledb + postgis** | `pg` | read-your-writes (strong) | **full** (GEOS, `geography`, GiST) | `time_bucket` + continuous aggregate (incremental) | vertical | ~10–25 ms | **default**; collapses **R1+R8** onto one postgres |
| **clickhouse** | `@clickhouse/client` | eventual | box/radius (`pointInPolygon`,`geoDistance`,H3) | `AggregatingMergeTree` MV | sharded | ~5–30 ms | fire-hose volume (10⁸–10¹⁰ rows); also serves R9 |
| **duckdb** | `duckdb` | read-your-writes (single proc) | full (`spatial`/GEOS) | timed table refresh (no server-side incremental) | single | ~5–40 ms (in-proc) | embedded/edge/notebook; covers R8+R9 in one file |
| **postgis** (plain) | `pg` | strong | **full** | plain materialized view (refresh via R14) | vertical | ~10–30 ms | geo without Timescale hypertables/licensing |

### R9 · analytics-olap

| Engine | Driver | Consistency | Data location | Rebuildable | Scale | p99 (big scan) | When to choose |
|---|---|---|---|---|---|---|---|
| **clickhouse** | `@clickhouse/client` | eventual | ours (projection) | yes | sharded | ~0.1–1 s (sub-s on MV) | **default**; billions of rows, fast dashboards |
| **duckdb** | `duckdb` | read-your-writes | ours (Parquet/Arrow) | yes | single | ~0.1–2 s | embedded/single-node Contour-locally |
| **bigquery / snowflake / databricks** | warehouse SDK | eventual | **client's warehouse (external)** | **no** (virtual) | global | ~0.5–3 s + network | **zero-copy** — data we may not copy; query-in-place |
| **postgres** | `pg` | strong | ours (R1 reuse) | yes | vertical | ~0.1–1 s (≤ low-millions rows) | small reporting; reuse the R1 workhorse |

**The honest tradeoffs:**
- **Timescale+PostGIS buys collapse, not infinite scale.** It is the right default precisely because it adds *zero new engines* — R1, R8, R7 (pgvector), R4-FTS all on one postgres. But it scales vertically; past ~10⁹ track rows or sustained > ~100 k inserts/s, geo+time scans on one box exceed the p99 ceiling and you move R8 to ClickHouse. Because R8 is **rebuildable from R3** ([`10 §R8`](../10-STORAGE-ROLES.md)), that move is a manifest edit + a bus replay, not a rewrite.
- **The federated R9 binding is the one place `rebuildable: false` is legal.** Every other store in the platform is a projection of the bus and can be dropped/rebuilt. A virtual warehouse table is *not* — it's the client's external system, queried in place. The compiler permits `rebuildable:false` **only** for `analytics-olap` bound to `bigquery`/`snowflake`/`databricks`; the same flag on R1 or R8 is a contract error. Zero-copy means you trade rebuildability + sub-ms latency for *never copying the client's data* — the entire point of Data-Cloud zero-copy and Foundry virtual tables.
- **ClickHouse double-duty.** A scale-tier client can bind **both** R8 and R9 to one ClickHouse cluster — track points and fact tables are both `MergeTree` columnar; the continuous-aggregate MV and the rollup MV are the same mechanism. That's the scale-tier analogue of the standard-tier postgres collapse.

---

## 6. Conformance-suite hookup

Both ports ship one engine-agnostic suite ([`12 §5`](../12-ADAPTER-CONTRACT.md)); an engine is "supported for R8/R9" only when green.

```ts
// 40-ADAPTERS/_conformance/timeseries-geo.spec.ts
export function timeSeriesGeoConformance(make: () => TimeSeriesGeo) {
  test('round-trips a track and replays it in order', async () => {
    const ts = make(); await ts.init(testCtx());
    await ts.ingest(victoriaTrack);                                 // 60 AIS fixes, one vessel
    const t = await ts.track('planetar:Vessel/abc', dayWindow);
    expect(t).toHaveLength(60);
    expect(t.map(p => p.tsNs)).toEqual([...t.map(p => p.tsNs)].sort()); // monotonic
  });
  test('geo-within bbox excludes out-of-area points', async () => {
    const ts = make(); await ts.init(testCtx());
    await ts.ingest([...inVictoria, ...inHormuz]);
    const got = await ts.range('ais.position', dayWindow, { kind: 'bbox', sw: VIC_SW, ne: VIC_NE });
    expect(got.every(p => insideBBox(p.lat!, p.lon!, VICTORIA_BBOX))).toBe(true);   // victoria.mjs predicate
  });
  test('downsample buckets honor the every + aggregate spec', async () => {
    const ts = make(); await ts.init(testCtx());
    await ts.ingest(victoriaTrack);
    const rollup = await ts.downsample('ais.position', dayWindow,
      { every: '1 hour', aggregates: [{ field: 'sog', fn: 'avg', as: 'avg_sog' }] });
    expect(rollup.length).toBeLessThanOrEqual(24);
    expect(rollup[0].values.avg_sog).toBeGreaterThanOrEqual(0);
  });
  test('declares capabilities that satisfy the R8 contract', () => {
    expect(satisfies(ROLE_CONTRACT['timeseries-geo'], make().capabilities)).toBe(true);
  });
}
// then: timeSeriesGeoConformance(() => new TimescalePostgisTimeSeries())  // testcontainers: timescale/timescaledb-ha
//       timeSeriesGeoConformance(() => new ClickHouseTimeSeries())         // testcontainers: clickhouse/clickhouse-server
//       timeSeriesGeoConformance(() => new DuckDbTimeSeries())             // in-proc, no container
//       timeSeriesGeoConformance(() => new PostgisTimeSeries())            // testcontainers: postgis/postgis
```

```ts
// 40-ADAPTERS/_conformance/analytics-olap.spec.ts
export function analyticsOlapConformance(make: () => AnalyticsOlap, opts: { federated?: boolean } = {}) {
  test('group-by rollup returns one row per dimension tuple', async () => {
    const o = make(); await o.init(testCtx());
    const r = await o.query({ from: 'fact_detection',
      select: [{ expr: 'count()', as: 'n' }], groupBy: ['sensor'] });
    expect(r.columns).toContain('n');
    expect(new Set(r.rows.map((x: any) => x.sensor)).size).toBe(r.rows.length);  // one per sensor
  });
  test('ensureRollup makes the same query read a materialized cube', async () => { /* ... */ });
  // Federated engines additionally assert ZERO-COPY: the query executes warehouse-side and
  // the adapter never writes to R1/R8 — gated, since only the warehouse adapters can reach it.
  (opts.federated ? test : test.skip)('virtual-table query pushes down + copies no rows', async () => {
    const o = make(); await o.init(testCtx());
    await o.registerVirtualTable('fact_opportunity',
      { engine: 'snowflake', ref: 'SALES.PUBLIC.OPPORTUNITIES', pushdown: true });
    const r = await o.query({ from: 'fact_opportunity', select: [{ expr: 'SUM(amount)', as: 's' }] });
    expect(r.rows[0].s).toBeGreaterThan(0);
    expect(canonicalStoreRowCount()).toBe(0);   // PROOF: nothing landed in R1
  });
  test('declares capabilities that satisfy the R9 contract', () => {
    expect(satisfies(ROLE_CONTRACT['analytics-olap'], make().capabilities, { allowExternal: opts.federated })).toBe(true);
  });
}
// clickhouse / duckdb / postgres pass the core suite; warehouse adapters add the federated case.
```

The federated assertion — *the query executed and **zero rows landed in R1*** — is what makes the zero-copy claim auditable. A normal R9 engine that secretly ingested would fail it; the warehouse adapter passes because `query()` only ever reads the rolled-up grid back.

---

## 7. Which manifest tiers / clients bind these

| Tier ([`13 §1`](../13-CLIENT-MANIFEST.md)) | R8 binding | R9 binding | Rationale |
|---|---|---|---|
| `edge` / `air-gapped` | **postgis** (or **duckdb**) | **duckdb** (or none) | offline geo; analytics in-process; no server; one DuckDB file can do both |
| `standard` | **timescaledb+postgis** *(same pg as R1)* | **postgres** *(same pg)* — or **clickhouse** if volume | the collapse: one postgres = R1+R8+small-R9 |
| `scale` | **clickhouse** | **clickhouse** *(same cluster)* | billions of rows, sub-s dashboards; R8+R9 on one engine |
| any tier, external data | (R8 as above) | **bigquery / snowflake / databricks** *(federated)* | client's warehouse may not be copied → zero-copy query-in-place |

Across the four reference clients ([`README`](../README.md)):

- **Maritime / defence (`planetar`)** — *edge* today: R8 is effectively the ontology SQLite `observation(ts_ns)` + `kinematics.ts` track playback (built); the scale-up path binds **timescaledb+postgis** (standard) then **clickhouse** for fleet-wide track volume. R9 rarely binds at the edge (no big-scan reporting offline); a regional command tier adds **clickhouse** for "detections by sensor/area/hour" dashboards. Sovereignty rules out the GCP-resident **bigquery** federation; a coalition data-sharing tier might federate to a partner's warehouse.
- **Biotech / research CRM (`doibio`)** — *standard* **postgres** for R9 (its analytics are small canned SQL today, `src/lib/metrics.ts`); R8 only binds if it adds geospatial sample-site tracking. The clean R9 upgrade story: replace doibio's canned-SQL "reports" with `OlapQuery` cubes — that's the report-builder parity gap closing.
- **Generic enterprise CRM+ops** — the natural **federated R9** client: it already has a Snowflake/BigQuery warehouse, and **zero-copy** is the Data-Cloud parity headline. R8 binds **timescaledb+postgis** for Salesforce-Maps-style territory/route geo.
- **Intel / financial-crime graph** — **clickhouse** for R8 (event/transaction time series at volume) *and* R9 (alerts-by-typology, ring-activity-over-time dashboards), with the federated R9 binding layered on to query a partner bank's warehouse in place when the data can't leave their tenancy.

The invariance holds exactly as for R1 ([`global-scale.md §7`](./global-scale.md)): the track model, the Geotime/Maps surfaces, the report/insight definitions in the registry, and the dark-vessel kinematic matcher import `TimeSeriesGeo` / `AnalyticsOlap` — **none of them know** whether timescale, clickhouse, duckdb, postgis, or a federated Snowflake answered. One conformance suite, green on every engine behind two ports — that's the deliverable.
