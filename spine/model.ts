// spine/model.ts
// The canonical data model — the single source of truth for SHAPE.
// Every storage-role port (spine/ports.ts) speaks these types, never engine rows.
// Mirrors ARCH-canonical-data-model.md (kernel / canonical / extension) and the
// live planetar-ontology store shapes. Phase 0 of 90-ROADMAP.md: lock these so the
// 40-ADAPTERS/ sample code references real definitions instead of assumed shapes.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type EntityId = string;   // UUIDv7 (sortable, ns-rooted) — matches zmesg id
export type TypeName = string;   // namespaced, e.g. 'planetar:Vessel' | 'core:Observation' | 'crm:Account'
export type SourceId = string;   // e.g. 'src:ais.aisstream@1.0.0'
export type FieldName = string;  // 'core:field' | 'ns:field' (namespaced, governs extension)
export type MarkingId = string;  // classification/compartment label: 'UNCLASS' | 'OPS-RESTRICTED' | 'NOFORN' | 'INTERNAL'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Nanosecond epoch timestamp. bigint because 64-bit ns overflows JS number precision. */
export type NsTimestamp = bigint;

// ---------------------------------------------------------------------------
// Kernel — frozen, present on every entity/observation. 1:1 with the zmesg
// logical envelope (ARCH-canonical-data-model.md §kernel). Never extended.
// ---------------------------------------------------------------------------

export interface Kernel {
  id: EntityId;
  type: TypeName;
  /** created-at, ns. (stored_at / published_at live on the envelope, not the entity.) */
  ts: NsTimestamp;
  source: SourceId;
  /** packed SemVer of the type's schema (ns_major<<16 | minor<<8 | patch-ish); see registry. */
  schemaVersion: number;
  correlationId?: string;
  causationId?: string;
}

// ---------------------------------------------------------------------------
// Per-field provenance (off the binary hot path; lives in the canonical store).
// "highest confidence wins, recency tiebreak" — see Discrepancy for conflicts.
// ---------------------------------------------------------------------------

export interface Provenance {
  obs: EntityId;       // the Observation this field value came from
  src: SourceId;       // the Source that produced it
  conf: number;        // 0..1 confidence (NOTE: cross-source calibration is an open question)
  ts: NsTimestamp;     // when observed
}

/** Field name -> provenance of that field's current winning value. */
export type ProvenanceMap = Record<FieldName, Provenance>;

// ---------------------------------------------------------------------------
// Core base types (ARCH-canonical-data-model.md). Domain types extend these.
// ---------------------------------------------------------------------------

/** Current best-knowledge of a thing. Domain entities (planetar:Vessel, crm:Account) extend this. */
export interface CanonicalEntity extends Kernel {
  /** namespaced canonical + extension fields; 'core:*' reserved, 'ns:*' governed. */
  fields: Record<FieldName, Json>;
  /** per-field provenance for the winning values in `fields`. */
  provenance: ProvenanceMap;
  /** classification markings on this entity; defined at source + propagated along lineage (P1). */
  markings?: MarkingId[];
}

/** An immutable measurement/assertion about the world from one source at one time. */
export interface Observation extends Kernel {
  /** raw observed fields (pre-resolution). */
  fields: Record<FieldName, Json>;
  /** identifiers carried by this observation, used by resolution to fold it into an entity. */
  identifiers?: Identifier[];
  /** the canonical entity this observation resolved into, once resolved (null until P5). */
  resolvedEntityId?: EntityId | null;
  /** markings inherited from the source; the seed of lineage propagation. */
  markings?: MarkingId[];
}

/** A typed external identifier (mmsi/imo/callsign/email/orcid/…) used for resolution. */
export interface Identifier {
  scheme: string;      // 'mmsi' | 'imo' | 'callsign' | 'email' | 'orcid' | ...
  value: string;
  entityId?: EntityId; // which entity it currently points at (after resolution)
}

/** A versioned, trust-rated origin of observations. */
export interface Source {
  id: SourceId;
  name: string;
  version: string;     // SemVer; feed changes are registered bumps, never silent breaks
  trust: 'unverified' | 'verified' | 'curated' | 'institutional';
  effectiveFrom: NsTimestamp;
}

/** A typed, directed relationship between two entities (the graph edge). */
export interface Link extends Kernel {
  linkType: TypeName;  // 'planetar:same_vessel' | 'crm:works_at' | 'fincrime:transfers_to'
  from: EntityId;
  to: EntityId;
  fields?: Record<FieldName, Json>;
  provenance?: ProvenanceMap;
}

/** A first-class conflict: two sources disagree on a field. Surfaces in the UI; not silently dropped. */
export interface Discrepancy extends Kernel {
  entityId: EntityId;
  field: FieldName;
  values: { value: Json; prov: Provenance }[];
  resolution?: 'auto-highest-conf' | 'manual' | 'unresolved';
}

/** An audited fact that something happened — emitted by Action Types (P7) and ingest (P2). */
export interface Event extends Kernel {
  eventType: TypeName;   // 'planetar:ConfirmDarkVessel' | 'crm:LeadConverted' | ...
  subject: EntityId;     // the entity acted upon
  actor: string;         // principal id (user / service / agent)
  payload?: Record<FieldName, Json>;
}

/** A registered schema definition (registry R10 stores these as entities). */
export interface SchemaType extends Kernel {
  name: TypeName;
  extends?: TypeName;            // 'core:CanonicalEntity' | 'core:Observation'
  semver: string;
  jsonSchema: Json;             // the validating schema (patternProperties + additionalProperties:false)
  fieldIds?: Record<FieldName, number>;  // type-scoped numeric field-ids for the binary hot path
}

// ---------------------------------------------------------------------------
// Query + transaction primitives (shared by ports)
// ---------------------------------------------------------------------------

export type FilterOp = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains' | 'exists';

export interface FieldFilter {
  field: FieldName;
  op: FilterOp;
  value: Json;
}

export interface EntityQuery {
  filter?: FieldFilter[];
  orderBy?: { field: FieldName; dir: 'asc' | 'desc' }[];
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  cursor?: string;   // opaque continuation token; absent when exhausted
  total?: number;    // optional; not all engines compute it cheaply
}

/** Opaque transaction handle. Adapters return their own concrete Tx; callers only pass it back. */
export interface Tx {
  readonly id: string;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
  p99Ms?: number;     // last-measured p99 for the role's primary access pattern
}

/** A closed time interval in ns (shared by audit-log, timeseries-geo, lineage). */
export interface TimeWindow {
  fromNs: NsTimestamp;
  toNs: NsTimestamp;
}

/** A content-addressed blob reference. Bytes never travel the bus — only this handle does. */
export interface BlobHandle {
  sha256: string;
  size: number;
  mime: string;
}
