# 20 — Parity Matrix · Palantir Gotham

This slice maps **Palantir Gotham** — the operational intelligence / link-analysis product — onto the Planetar plane model ([`00`](../00-ARCHITECTURE-OVERVIEW.md)), the 14 storage roles ([`10`](../10-STORAGE-ROLES.md)), and the spine-vs-OSS split. Gotham is the closest of the three Palantir surfaces to what the spine **already runs in production**: its core loop is *ingest heterogeneous observations → resolve them into entities → traverse a typed entity/link graph → act through audited writes → surface on a geotemporal/graph workbench.* That loop is exactly planetar's built path — `planetar-broker` (R3) → resolution (P5) → `planetar-ontology` link types + Object API (P6) → kinetic Action Types (P7) → `planetar-ui` (P8). So Gotham parity is **mostly spine + a graph engine (R5) and a geotemporal engine (R8)** rather than new OSS sprawl.

**Headline parity story:** the entity-resolution + link-graph + kinetic-write spine that Gotham charges for is the *built moat* (`planetar-ontology`, `doibio/src/lib/identity-resolution.ts`, the kinematic dark-vessel re-ID matcher). What is *partial/designed* clusters in two places: (1) the **analyst workbench surfaces** (Histogram/Object Explorer/Map are partial in `planetar-ui`; Histogram/Graph polish, FMV exploitation are stubs), and (2) **propagating markings security** (P1) — the lineage substrate (R12) is built, but marking *propagation* across derived stores is designed-only. Everything else decomposes into `{R1,R10}` + a specialty role with a named OSS engine already in the role catalog.

Role legend: **R1** canonical-store · **R2** hot-cache · **R3** stream · **R4** object-index · **R5** graph · **R6** blob-cas · **R7** vector · **R8** timeseries-geo · **R9** analytics-olap · **R10** registry · **R11** audit-log · **R12** lineage · **R13** policy-identity · **R14** work-queue. **Bold = required**, *italic = enhancing*.

---

## Ingest & data integration

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Data sources / connectors | Pull structured + unstructured feeds (databases, files, APIs, message buses) into the platform | P2, P3 | **R3**, **R10**, *R6* | spine: detector SDK + `zmesg` emit; **OSS: Airbyte / Singer taps** for the long tail of enterprise sources | partial — 4 native detectors built (`planetar-ais`/`-sat`/`-eo`/`-acoustic`); generic Airbyte connectors deferred (`README.md` GAPS) |
| Streaming ingestion | Continuous append of live observations as ordered, durable events | P2, P3 | **R3** | **spine** — `planetar-broker` SHM/TCP/UDP + WAL, envelope = `zmesg` | built — `~/github/planetarx/planetar-broker` |
| Schema-on-ingest / typed parsing | Normalize raw rows into typed canonical observations against registered schemas | P2, P4, P6 | **R10**, **R1**, *R4* | spine: canonical model + `planetar-registry` codegen → typed Observation | partial — registry codegen vertical slice (`~/github/planetarx/planetar-registry`); detectors emit typed envelopes |
| Raw/unstructured landing | Stage raw bytes (documents, images, feeds) before exploitation | P2, P6 | **R6**, **R1** | spine: blob handle `{sha256,size,mime}` in envelope; **OSS: minio/s3** (filesystem at edge) | designed — `ARCH-planetar-photos.md` handle model; minio binding planned |
| Bulk / batch import (CSV, files) | Operator-driven load of tabular data into objects | P2, P4 | **R1**, **R10**, *R14* | spine: import → kinetic projector; **doibio CSV import/export** is the donor | built — doibio CSV import/export (`~/data/dev/doibio`) |
| Geo/temporal data prep | Land and index time-stamped, geolocated tracks for Geotime-style query | P2, P8 | **R8**, **R1** | spine: track/observation model; **OSS: timescaledb + postgis** | partial — AIS/SAR/EO tracks land via detectors; postgis binding designed in maritime manifest |

## Entity resolution & the canonical entity model

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Object / entity model (typed objects) | Define entity types (Person, Vessel, Org, Event) as first-class typed objects | P4, P6 | **R1**, **R10**, *R4* | **spine** — `planetar-ontology` object types + canonical data model; doibio's 35 JSON-schema objects prove breadth | built — `planetar-ontology` object types; `~/data/dev/doibio` 35 schemas |
| Link / relationship model | Typed edges between entities (owns, located-at, communicates-with) | P6 | **R5**, **R1** | **spine** — `planetar-ontology` link types; OSS graph engine for traversal (falkordb) | built — `planetar-ontology` link types (canonical store); falkordb binding for scale |
| Entity resolution / dedup | Fold many raw observations describing one real-world thing into one golden entity | P5 | **R1**, **R4** (blocking), **R12**, *R7* | **spine — the moat** — `planetar-ontology/src/resolve/resolve.ts`; donor `doibio/src/lib/identity-resolution.ts` (631 LOC) | built — `~/github/planetarx/planetar-ontology` resolve; doibio identity-resolution.ts |
| Per-field provenance / golden master | Track which source asserted each field value; resolve conflicts to current-best | P5, P1 | **R1**, **R12**, **R11** | **spine** — ontology per-field provenance + canonical `_provenance`; OSS: marquez for lineage store | built — `planetar-ontology` per-field provenance; lineage store via marquez planned |
| Conflict / discrepancy surfacing | Flag and display disagreeing observations for analyst adjudication | P5, P8 | **R1**, *R4* | spine: discrepancy type in canonical model + ontology; surfaced via Object API | partial — discrepancy type built in ontology; analyst adjudication UI designed |
| Kinematic / fuzzy re-identification | Re-link a track to a known entity by motion/behavior when IDs are absent (dark vessel) | P5 | **R1**, **R8**, *R7* | **spine** — kinematic matcher `planetar-ontology/src/resolve/kinematics.ts` (the flagship) | built — `~/github/planetarx/planetar-ontology` kinematics; R7 visual re-ID enhancing (pgvector) |

## Graph / link analysis (the Gotham core)

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Graph / link explorer (Graph app) | Interactive node-link canvas: expand neighbors, lay out, filter a subgraph | P6, P8 | **R5**, **R1**, *R4* | spine: ontology link types feed a graph projection; **OSS: falkordb** (neo4j alt); UI is `planetar-ui` graph tab | partial — graph projection + Object API built; `planetar-ui` ontology graph tab built/partial |
| Neighborhood / "search around" expansion | k-hop expansion from a seed entity to find connected entities | P6 | **R5**, **R1** | spine: traversal over ontology links; **OSS: falkordb** `neighbors()` per `GraphStore` port | partial — link traversal built in ontology canonical store; dedicated R5 graph engine binding designed |
| Path / shortest-path finding | Find connection paths between two entities (who-knows-who) | P6 | **R5**, **R1** | **OSS: falkordb / neo4j** behind `GraphStore.shortestPath()` ([`12 §3`](../12-ADAPTER-CONTRACT.md)); spine: link types | designed — port defined; engine binding planned |
| Pattern / template matching | Match recurring relationship motifs (ring, broker-of-record, shell-company) | P6 | **R5**, **R1**, *R9* | **OSS: falkordb** subgraph pattern (Cypher-ish); spine: ontology types | designed — graph engine pattern queries; not yet bound |
| Histogram / facet drill-down | Quantitative breakdown of an object set by field, drill into outliers | P8 | **R4**, **R9**, **R1** | **OSS: opensearch** facet/aggregate + clickhouse for big rollups; spine: Object API object sets | partial — Object API object sets built; UI histogram lane is a stub (`planetar-ui`) |
| Object set / cohort operations | Build, save, intersect, and act on named sets of objects | P6 | **R4**, **R1**, **R10** | **spine** — ontology object sets via Object API; OSS: opensearch for the filter/set math | built — `planetar-ontology` Object API object sets (`src/api/server.ts`) |

## Geotemporal analysis (Geotime / Gaia / Map)

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Map / geospatial view (Gaia) | Plot entities and tracks on a map; pan/zoom/select geographically | P8 | **R8**, **R1**, *R5* | spine: track model; **OSS: postgis + maplibre** (UI map) | partial — `planetar-ui` maplibre map built; postgis geo-query binding designed |
| Geotemporal playback (Geotime) | Scrub time to replay how tracks/entities moved over a window | P8 | **R8**, **R1** | spine: ns-timestamped envelopes give native temporal order; **OSS: timescaledb + postgis** | partial — `planetar-ui` Timeline tab is a stub; envelope timestamps + R8 contract ready |
| Geofence / area-of-interest alerts | Trigger when an entity enters/leaves a region; raise as an event | P7, P2 | **R8**, **R3**, **R14**, *R13* | spine: geofence as a kinetic Action trigger → envelope on the bus; OSS: postgis geo-within | designed — Action Type + R8 geo query specified; not wired |
| Track / pattern-of-life analysis | Summarize an entity's recurring movement patterns over time | P8 | **R8**, **R1**, *R9* | spine: track model; **OSS: timescaledb continuous aggregates** / clickhouse | designed — detectors emit tracks; pattern-of-life rollups planned |
| Distance / proximity / co-location | Find entities near each other in space-time (rendezvous detection) | P5, P8 | **R8**, **R1**, *R5* | spine: kinematic co-location feeds re-ID; **OSS: postgis** geo-near | partial — kinematic proximity used by dark-vessel matcher; standalone query designed |

## Search & discovery

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Search 360 / global search | Full-text + structured search across all object types in one box | P6, P8 | **R4**, **R1**, *R7* | **OSS: opensearch** (sqlite-FTS at edge); spine: Object API search; **doibio Elasticsearch** is a working donor | partial — doibio Elasticsearch search built (`~/data/dev/doibio`); opensearch binding planned for platform |
| Filtered / faceted object search | Narrow an object set by typed-field predicates and facets | P6, P8 | **R4**, **R1** | spine: Object API filter; **OSS: opensearch** facets | built — `planetar-ontology` Object API filter/list (`src/api/server.ts`) |
| Semantic / similarity search | Find objects by meaning or visual/acoustic similarity, not keywords | P6 | **R7**, **R1**, *R4* | **OSS: pgvector** (qdrant alt) behind `VectorStore` port; spine: embedding emit | designed — R7 port defined; vessel visual re-ID embeddings planned |
| Saved searches / watchlists | Persist a query as a standing alert that fires on new matching data | P7, P6 | **R10**, **R3**, **R14**, **R1** | spine: watchlist = saved object set + Action trigger on the bus; OSS: postgres work-queue | designed — object sets built; standing-alert trigger planned |

## Workspaces, cases & dossiers

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Dossier / object report | Auto-assemble a report on an entity from its links, observations, and media | P8, P6 | **R1**, **R5**, *R6*, *R9* | spine: ontology read aggregation; **doibio** report routes are the donor; OSS: clickhouse for stats | partial — doibio canned-SQL reports built (`~/data/dev/doibio`); declarative report builder is a known gap |
| Investigation / case workspace | A persistent container collecting entities, notes, and findings for a case | P6, P8 | **R1**, **R10**, **R14**, *R5* | spine: Case as a registered object type + Action Types; doibio object model donor | designed — modeled as ontology objects; case workspace UI planned |
| Notes / annotations | Free-text and structured annotations attached to entities, audited | P7, P6 | **R1**, **R11**, *R6* | spine: annotation via kinetic Action Type (audited write); OSS: blob for attachments | designed — Action Type executor built; annotation type planned |
| Briefing / export package | Bundle a case into a shareable, marking-aware export artifact | P8, P1 | **R1**, **R11**, **R13**, *R6* | spine: export as an audited Action gated by markings; OSS: minio for the package | designed — export gating depends on propagating-security (designed-only) |
| Collaboration / shared workspace | Multiple analysts work the same case concurrently with live updates | P8, P3 | **R3**, **R2**, **R1** | spine: Object API WS live push over the bus; **OSS: redis** presence | partial — Object API WS live updates built (`planetar-ontology/src/api/ws.ts`); presence pins designed |

## Imagery, media & FMV exploitation

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Media sets / imagery store | Store and serve large imagery/document sets content-addressed | P2, P6, P8 | **R6**, **R1**, *R7* | spine: blob handle in envelope; **OSS: minio/s3** behind `BlobCas` port | designed — handle model in `ARCH-planetar-photos.md`; minio binding planned |
| Imagery detection / chips | Run detectors over imagery, emit detection chips as observations | P2, P6 | **R6**, **R1**, **R3**, *R7* | **spine** — `planetar-sat` CFAR SAR chips + `planetar-eo` YOLO already emit detection envelopes | built — `~/github/planetarx/planetar-sat`, `planetar-eo` detectors |
| FMV (full-motion video) exploitation | Track and tag entities across video frames | P2, P6, P8 | **R6**, **R8**, **R3**, *R7* | spine: per-frame detection → track; OSS: minio (range-get video) + a tracker | planned — no FMV service; EO detector is the closest donor pattern |
| Visual re-identification | Match the same vessel/object across EO/SAR/photo by embedding cosine | P5 | **R7**, **R6**, **R1** | **OSS: pgvector** behind `VectorStore`; spine: re-ID fusion into resolution | designed — kinematic re-ID built; visual (R7) path designed (`MEMORY` planetar-eo/acoustic) |
| Audio / acoustic exploitation | Classify hydrophone signatures into typed acoustic detections | P2, P6 | **R6**, **R3**, **R1**, *R7* | **spine** — `planetar-acoustic` Lyons-SAI → CV classifier → bus | built — `~/github/planetarx/planetar-acoustic` |

## Kinetic actions & workflow (the write path)

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Actions / writebacks (the only write path) | Validated, audited, reversible mutations to entities via registered Action Types | P7 | **R10**, **R1**, **R11**, **R3**, *R13* | **spine — the moat** — `planetar-ontology/src/actions/executor.ts` precondition→effect→audit | built — `~/github/planetarx/planetar-ontology` action executor |
| Alerts / triggers on data change | Fire an Action when incoming data matches a condition (geofence, watchlist hit) | P7, P3 | **R3**, **R14**, **R1**, *R13* | spine: detector/event → Action trigger on the bus; OSS: postgres/redis work-queue | designed — bus + executor built; declarative trigger rules planned |
| Tasking / assignment queues | Route flagged items to analyst queues; claim, work, complete | P7, P8 | **R14**, **R2**, **R1** | **OSS: postgres (SKIP LOCKED)** behind `WorkQueue` port (redis/temporal alts); spine: routing as Actions | designed — `WorkQueue` port defined ([`12 §3`](../12-ADAPTER-CONTRACT.md)); no routing service yet |
| Long-running orchestration | Multi-step, durable workflows (enrichment pipelines, multi-stage approvals) | P7 | **R14**, **R1**, **R3** | **OSS: Temporal** behind `WorkQueue` port for durable orchestration; spine: Action chaining | planned — Temporal binding deferred; no declarative flow engine (doibio gap) |
| Reversibility / undo of actions | Roll back an applied effect via its recorded inverse | P7, P1 | **R11**, **R1**, **R3** | **spine** — every effect is an envelope; inverse re-projects (lifecycle 4.2, [`00 §4`](../00-ARCHITECTURE-OVERVIEW.md)) | partial — audit envelope + re-projection built; automatic inverse generation designed |
| AI agent containment (AIP-adjacent) | Let AI agents act only through the same audited Action Types as humans | P7, P8 | **R10**, **R11**, **R7**, **R1**, *R13* | **spine** — kinetic containment is the agent guardrail; OSS: vector (RAG) + LLM gateway | designed — kinetic containment model specified; agent studio is a GAP (`README.md`) |

## Governance, security & audit

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Markings / classifications | Tag data with security markings (UNCLASS/RESTRICTED/handling caveats) | P1 | **R13**, **R10** | spine: marking model in registry; **OSS: OPA** for the decision | partial — built in the platform core 2026-10-06 (see `palantir-foundry-governance.md`, Markings); not in the live service |
| Propagating security | A marking applied at ingest flows along lineage to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **spine** — propagation rules over lineage; **OSS: marquez** (R12) + **OPA** (R13) | partial — built in the platform core 2026-10-06: lineage-persisted markings inherited by existing and later derivations (`planetar-platform/spine/system.ts`); not in the live service |
| Purpose-based / need-to-know access | Gate access by declared purpose, not just role (PBAC) | P1, P7 | **R13**, **R11** | **OSS: OPA** policy bundle behind `policy-identity`; spine: adapters are the PEP | designed — OPA gate specified in adapter context (`MarkingResolver`); not enforced yet |
| Comprehensive audit log | Immutable record of every read/write/export/admin/AI action | P1 | **R11** | spine: audit envelope on the bus; **doibio immutable event-log** is the built donor; OSS: clickhouse sink | built — doibio immutable event-log audit (`~/data/dev/doibio`); ontology emits audit envelopes |
| Data lineage (Monocle-equivalent) | Trace any value back to its source through every transform | P1 | **R12**, **R10** | spine: lineage emit; **OSS: marquez (OpenLineage)** behind the R12 port | partial — per-field provenance built in ontology; full marquez lineage store planned |
| Identity / SSO / principals | Authenticate users, service accounts, and AI agents; manage roles/groups | P0, P1 | **R13** | **OSS: Keycloak** (SSO/SCIM) behind `policy-identity`; internal principals at the edge | designed — internal principals at edge; Keycloak binding planned |
| Row-level / object-level sharing | Restrict which principals can see which specific objects | P1 | **R13**, **R1** | **OSS: OPA** + spine PEP in the canonical-store adapter; doibio lacks FLS/row-level (gap) | planned — no FLS/row-level sharing built (doibio gap); depends on propagating-security |

## Analytics, surfaces & integration

| Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Quantitative / Contour-style analysis | Columnar aggregate analysis over large object/observation sets | P8 | **R9**, **R1**, *R8* | **OSS: clickhouse / duckdb** behind `analytics-olap`; UI via Superset/Grafana | designed — R9 port catalogued; no OLAP service bound yet |
| Dashboards / workbench layout | Multi-pane analyst workbench (map + graph + list + detail) | P8 | **R1**, *R4*, *R5*, *R8* | **spine** — `planetar-ui` 4-pane shell wired to Object API; OSS: maplibre | partial — `planetar-ui` 4-pane shell + map + graph built; Signal/Imagery/Timeline tabs stubbed |
| Object API / OSDK (programmatic access) | Typed REST + WS access to objects, sets, and actions for apps/agents | P6, P8 | **R1**, **R10**, *R4* | **spine** — `planetar-ontology` Object API REST + WS (OSDK-equivalent) | built — `planetar-ontology/src/api/server.ts` + `ws.ts` |
| Live / streaming updates to UI | Push object changes to open surfaces in real time | P8, P3 | **R3**, **R1**, *R2* | **spine** — Object API WS bridge over `planetar-broker`; redis presence enhancing | built/partial — `planetar-ontology` WS + `planetar-ui` WS bridge built; presence designed |
| Scenarios / branching / what-if | Overlay hypothetical changes on the canonical store without committing | P0, P6 | **R10**, **R1** (copy-on-write) | **spine** — scenario overlay on canonical store (per [`11 §2`](../11-CAPABILITY-ROLE-MAP.md)) | planned — scenario overlay designed in capability map; not implemented |
| Export to BI / external tools | Hand object sets to Tableau/Superset/notebooks for downstream analysis | P8, P9 | **R9**, **R1** | **OSS: clickhouse / duckdb** federated + Tableau/Superset connector | planned — federation pattern catalogued (R9); no connector built |
| Multi-tenancy / per-deployment isolation | Run isolated tenants/clients on one platform via per-client manifests | P0 | **R10**, **R13** | **spine** — per-client manifest → topology; isolation hardening is a known gap | partial — manifest model built ([`13`](../13-CLIENT-MANIFEST.md)); multi-tenancy hardening is a GAP (`README.md`) |

---

## Coverage summary

Total features assessed: **57**.

| Status | Count | Where it concentrates |
|---|---|---|
| **built** | 14 | Spine moat: bus (R3), entity/link model + Object API (P6), identity + kinematic re-ID (P5), action executor (P7), detectors (P2), doibio audit/CSV/Elasticsearch donors |
| **partial** | 20 | Analyst surfaces (`planetar-ui` map/graph built, signal/imagery/timeline stubbed), graph traversal (on canonical store, no R5 engine yet), object-index search (doibio ES built, opensearch planned), lineage/provenance, multi-tenancy |
| **designed** | 18 | Graph-engine paths/patterns (R5), geofence/watchlist triggers, media/visual re-ID (R6/R7), agent containment, tasking queues |
| **planned** | 5 | FMV exploitation, long-running orchestration (Temporal), row-level sharing/FLS, scenarios/branching, BI export |

(One row — live/streaming UI updates — is labelled `built/partial` and counted under **partial** above.)

Headline: the **Gotham core loop (ingest → resolve → link-graph → kinetic act → live surface) is built spine.** The deltas are workbench-surface polish, a dedicated graph engine (R5: falkordb) and geo engine (R8: timescaledb+postgis) bound to ports that already exist, and the P1 propagating-security story.

## Notable gaps

- **Propagating markings security (P1)** is the single biggest gap and the named roadmap "next": the R12 lineage substrate and per-field provenance are built, but *propagation* of a marking across derived stores/objects/surfaces is designed-only. Purpose-based access (OPA) and row-level/FLS sharing depend on it — and doibio has **no FLS/row-level sharing**, so this cannot be borrowed.
- **Dedicated graph engine (R5)** not yet bound: link traversal runs over the ontology's canonical store today; shortest-path and subgraph pattern matching (ring/shell-company motifs) need a real `falkordb`/`neo4j` binding behind the existing `GraphStore` port.
- **Geotemporal engine (R8)** not yet bound: `planetar-ui` has the maplibre map, but Geotime playback (Timeline tab) is a stub and postgis/timescaledb geo-query bindings are designed, not wired — geofence alerts depend on this.
- **FMV / video exploitation (R6+R8)** is planned-only; the EO detector is the closest donor but there is no per-frame tracker.
- **Long-running orchestration / declarative flow:** no declarative flow engine exists (explicit doibio gap); Action chaining is built but Temporal (R14) for durable multi-step orchestration is deferred.
- **OLAP / Contour-style analytics (R9)** and **BI export (R9 federation)** are catalogued but unbound — no clickhouse/duckdb service yet.
- **AI agent studio (AIP-adjacent):** kinetic containment is the designed guardrail, but no agent studio/runtime is built (`README.md` GAPS); RAG grounding needs the unbound R7 vector engine.
- **Connectors at breadth:** only 4 native detectors exist; the Airbyte/Singer long-tail of enterprise sources is deferred.
- **Multi-tenancy hardening** is a known gap — the per-client manifest gives logical isolation, but deployment-level tenant isolation is not hardened.
