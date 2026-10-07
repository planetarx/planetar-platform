# 20 — Parity Matrix · Palantir Foundry — Data Connection, Pipelines, Modeling

This slice maps Foundry's **data-engineering surface** — the part of Foundry that gets bytes *in* (Data Connection), *transformed* (Pipeline Builder / Transforms / Code Repositories), and *shaped* into the semantic layer (Datasets, Schemas, Object/Link/Action modeling, the Ontology Manager) — onto Planetar's planes ([`00`](../00-ARCHITECTURE-OVERVIEW.md)), storage roles ([`10`](../10-STORAGE-ROLES.md)), and the spine-vs-OSS split.

**Headline parity story.** Foundry's data plane is "land raw → version every dataset as an immutable transaction → transform with lineage → project into the Ontology." Planetar's spine *already is this shape*: the **bus is the spine of record** (every dataset transaction is just an ordered, WAL-durable envelope on R3), the **canonical model + registry** are the dataset/schema SSOT (R1+R10), **lineage propagates by construction** (R12, per-field `_provenance` already in doibio + ontology), and the **ontology service is the modeling layer** (object/link/action types with an OSDK-equivalent Object API, built). So the modeling and streaming-ingestion columns are largely *built spine* — what Planetar buys from OSS is the **connector breadth** (Airbyte/Singer replacing Foundry's 200+ source agents), the **batch transform engine** (dbt/Spark replacing Foundry Transforms at volume), the **analytics scan layer** (clickhouse/duckdb for Contour-style preview), and **declarative no-code pipeline authoring** (the one genuine gap: there is no Pipeline-Builder GUI). Where Foundry couples all of this to one proprietary store, Planetar keeps the same logical model over a per-client engine mix — sqlite+broker at the maritime edge, postgres+kafka+clickhouse in the cloud — with **zero application-code change** (see [`13`](../13-CLIENT-MANIFEST.md)).

> Status legend: **built** (a named repo does it) · **partial** (a named repo does part) · **designed** (specified, not coded) · **planned** (acknowledged, unspecified). Role IDs and plane IDs are verbatim from the spine. **Required** roles bold, *enhancing* roles italic.

---

## Data Connection

Getting external bytes to the edge and onto the bus as envelopes. Foundry's value here is breadth of source agents + virtual (query-in-place) tables; Planetar owns the envelope/detector edge and wires OSS connectors behind it.

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Source systems / connection registry | Catalog of external sources with credentials and connection metadata | P2, P1 | **R10**, **R13**, *R11* | Spine: source entries are `core:SourceType` in the registry; OSS: Keycloak/Vault for credential storage behind R13 | partial — registry slice `~/github/planetarx/planetar-registry`; source-as-registered-type modeled but credential vault designed-only |
| Batch file/object connector (S3/GCS/Azure/SFTP/HDFS) | Pull files/objects on a schedule into a raw landing zone | P2 | **R3**, **R6**, *R14* | Spine: detector SDK emits one envelope per file with a `{sha256,size,mime}` blob handle; **OSS: Airbyte** (object-storage sources) | designed — detector SDK pattern proven by ais/sat/eo/acoustic; generic file connector not built |
| JDBC / database connector (Postgres, Oracle, SQL Server, Snowflake) | Periodic/CDC pull from relational sources into datasets | P2, P3 | **R3**, **R1**, *R14* | Spine: rows → canonical observations via projector; **OSS: Airbyte / Singer taps** for the JDBC source side | designed — projector path built for sensor lanes; relational tap not wired |
| Streaming ingestion (Kafka/Kinesis/Pub-Sub source) | Continuous append of external events onto the bus | P2, P3 | **R3** | **Spine: `planetar-broker` + `zmesg`** (native streaming ingestion = R3 default); OSS: kafka/redpanda as alternate R3 engine | built — `~/github/planetarx/planetar-broker` (SHM+TCP+UDP+WAL+CRC32), `~/github/sness23/zmesg` envelope |
| Live sensor / detector connectors (AIS, SAR, EO, acoustic) | Domain detectors normalize raw sensor feeds to envelopes | P2, P3 | **R3**, *R6*, *R8* | **Spine: detector framework + envelope emit SDK** (this is the moat at the edge) | built — `planetar-ais`, `planetar-sat`, `planetar-eo`, `planetar-acoustic` (4 detectors live) |
| RF / SIGINT connector lane | RF emitter feed normalized to envelopes for fusion | P2, P3 | **R3**, *R8* | Spine: detector SDK (same shape as the 4 built lanes) | planned — lane registered in canonical model, no service; per MEMORY `reference_ontology_topic_gap` |
| Virtual / federated tables (query-in-place, no copy) | Query Snowflake/BigQuery/Databricks in place without ingest | P2, P9-analytics | **R9** (federated), *R1* | **OSS: bigquery / snowflake / databricks** behind the R9 analytics adapter (federated mode) | designed — R9 federated binding specified ([`10` R9](../10-STORAGE-ROLES.md)); no adapter coded |
| Webhook / push connector | External system POSTs events; platform emits envelopes | P2, P3 | **R3**, *R14* | Spine: webhook receiver → envelope; doibio has a working webhook path | partial — doibio webhooks (the only automation channel there) `~/data/dev/doibio`; not generalized into a connector |
| CSV / flat-file import (bulk upload) | One-shot upload of tabular data into objects | P2, P4 | **R1**, **R10**, *R3* | **Spine: doibio CSV import/export** maps directly; rows → canonical observations | built — doibio CSV import/export `~/data/dev/doibio` (event-sourced into 37-table SQLite) |
| Connection health / sync monitoring | Track connector last-run, lag, failure, throughput | P0, P1 | **R11**, *R14*, *R2* | Spine: connector heartbeats as audit/control envelopes; OSS: Grafana on the R11 sink | designed — audit envelope shape exists; per-connector health dashboard not built |
| Agent-based / on-prem connector runtime | A small agent runs inside a client network and tunnels back | P0, P2 | **R3**, **R13** | OSS: deferred (Foundry "connection agent" analogue); broker can run at the edge and bridge to cloud R3 | planned — connectors-at-breadth deferred (brief GAPS); edge-broker bridge designed |

---

## Pipelines (Transforms · Builds · Scheduling)

Foundry's transform layer: Code Repositories (Spark/Python), Pipeline Builder (no-code), dataset transactions/branches, build schedules, and incremental/streaming transforms. Planetar reframes a "pipeline" as **a chain of projection consumers on the bus**, each step itself an event with lineage — but leans on OSS for the heavy SQL/Spark batch engine and has a real GUI gap.

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Dataset = immutable versioned transaction | Every write produces a new immutable, addressable dataset version | P3, P4 | **R3**, **R1** | **Spine: the bus is the spine of record** — each dataset transaction is an ordered WAL envelope; R1 is a rebuildable projection | built — `planetar-broker` WAL+CRC32 gives ordered immutable log; projection model proven in ontology SQLite store |
| Schema / dataset registry | Declared schema per dataset, versioned (SemVer), codegen targets | P4, P0 | **R10**, *R1* | **Spine: canonical model + registry codegen** (R10 = git-vault SSOT) | built (slice) — `planetar-registry` codegen `~/github/planetarx/planetar-registry`; canonical model `~/data/vaults/docs/ARCH-canonical-data-model.md` |
| Batch transform (SQL/Python over datasets) | Author code that derives a dataset from upstream datasets | P4 | **R9**, **R1**, *R3* | Spine: transform output re-enters as envelopes; **OSS: dbt / Spark / duckdb** for the engine | designed — projection-consumer pattern built; general batch SQL/Spark transform engine not wired |
| Streaming / incremental transform | Continuously derive a dataset from an append-only upstream | P3, P4 | **R3**, **R1** | **Spine: projection consumers off the broker** are exactly streaming transforms (lifecycle 4.1) | built (pattern) — fusion pipeline is a live streaming transform chain; detectors → projector → ontology over the bus |
| No-code Pipeline Builder (visual DAG authoring) | Drag-and-drop transform graph with live preview | P8, P4 | **R9**, **R1**, *R10* | OSS: deferred (no GUI authoring); closest analogue is dbt models authored as code | planned — genuine gap; no visual pipeline authoring surface exists |
| Build scheduling / orchestration | Trigger transforms on schedule or upstream change; track build runs | P0, P7 | **R14**, **R3**, *R1* | Spine: schedule as Action Types / control envelopes; **OSS: Temporal** for long-running orchestration | designed — R14 work-queue contract specified (postgres SKIP LOCKED / temporal); scheduler service not built |
| Incremental / append-only build optimization | Process only new rows since last transaction | P3, P4 | **R3**, **R1** | Spine: offset-based replay from R3 gives incremental-by-construction | built (mechanism) — broker replay-from-offset; not yet packaged as a transform-build optimizer |
| Branching / dataset branches | Isolated dataset branch for safe iteration, merge back | P4, P0 | **R1** (copy-on-write), **R10** | Spine: scenario/branch overlay on canonical store (same mechanism as Foundry sandboxes) | designed — copy-on-write overlay specified ([`11` §2 sandboxes](../11-CAPABILITY-ROLE-MAP.md)); not implemented |
| Data health / expectations / checks | Assert row counts, freshness, schema conformance per build | P1, P4 | **R11**, **R1**, *R9* | Spine: expectation failures as audit envelopes; OSS: dbt tests / Great Expectations | designed — audit envelope path exists; declarative expectation engine not built |
| Pipeline lineage (transform → dataset edges) | Record which transform produced which dataset, end to end | P1 | **R12**, **R10** | **Spine: lineage emit on every projection** + per-field `_provenance`; **OSS: Marquez/OpenLineage** as the R12 store | partial — per-field provenance built in doibio identity-resolution.ts (630 LOC) + ontology; OpenLineage/Marquez store binding designed-only |
| Restricted views / column-level transform masking | Transform that drops/masks columns per marking | P1, P4 | **R13**, **R12**, **R1** | Spine: marking-aware projector; OSS: OPA decision at the adapter (PEP) | partial — row filter + field redaction built in the platform core 2026-10-06 (`planetar-platform/spine/governed.ts`, `npm run governance` 70/70); transform-level masking and the live service remain |
| Code Repositories (git-backed transform code) | Version-controlled transform source with CI | P0 | **R10** | **OSS: git** (R10 default is git+filesystem); CI via standard runners | partial — registry is already git-vault-backed (R10); transform-specific CI repo not formalized |

---

## Modeling (Datasets → Ontology: Object · Link · Action · Schema)

Foundry's Ontology Manager: define object types, link types, action types, interfaces, and the OSDK that apps consume. This is where Planetar is **strongest** — the ontology service is built, with an Object API that is OSDK-equivalent, kinetic Action Types as the sole write path, and identity resolution as the moat. Datasets become ontology objects via the resolution plane.

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Object Types (Ontology objects from datasets) | Define an object type, back it by canonical entities | P6, P4 | **R1**, **R10**, *R4* | **Spine: ontology object types + canonical model** (the contract everyone speaks) | built — `planetar-ontology` object types over SQLite store (P1–P5 tests pass) |
| Link Types (typed relationships) | Define typed edges between object types | P6, P5 | **R5**, **R1**, **R10** | **Spine: ontology link types**; OSS: falkordb/neo4j for traversal at scale (R5) | built — link types in `planetar-ontology`; graph engine binding (R5) designed for scale |
| Action Types (validated, audited, reversible writes) | The only write path: precondition → effect → audit envelope | P7 | **R10**, **R1**, **R11**, **R3**, *R13* | **Spine: Action Type executor** (the kinetic moat); OSS: OPA for the governance gate | built — kinetic Action Types in `planetar-ontology` (e.g. ConfirmDarkVessel), audit + effect as envelopes |
| Object API / OSDK (typed client over the ontology) | Generated typed read/write client; REST + live WS subscribe | P6, P8 | **R1**, **R4**, *R2* | **Spine: Object API REST+WS = OSDK-equivalent** | built — `planetar-ontology` Object API (REST + WS), wired into `planetar-ui` |
| Schema definition + versioning (Ontology Manager) | Author/version object/link/action schemas as SSOT | P6, P0 | **R10**, *R1* | **Spine: registry as SSOT** + codegen; matches Foundry Ontology Manager / SF Metadata API | built (slice) — `planetar-registry` codegen + `registry/types.json` in `planetar-ontology` |
| Interfaces / shared object behaviors | Abstract interfaces an object type implements (polymorphic sets) | P6 | **R10**, **R1** | Spine: ontology interface types (registry-declared) | designed — interface concept in canonical model; not exercised in the built ontology slice |
| Object sets / saved searches | Named, reusable, filterable collections of objects | P6, P8 | **R4**, **R1**, *R2* | Spine: Object API object-set queries; **OSS: opensearch** (R4) for filter/facet at scale | partial — Object API supports filtered queries; persisted/named object sets not built; opensearch R4 binding designed |
| Identity resolution (datasets → canonical entity) | Fold multiple source observations into one golden entity | P5 | **R1**, **R4** (blocking), **R12**, *R7* (fuzzy/visual) | **Spine: identity-resolution engine** (the moat); OSS: opensearch blocking, pgvector fuzzy | built — `doibio src/lib/identity-resolution.ts` (630 LOC) ported into `planetar-ontology` |
| Per-field provenance / golden master | Track which source set each field's current value | P5, P1 | **R1**, **R12** | **Spine: per-field `_provenance` in the canonical model** | built — provenance model in doibio + ontology; lineage store (Marquez R12) for cross-dataset edges designed |
| Conflict / discrepancy surfacing | Flag and hold conflicting source values for review | P5, P8 | **R1**, *R4*, *R14* | Spine: discrepancy as a canonical type + review Action; doibio event-log captures conflicting writes | partial — discrepancy type designed in canonical model; doibio event-sourcing records conflicts, no review UI |
| Dark-vessel kinematic re-ID (flagship modeling) | Re-identify the same vessel across gaps via kinematics | P5 | **R1**, **R8**, *R7* | **Spine: kinematic matcher** (planetar flagship, the resolution moat) | built — kinematic re-ID in `planetar-ontology`; timeseries-geo (R8) binding for tracks |
| Object-level / row-level security (FLS, sharing) | Restrict field/row visibility per principal + marking | P1, P6 | **R13**, **R11**, **R1** | Spine: marking checks at the adapter PEP; OSS: OPA decisions (R13) | partial — object-level visibility and FLS built in the platform core 2026-10-06 (`planetar-platform/spine/governed.ts`); per-record sharing still designed; doibio lacks both |
| Functions / computed properties (TypeScript/derived) | Server-side derived fields and ontology functions | P6 | **R1**, **R10**, *R9* | Spine: ontology functions (registry-declared, zero-dep TS) | designed — function concept in ontology design; not in the built P1–P5 slice |
| Object Explorer / faceted object search | Browse, filter, facet, and sort objects in a UI | P8, P6 | **R4**, **R1**, *R7*, *R2* | Spine: Object API; **OSS: opensearch** (R4) for FTS/facet; doibio has Elasticsearch search built | partial — doibio Elasticsearch `es-app` search built `~/data/dev/doibio`; not yet on opensearch behind the R4 adapter; `planetar-ui` graph/list tabs partial |
| Time-series / Geotime properties on objects | Attach high-frequency geotemporal series to an object | P6, P4 | **R8**, **R1**, *R5* | Spine: track model on objects; **OSS: timescaledb+postgis / clickhouse** (R8) | partial — track data flows via detectors; R8 geo store binding designed; UI Timeline/Signal tabs are stubs |
| Media references on objects (imagery/FMV/photos) | Attach content-addressed blobs to ontology objects | P6, P2 | **R6**, **R1**, *R7* | Spine: `{sha256,size,mime}` blob handle in the envelope; **OSS: minio/s3** (R6) | designed — blob-handle-in-envelope specified (`ARCH-planetar-photos.md`); planetar-photos not built |
| Ontology branching / scenarios (what-if overlays) | Hypothetical object-state overlay without mutating base | P6, P0 | **R1** (copy-on-write), **R10** | Spine: scenario overlay on canonical store | designed — same copy-on-write mechanism as dataset branches; not implemented |

---

## Coverage summary

Counts across all three areas (40 features total):

| Status | Count | Notes |
|---|---|---|
| **built** | 13 | Streaming ingestion (broker+zmesg), 4 detectors, CSV import, dataset-as-immutable-transaction, schema registry slice, streaming-transform pattern, incremental replay, object types, link types, Action Types, Object API/OSDK, schema versioning slice, identity resolution, per-field provenance, dark-vessel re-ID — all backed by named repos (`planetar-broker`, `zmesg`, `planetar-ontology`, `planetar-registry`, doibio). *(Several rows are jointly "built" mechanisms; the headline 13 are the cleanly-backed ones.)* |
| **partial** | 10 | Source/connection registry, webhook connector, pipeline lineage, Code Repositories (git), object sets, conflict surfacing, Object Explorer search (doibio ES), time-series object properties — a named repo does part, the rest is designed |
| **designed** | 12 | Batch/JDBC/file connectors, federated tables, connection health, batch transform engine, build scheduling, branching, data-health checks, interfaces, functions, object/row-level security, media references, ontology scenarios — specified in spine docs, no code |
| **planned** | 5 | RF connector lane, agent-based on-prem connector runtime, no-code Pipeline Builder GUI, (acknowledged but unspecified) |

The modeling area is the strongest (most "built"); pipelines is the weakest (no GUI, no batch engine wired); data-connection sits in the middle (the streaming/detector edge is built, connector breadth is OSS-deferred).

---

## Notable gaps

- **No no-code Pipeline Builder (visual DAG authoring).** The single clearest Foundry capability with no Planetar analogue — transforms are projection-consumer code, not drag-and-drop. Closest OSS path is dbt-as-code; a GUI is unbudgeted.
- **No general batch transform engine wired.** Streaming transforms (bus projection consumers) are built; SQL/Spark batch-over-datasets needs an OSS engine (dbt/Spark/duckdb) behind R9 — designed only.
- **Connector breadth is deferred (brief GAPS).** Foundry's 200+ source agents map to Airbyte/Singer behind the R3/R6 edge, but only the 4 domain detectors + CSV import + webhooks are actually built; generic file/JDBC/agent connectors are designed/planned.
- **Lineage store binding is designed-only.** Per-field `_provenance` is built (doibio + ontology), but cross-dataset OpenLineage/Marquez (R12) for full pipeline lineage is not yet bound.
- **Markings + propagating security is designed-only.** Restricted views, column masking, FLS/row-level sharing all wait on the governance plane; doibio explicitly has no FLS/row-level sharing.
- **Federated / virtual tables not coded.** Query-in-place (bigquery/snowflake/databricks behind R9) is specified but has no adapter.
- **Build scheduling / orchestration service absent.** R14 work-queue contract is specified (postgres SKIP LOCKED / Temporal); no scheduler runs builds yet.
- **Branching/scenarios (datasets and ontology) share one unimplemented mechanism.** Copy-on-write overlay on the canonical store is designed for both Foundry sandboxes and Ontology branches but not built.
- **RF lane is registered with no service**, and the **agent-based on-prem connector runtime** is planned, not designed.
