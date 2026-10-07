// spine/ports.ts
// The 14 storage-role PORTS. Spine + application code depends only on these
// interfaces; engines (40-ADAPTERS/) implement them; the manifest binds one
// adapter per role. Phase 0 of 90-ROADMAP.md: the authoritative port set
// (12-ADAPTER-CONTRACT.md showed signatures; this file pins them).

import type {
  CanonicalEntity, Observation, Link, EntityId, TypeName, SourceId, FieldName,
  EntityQuery, Page, Tx, HealthStatus, Json, NsTimestamp, BlobHandle, SchemaType, TimeWindow, MarkingId,
} from './model.ts';
export type { MarkingId };   // re-exported so existing `import { MarkingId } from './ports'` keeps working

// ---------------------------------------------------------------------------
// Roles, engines, governance principals
// ---------------------------------------------------------------------------

export type RoleId =
  | 'canonical-store' | 'hot-cache' | 'stream' | 'object-index' | 'graph'
  | 'blob-cas' | 'vector' | 'timeseries-geo' | 'analytics-olap' | 'registry'
  | 'audit-log' | 'lineage' | 'policy-identity' | 'work-queue';

export type EngineName = string;   // 'sqlite' | 'postgres' | 'spanner' | 'redis' | 'kafka' | 'broker' | ...

export interface Principal {
  id: string;
  roles: string[];
  clearances: MarkingId[];
  attrs?: Record<string, Json>;
}

/** Governance PEP helper handed to every adapter (P1). Adapters enforce, they don't decide. */
export interface MarkingResolver {
  /** may this principal see data carrying these markings? */
  visible(principal: Principal, markings: MarkingId[]): boolean;
  /** drop/redact fields the principal lacks FLS for. */
  redactFields(principal: Principal, type: TypeName, fields: Record<FieldName, Json>): Record<FieldName, Json>;
}

// ---------------------------------------------------------------------------
// Adapter lifecycle (base of every port)
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  consistency: 'strong' | 'read-your-writes' | 'eventual' | 'append-only';
  durable: boolean;
  rebuildable: boolean;                       // re-derivable from the R3 stream?
  scale: 'single' | 'vertical' | 'sharded' | 'global';
  p99TargetMs: number;
  /** federated/query-in-place engines (R9 bigquery/snowflake) set this; lets the compiler
   *  accept rebuildable:false for an external system. */
  external?: boolean;
  /** Temporal-style engines that own job execution; flips compiler claim/complete expectations. */
  ownsExecution?: boolean;
  /** The engine persists markings per row and, when a query carries `principal`, selects and
   *  aggregates only rows whose every marking that principal holds — and resolves every name in
   *  that query as a logical field of a canonical type, never as a storage column or another
   *  table. Aggregates are allowed for principals only on engines that set this
   *  (docs/specs/2026-10-06-governed-ports-design.md §4.4). */
  enforcesMarkings?: boolean;
}

export interface ResolvedBinding {
  engine: EngineName;
  config: Record<string, Json>;
}

export interface Logger {
  info(msg: string, ctx?: Json): void;
  warn(msg: string, ctx?: Json): void;
  error(msg: string, ctx?: Json): void;
}

export interface AdapterContext {
  role: RoleId;
  manifest: ResolvedBinding;
  logger: Logger;
  marking: MarkingResolver;
}

export interface Adapter {
  init(ctx: AdapterContext): Promise<void>;
  health(): Promise<HealthStatus>;
  close(): Promise<void>;
  readonly capabilities: AdapterCapabilities;
}

// ---------------------------------------------------------------------------
// R1 — canonical-store
// ---------------------------------------------------------------------------

export interface CanonicalStore extends Adapter {
  putObservation(obs: Observation, tx?: Tx): Promise<void>;
  upsertEntity(entity: CanonicalEntity, tx?: Tx): Promise<void>;
  putLink(link: Link, tx?: Tx): Promise<void>;

  getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null>;
  listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>>;
  getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]>;
  /** Stored markings by entity id — the authority every governed read is checked against.
   *  Ids the store does not hold are omitted; an entity with no markings maps to []. */
  markingsOf(ids: EntityId[]): Promise<Record<EntityId, MarkingId[]>>;

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// R2 — hot-cache
// ---------------------------------------------------------------------------

export interface Cache extends Adapter {
  get(k: string): Promise<Json | null>;
  set(k: string, v: Json, ttlSec?: number): Promise<void>;
  del(k: string): Promise<void>;
  incr(k: string, by?: number): Promise<number>;
  // presence / UI-nudge pub-sub (R2 §10): optional, only on engines that support it
  publish?(channel: string, msg: Json): Promise<void>;
  subscribe?(channel: string): AsyncIterable<Json>;
}

// ---------------------------------------------------------------------------
// R3 — stream (the bus). Envelope = the zmesg logical form.
// ---------------------------------------------------------------------------

export type TopicPattern = string;   // 'vessel.ais.*' | 'chat.pac.**' | '**'
export type Offset = string;         // engine-opaque cursor (UUIDv7 / kafka offset / stream id)

export interface Envelope {
  id: EntityId;
  topic: string;
  source: SourceId;
  schema: TypeName;
  createdNs: NsTimestamp;
  correlationId?: string;
  causationId?: string;
  markings?: MarkingId[];            // stamped at ingest; rides the header (Phase 0: verify placement in zmesg)
  payload: Uint8Array;               // opaque body (zmesg binary or JSON-encoded canonical type)
}

export interface Stream extends Adapter {
  publish(env: Envelope): Promise<void>;
  subscribe(topics: TopicPattern[], from: Offset | 'latest'): AsyncIterable<Envelope>;
  ack(offset: Offset): Promise<void>;
}

// ---------------------------------------------------------------------------
// R4 — object-index (search/filter/aggregate + resolver blocking)
// ---------------------------------------------------------------------------

export interface IndexDoc {
  id: EntityId;
  type: TypeName;
  text?: string;                      // concatenated full-text content
  fields: Record<FieldName, Json>;    // structured, filterable
  geo?: { lat: number; lon: number };
  markings?: MarkingId[];             // search-time PEP filter
}

export interface SearchQuery {
  type?: TypeName;
  text?: string;
  filter?: { field: FieldName; op: string; value: Json }[];
  facets?: FieldName[];
  sort?: { field: FieldName; dir: 'asc' | 'desc' }[];
  geo?: { lat: number; lon: number; radiusKm: number };
  cursor?: string;
  limit?: number;
  principal?: Principal;              // applies marking filter
}

export interface SearchResult {
  hits: { id: EntityId; type: TypeName; score: number }[];
  facets?: Record<FieldName, { value: Json; count: number }[]>;
  cursor?: string;
  total?: number;
}

export interface AggQuery {
  type: TypeName;
  groupBy: FieldName[];
  metrics: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: FieldName }[];
  filter?: { field: FieldName; op: string; value: Json }[];
  principal?: Principal;              // applies marking filter (engines with enforcesMarkings)
}

export interface AggResult {
  rows: { key: Record<FieldName, Json>; metrics: Record<string, number> }[];
}

export interface ObjectIndex extends Adapter {
  index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void>;
  remove(type: TypeName, id: EntityId): Promise<void>;
  /** Replace the markings stored with an indexed row (no-op if the row is not indexed). */
  setMarkings(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void>;
  search(q: SearchQuery): Promise<SearchResult>;
  aggregate(q: AggQuery): Promise<AggResult>;
  /** the resolver's BLOCKING step (R5/P5 → R4): candidate match ids to avoid O(n^2). */
  searchCandidates(type: TypeName, blockingKeys: Record<FieldName, Json>, limit: number): Promise<EntityId[]>;
}

// ---------------------------------------------------------------------------
// R5 — graph
// ---------------------------------------------------------------------------

export interface GraphNode { id: EntityId; type: TypeName; fields?: Record<FieldName, Json>; markings?: MarkingId[]; }
export interface GraphEdge { from: EntityId; to: EntityId; linkType: TypeName; fields?: Record<FieldName, Json>; }

export interface TraversalSpec {
  linkTypes?: TypeName[];
  direction?: 'out' | 'in' | 'both';
  maxHops?: number;
  maxCostMs?: number;
  filter?: { field: FieldName; op: string; value: Json }[];
}

export interface Subgraph { nodes: GraphNode[]; edges: GraphEdge[]; }
export interface Path { nodes: EntityId[]; edges: GraphEdge[]; length: number; }

export interface GraphStore extends Adapter {
  upsertNode(n: GraphNode): Promise<void>;
  upsertEdge(e: GraphEdge): Promise<void>;
  neighbors(id: EntityId, spec: TraversalSpec): Promise<Subgraph>;
  shortestPath(a: EntityId, b: EntityId, spec: TraversalSpec): Promise<Path | null>;
  /** escape hatch for registered ontology Functions (ring detection, etc.) — engine-native query. */
  query(cypherOrSql: string, params?: Record<string, Json>): Promise<Subgraph>;
}

// ---------------------------------------------------------------------------
// R6 — blob-cas
// ---------------------------------------------------------------------------

export interface BlobCas extends Adapter {
  put(bytes: Uint8Array, mime: string): Promise<BlobHandle>;
  get(handle: BlobHandle): Promise<Uint8Array>;
  presignRead(handle: BlobHandle, ttlSec: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// R7 — vector
// ---------------------------------------------------------------------------

export interface ScoredId { id: string; score: number; }

export interface VectorStore extends Adapter {
  upsert(id: string, vec: Float32Array, meta: Json): Promise<void>;
  knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// R8 — timeseries-geo
// ---------------------------------------------------------------------------

export interface TrackPoint {
  entityId: EntityId;
  ts: NsTimestamp;
  lat: number;
  lon: number;
  fields?: Record<FieldName, Json>;   // speed_kn, course_deg, ...
}


export interface TimeSeriesGeo extends Adapter {
  append(point: TrackPoint): Promise<void>;
  range(entityId: EntityId, window: TimeWindow): Promise<TrackPoint[]>;
  downsample(entityId: EntityId, window: TimeWindow, bucketSec: number): Promise<TrackPoint[]>;
  within(geo: { lat: number; lon: number; radiusKm: number }, window: TimeWindow): Promise<TrackPoint[]>;
}

// ---------------------------------------------------------------------------
// R9 — analytics-olap
// ---------------------------------------------------------------------------

export interface OlapQuery {
  from: TypeName | string;            // canonical type or a federated table ref (snowflake://…)
  dimensions: FieldName[];
  measures: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: FieldName; as: string }[];
  where?: { field: FieldName; op: string; value: Json }[];
  having?: { measure: string; op: string; value: number }[];
  orderBy?: { key: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  /** When set, `from` MUST be read as a canonical type and every dimension, measure field and
   *  `where` field as a logical field of it; rows are filtered by this principal's clearances. */
  principal?: Principal;
}

export interface OlapResult { rows: Record<string, Json>[]; }

export interface AnalyticsOlap extends Adapter {
  query(q: OlapQuery): Promise<OlapResult>;
  /** zero-copy federation: register an external warehouse table as queryable in place. */
  registerExternal?(ref: string, config: Record<string, Json>): Promise<void>;
}

// ---------------------------------------------------------------------------
// R10 — registry (SSOT for schema/ontology/action/manifest defs)
// ---------------------------------------------------------------------------

export interface Registry extends Adapter {
  loadAll(): Promise<SchemaType[]>;
  get(name: TypeName, version?: string): Promise<SchemaType | null>;
  put(schema: SchemaType): Promise<void>;          // governed, versioned write
  versions(name: TypeName): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// R11 — audit-log (immutable, tamper-evident, SIEM-exportable)
// ---------------------------------------------------------------------------

export interface AuditRecord {
  ts: NsTimestamp;
  actor: string;
  action: 'read' | 'write' | 'export' | 'admin' | 'ai';
  resource: string;
  detail?: Json;
  markings?: MarkingId[];
}

export interface AuditLog extends Adapter {
  append(rec: AuditRecord): Promise<void>;           // hash-chained internally
  scan(filter: { actor?: string; resource?: string; window?: TimeWindow }): AsyncIterable<AuditRecord>;
  export(window: TimeWindow, format: 'cef' | 'leef' | 'ocsf' | 'json'): AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// R12 — lineage (provenance graph + the propagating-security substrate)
// ---------------------------------------------------------------------------

export interface LineageEdge {
  upstream: string;     // source / dataset / observation / field ref
  downstream: string;   // derived dataset / object / field ref
  /** 'marking' is a record that `markings` were applied AT `upstream` (upstream === downstream);
   *  it is never returned by upstreamOf/downstreamOf. */
  kind: 'source-observation' | 'observation-entity' | 'transform' | 'field-derivation' | 'marking';
  markings?: MarkingId[];
}

export interface Lineage extends Adapter {
  record(edge: LineageEdge): Promise<void>;
  upstreamOf(ref: string, maxHops?: number): Promise<LineageEdge[]>;
  downstreamOf(ref: string, maxHops?: number): Promise<LineageEdge[]>;
  /** THE moat: apply `markings` at `ref` (persisted) and return the downstream closure of `ref`. */
  propagateMarking(ref: string, markings: MarkingId[]): Promise<string[]>;
  /** Persist that `markings` apply at `ref`, so refs derived from it later inherit them. */
  applyMarking(ref: string, markings: MarkingId[]): Promise<void>;
  /** Markings applied at `ref` or at any ref upstream of it. */
  effectiveMarkings(ref: string): Promise<MarkingId[]>;
}

// ---------------------------------------------------------------------------
// R13 — policy-identity (authn + the PDP; adapters elsewhere are PEPs)
// ---------------------------------------------------------------------------

export interface PolicyDecision { allow: boolean; reason?: string; redactFields?: FieldName[]; }

export interface PolicyIdentity extends Adapter {
  authenticate(token: string): Promise<Principal | null>;
  authorize(principal: Principal, action: string, resource: { type: TypeName; id?: EntityId; markings?: MarkingId[] }): Promise<PolicyDecision>;
  members(group: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// R14 — work-queue
// ---------------------------------------------------------------------------

export type JobId = string;

export interface Job {
  id?: JobId;
  kind: string;
  payload: Json;
  runAfter?: NsTimestamp;
  maxAttempts?: number;
}

export interface WorkQueue extends Adapter {
  enqueue(job: Job): Promise<JobId>;
  claim(worker: string, max: number): Promise<(Job & { id: JobId })[]>;   // exactly-once / SKIP LOCKED
  complete(id: JobId, result?: Json): Promise<void>;
  fail(id: JobId, retryInSec?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Typed lookup: RoleId -> its port interface (used by the binder, spine/contracts.ts)
// ---------------------------------------------------------------------------

export interface PortByRole {
  'canonical-store': CanonicalStore;
  'hot-cache': Cache;
  'stream': Stream;
  'object-index': ObjectIndex;
  'graph': GraphStore;
  'blob-cas': BlobCas;
  'vector': VectorStore;
  'timeseries-geo': TimeSeriesGeo;
  'analytics-olap': AnalyticsOlap;
  'registry': Registry;
  'audit-log': AuditLog;
  'lineage': Lineage;
  'policy-identity': PolicyIdentity;
  'work-queue': WorkQueue;
}

// ---------------------------------------------------------------------------
// What a principal gets: only the methods classified 'governed' or 'open' in
// spine/governance.ts GOVERNANCE_RULES. Built by spine/governed.ts.
// ---------------------------------------------------------------------------

export interface GovernedPortByRole {
  'canonical-store': Pick<CanonicalStore, 'getEntity' | 'listEntities' | 'getLinks'>;
  'hot-cache': Pick<Cache, 'get' | 'set' | 'del' | 'incr' | 'publish' | 'subscribe'>;
  'stream': Pick<Stream, 'subscribe'>;
  'object-index': Pick<ObjectIndex, 'search' | 'aggregate'>;
  'graph': Pick<GraphStore, 'neighbors' | 'shortestPath'>;
  'blob-cas': Pick<BlobCas, 'get' | 'presignRead'>;
  'vector': Pick<VectorStore, 'knn'>;
  'timeseries-geo': Pick<TimeSeriesGeo, 'range' | 'downsample' | 'within'>;
  'analytics-olap': Pick<AnalyticsOlap, 'query'>;
  'registry': Pick<Registry, 'loadAll' | 'get' | 'versions'>;
  'audit-log': Pick<AuditLog, 'scan' | 'export'>;
  'lineage': Pick<Lineage, 'upstreamOf' | 'downstreamOf'>;
  'policy-identity': Pick<PolicyIdentity, 'authenticate' | 'authorize' | 'members'>;
  /** Not available to principals in this version: jobs carry no markings, so a claim could
   *  hand a restricted payload to anyone, and anyone could complete another's job. */
  'work-queue': Pick<WorkQueue, never>;
}
