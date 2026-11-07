# 20 — Parity Matrix · Palantir Foundry (Ontology · Analytics · App Building)

This slice covers the **semantic + analytic + app-building** surface of Palantir Foundry: the Ontology (object/link/action/function types, Object Explorer, OSDK, scenarios/branching, the Ontology Manager), the analytics stack (Contour, Quiver, code/SQL transforms, time-series, dashboards, reporting), and the app-building layer (Workshop, Slate, Object Views, OSDK-backed custom apps, AIP Logic/agents). Foundry's *pipeline/data-engineering* surface (Code Repositories, builds, Data Connection, lineage, branching of datasets) is referenced where it underpins these features but is covered in depth in the Foundry-data parity slice.

**Headline parity story.** Foundry's differentiator is that one **semantic Ontology** — decoupled from storage — is the contract that apps, analytics, and AI all speak, and that the *only* way to mutate it is a validated, audited **Action**. We already own that exact spine: `planetar-ontology` ([`~/github/planetarx/planetar-ontology`](file:///home/sness/github/planetarx/planetar-ontology)) is a working operational ontology with object/link/action types, an OSDK-equivalent **Object API** (REST + WebSocket), an **Action Type executor** (the kinetic write path, P7), per-field-provenance **identity resolution** (P5), and the flagship **dark-vessel kinematic re-ID** rule — all over a `sqlite` canonical store, with `planetar-registry` codegen as the R10 SSOT. `doibio` ([`~/data/dev/doibio`](file:///home/sness/data/dev/doibio)) is the second proof: 35 JSON-schema custom objects, event-sourced vault→SQLite (37 tables, immutable event-log audit), ~120 REST routes, ~20 React micro-frontends, Elasticsearch search and a Cohere AI chat. So the *Ontology core, Object API, Actions, identity resolution, search, and basic app shell are built*; what is **OSS breadth** is the analytics engine (clickhouse/duckdb), the graph engine (falkordb), the vector/RAG store (pgvector + LLM gateway), the dashboard/BI surface (Superset/Grafana), and the long-running orchestration (Temporal). The recurring footprint is **{R1 canonical-store, R10 registry}** plus one specialty role; everything writes through **P7→R3 stream** and reads through the **P6 Object API**, exactly as the spine demands.

Status convention: `built` (a named repo does it today) · `partial` (a named repo does part of it) · `designed` (spec exists, not coded) · `planned`. Required roles in **bold**, enhancing roles in *italic*.

---

## Ontology — object/link/action model

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Object Types | Declare typed entity schemas (properties, title key, primary key) as governed metadata | P6, P4 | **R10**, **R1** | **Spine** — ontology object types + `planetar-registry` codegen | built — `planetar-ontology/src/registry`, `planetar-ontology/src/store`; `doibio` 35 JSON-schema objects |
| Property Types & datatypes | Strongly-typed properties incl. arrays/structs/geo/timestamp, value constraints | P6, P4 | **R10**, **R1** | **Spine** — canonical data model field dictionary (R10) | built — `planetar-registry`; canonical-model spec `~/data/vaults/docs/ARCH-canonical-data-model.md` |
| Link Types | Typed, cardinality-aware relationships between object types | P6 | **R10**, **R5**, **R1** | **Spine** ontology link types; OSS graph engine **falkordb** | partial — link types modeled in `planetar-ontology`; falkordb graph engine not yet bound (R5 via SQLite only) |
| Interfaces / shared types | Abstract interfaces an object type can implement (polymorphic object sets) | P6 | **R10**, **R1** | **Spine** — ontology type system | designed — registry supports type composition; interface layer not coded |
| Action Types (the only write path) | Validated, audited, reversible state mutations humans/AI invoke | P7 | **R10**, **R1**, **R11**, **R3**, *R13* | **Spine** — Action Type executor (kinetic layer); OSS: **OPA** for the governance gate | built — `planetar-ontology/src/actions` (P4 executor); kinetic Action Types incl. `ConfirmDarkVessel` |
| Action validation / preconditions | Precondition checks + effect rules enforced before a write commits | P7 | **R10**, **R1**, *R13* | **Spine** — precondition/effect evaluator in the executor | built — `planetar-ontology/src/actions` |
| Functions (Ontology functions / TypeScript) | Server-side derived properties + computed logic over object sets | P6 | **R10**, **R1**, *R9* | **Spine** — ontology functions over the Object API; OSS olap for heavy compute | designed — derived fields exist in canonical model; general function runtime not coded |
| Object Sets | Saved, composable, filterable collections of objects (the OSDK primitive) | P6 | **R1**, **R4**, *R7* | **Spine** — Object API set operations; OSS: **opensearch** for filter/facet | partial — Object API filtering built in `planetar-ontology/src/api`; opensearch-backed sets not yet bound |
| Ontology Manager (governance of types) | Versioned create/edit/deprecate of types with review + SemVer | P0, P6 | **R10**, *R13* | **Spine** — registry git-vault SSOT + codegen | partial — `planetar-registry` is the SSOT + codegen; review/approval UI not built |
| Scenarios / branching / what-if | Copy-on-write overlay of the ontology for hypothesis testing | P0, P6 | **R10**, **R1** (copy-on-write) | **Spine** — scenario overlay on canonical store | designed — event-sourced store makes branching tractable; overlay layer not coded |
| Marketplace / ontology packaging | Export/import a packaged ontology + apps across stacks | P0, P6 | **R10**, *R6* | **Spine** — registry export; OSS: **minio/s3** for bundle blobs | designed — registry is exportable; packaging format not specified |

---

## Ontology — identity & data fusion (Pipeline Builder / Foundry resolution)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Identity resolution / entity matching | Fold many raw observations into one canonical entity | P5 | **R1**, **R4** (blocking), **R12**, *R7* | **Spine** — the moat; OSS: **opensearch** (blocking), **pgvector** (fuzzy/visual) | built — `planetar-ontology/src/resolve`; ported from `doibio/src/lib/identity-resolution.ts` (630 LOC) |
| Per-field provenance | Track which source set each field value (golden-master merge) | P5, P1 | **R1**, **R12** | **Spine** — provenance/conflict model | built — `planetar-ontology/src/resolve` per-field provenance; canonical `_provenance` field |
| Conflict / discrepancy handling | Surface + record disagreements between sources on a field | P5 | **R1**, **R12** | **Spine** — discrepancy type in canonical model | partial — discrepancy modeled + recorded; analyst review surface not built |
| Multi-source data fusion (Pipeline Builder) | Visual mapping of N sources → one object model | P2, P5 | **R3**, **R1**, *R4* | **Spine** detector SDK + resolver; OSS: **Airbyte** for connector breadth | partial — detectors ais/sat/eo/acoustic fuse onto the bus; visual mapping UI not built |
| Dark-vessel kinematic re-ID | Re-identify a vessel across an AIS gap via kinematic match | P5 | **R1**, **R8**, *R7* | **Spine** — kinematic matcher (flagship) | built — `planetar-ontology/src/resolve` re-ID rule (P5 phase) |
| Golden record / 360 view | Single resolved view of an entity across all sources | P5, P6 | **R1**, **R4**, *R5* | **Spine** — ontology object = golden record; OSS: opensearch | built — `planetar-ontology` resolved entities; `doibio` contact 360 |

---

## Ontology — read surface (Object Explorer / OSDK)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Object API (REST) | Query/read object types, sets, links over HTTP — the OSDK-equivalent | P6, P8 | **R1**, **R10**, *R4* | **Spine** — `planetar-ontology` Object API | built — `planetar-ontology/src/api` REST routes; `doibio` ~120 REST routes |
| Object API live feed (WebSocket) | Push live object updates to subscribed surfaces | P6, P8 | **R3**, **R1** | **Spine** — Object API `/subscribe` WS over the broker | built — `planetar-ontology/src/api` WebSocket; broker R3 = `planetar-broker` |
| OSDK code generation | Typed client SDK generated from the ontology for app code | P6, P8 | **R10** | **Spine** — `planetar-registry` codegen toolchain | partial — registry codegen emits types (built slice); full typed OSDK client not generated |
| Object Explorer / list views | Browse, filter, facet, sort, paginate objects | P8, P6 | **R4**, **R1**, *R2* | **Spine** Object API + OSS: **opensearch** (search 360) | partial — list/filter in `planetar-ui` + Object API; opensearch facets not yet bound |
| Global search (Search 360 equiv.) | Full-text search across all object types | P6, P8 | **R4**, **R1**, *R7* | OSS: **opensearch** (or **elasticsearch**); spine: Object API | partial — `doibio` Elasticsearch search built; not yet wired into ontology Object API |
| Semantic / vector search | Embedding KNN search over objects + documents | P6 | **R7**, **R1**, *R4* | OSS: **pgvector** (or **qdrant**) + LLM embedder; spine: Object API | designed — R7 port specified; no embedder/vector store bound yet |
| Object Views / detail pages | Configurable per-object detail layout in the shell | P8 | **R1**, *R5*, *R8* | **Spine** — `planetar-ui` shell panes; spine Object API backing | partial — `planetar-ui` 4-pane shell + object panes; config-driven views not built |
| Link / graph exploration | Traverse neighborhood, k-hop, link charts from an object | P6, P8 | **R5**, **R1**, *R4* | OSS: **falkordb** (or **neo4j**); spine: ontology link types | partial — `planetar-ui` ontology graph tab (partial); falkordb engine not yet bound |

---

## Analytics — transforms & compute

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Contour (point-and-click analysis) | Visual, no-code exploratory analytics pipeline | P8, P9 | **R9**, **R1**, *R4* | OSS: **clickhouse**/**duckdb** + **Superset** front | designed — R9 port specified; no olap engine or Superset bound yet |
| SQL transforms | Run governed SQL to derive datasets/objects | P4, P9 | **R9**, **R1**, **R3** | OSS: **duckdb**/**clickhouse**; spine: write-projection emits envelopes | partial — `doibio` canned-SQL queries (`src/lib/queries.ts`); no general transform engine, no user-authored SQL |
| Code transforms (Python/Java/Spark) | Author transforms in code repos producing datasets | P2, P4 | **R3**, **R1**, *R9* | OSS: **dbt** / Spark / duckdb behind detector-SDK pattern | designed — detector SDK is the emit pattern; code-repo transform host not built |
| Time-series analysis stack | Query, downsample, and chart high-frequency sensor series | P8 | **R8**, **R1** | OSS: **timescaledb**+**postgis** (or **clickhouse**); spine: track model | partial — track model + detectors emit series; `planetar-ui` Timeline tab is a stub |
| Quiver (time-series workbench) | Interactive multi-series time-series exploration UI | P8 | **R8**, **R1**, *R9* | OSS: **timescaledb** + chart lib (maplibre/uPlot) | designed — series exist on the bus; no workbench surface |
| Geospatial analytics (Gaia/Geotime style) | Geo-within/near, track playback, geofence queries | P8 | **R8**, **R1**, *R5* | OSS: **postgis** + **maplibre**; spine: track model | partial — `planetar-ui` maplibre map built; geofence/playback queries partial |
| Calculated / derived metrics | Server-computed aggregate metrics over object sets | P6, P9 | **R9**, **R1** | OSS: **clickhouse**/**duckdb**; spine: ontology functions | designed — derived-field model exists; aggregate metric runtime not coded |
| Zero-copy federation / virtual tables | Query external warehouses in place without copying | P9 | **R9** (federated) | OSS: **clickhouse** (federated) / bigquery / snowflake query-in-place | designed — R9 federated binding specified; not implemented |

---

## Analytics — reporting & dashboards

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Dashboards / report builder | Compose charts + tables into shareable dashboards | P8, P9 | **R9**, **R1**, *R4* | OSS: **Superset** (or **Grafana**); spine: Object API data source | designed — no BI surface bound; `doibio/analytics-app` is canned, not a builder |
| Charting / visualizations | Render bar/line/geo/scatter over query results | P8 | **R9**, **R1**, *R8* | OSS: **Superset**/**Grafana**/**maplibre** | partial — `doibio/analytics-app` micro-frontend renders canned charts; not a general builder |
| Scheduled reports / exports | Run a report on a schedule and deliver/export it | P7, P9 | **R14**, **R9**, **R1** | OSS: **Temporal** (schedule) + **clickhouse**; spine: action trigger | designed — R14 work-queue port specified; no scheduler bound |
| CSV / dataset export | Export an object set / query result to file | P8, P9 | **R1**, *R9*, *R6* | **Spine** Object API + OSS blob; donor: `doibio` import-export | donor — `doibio/src/lib/import-export.ts` CSV import/export |
| Embedded analytics in apps | Drop charts/metrics into a custom app view | P8 | **R9**, **R1** | OSS: **Superset** embed; spine: `planetar-ui` panes | designed — depends on dashboard surface being bound |

---

## App Building — Workshop / Slate / OSDK apps

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Workshop (low-code app builder) | Compose object-backed apps from widgets + actions, no code | P8, P7 | **R1**, **R10**, **R7**?→**R14**, *R4* | **Spine** — ontology Object API + Action Types as widget data/verbs | partial — `planetar-ui` is a hand-built shell over the Object API; no widget/layout builder yet |
| Object-backed widgets (tables, forms, cards) | UI widgets bound to object sets + actions | P8 | **R1**, **R4** | **Spine** — `planetar-ui` panes over Object API; OSS opensearch for tables | partial — `planetar-ui` 4-pane shell; widgets hand-coded not config-driven |
| Action buttons / forms in apps | Trigger Action Types from UI with validated input | P8, P7 | **R10**, **R1**, **R11**, **R3** | **Spine** — Action Type executor invoked from the shell | partial — Action executor built; UI action forms partially wired |
| Slate (HTML/JS custom apps) | Author bespoke web apps against the OSDK | P8 | **R1**, **R10** | **Spine** — Object API + OSDK; OSS: any web framework (React/Vite) | built (as pattern) — `doibio` ~20 React micro-frontends over ~120 REST routes; `planetar-ui` React shell |
| Object Views config | Declarative per-object-type detail layout | P8 | **R10**, **R1** | **Spine** — registry-driven view config | designed — registry could carry view metadata; not implemented |
| Map application | Geospatial app with live tracks + object overlays | P8 | **R8**, **R1**, *R5* | **Spine** shell + OSS: **maplibre** + **postgis** | built/partial — `planetar-ui` maplibre map + live AIS tracks; advanced layers partial |
| Notebooks / analysis hosting | Host Jupyter-style notebooks against datasets | P8 | **R9**, **R1** | OSS: JupyterHub / notebook host + **duckdb** | planned — not in inventory |
| App publishing / sharing | Publish an app with access control to a user set | P0, P8 | **R10**, **R13** | **Spine** registry + OSS: **Keycloak** (identity) + **OPA** | designed — registry packaging + R13 specified; sharing/FLS not built (doibio has none) |

---

## App Building — AIP (agents, logic, automation)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| AIP Logic (LLM functions over the ontology) | LLM-backed functions that read object sets + return structured output | P6, P7 | **R7**, **R10**, **R1**, *R5* | OSS: LLM gateway + **pgvector**; spine: ontology functions | designed — kinetic-containment design exists; no LLM gateway wired |
| AIP Agents / Agent Studio | Goal-driven agents that act via tools, contained to Action Types | P7, P8 | **R7**, **R6**, **R10**, *R5*; writes via **P7** | **Spine** — kinetic containment (agents write only through Action Types); OSS: vector + LLM gateway | designed — containment model designed; agent studio not built |
| RAG grounding / knowledge retrieval | Ground LLM answers in object/document embeddings | P6 | **R7**, **R6**, **R1** | OSS: **pgvector** (or **qdrant**) + **minio/s3**; spine: Object API context | designed — R7/R6 ports specified; no embedder/store bound |
| AI chat over data | Conversational query of objects/records | P8, P6 | **R1**, *R7*, *R4* | OSS: **Cohere** (donor) / LLM gateway; spine: Object API | donor (as pattern) — `doibio` Cohere AI chat (`src/lib/ai-handler.ts`, `ai-detector.ts`) |
| Tool-use / function calling | Expose Action Types + functions as agent tools | P7 | **R10**, **R1**, **R11** | **Spine** — Action Types are the tool surface; OSS: OPA gate | designed — Action Type registry is the tool catalog; agent binding not built |
| AI usage observability / guardrails | Audit every AI read/write + enforce guardrails | P1 | **R11**, **R13** | **Spine** audit envelope; OSS: **OPA** (guardrails) + clickhouse sink | partial — immutable event-log audit covers actions (`doibio/src/lib/event-log.ts`); AI-specific guardrails designed only |

---

## App Building — automation & orchestration

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Automate / event-driven rules | Trigger actions when objects change (declarative) | P7 | **R14**, **R1**, **R3**, *R13* | **Spine** — action triggers off the bus; OSS: **Temporal** (long-running) | partial — bus delivers change events; `doibio` webhooks are the only automation (`src/lib/webhooks.ts`); no declarative flow engine |
| Scheduled builds / jobs | Run pipelines/jobs on a cron or dependency schedule | P0, P7 | **R14**, **R3** | OSS: **Temporal** (or postgres SKIP-LOCKED queue) | designed — R14 port specified; no scheduler bound |
| Webhooks / outbound events | Call external systems on object/action events | P7, P2 | **R3**, **R14** | **Spine** — bus tap; donor: `doibio` webhooks | donor — `doibio/src/lib/webhooks.ts` (the only automation present) |
| Approval / review workflows | Multi-step human approval gating an action | P7 | **R14**, **R1**, **R11**, *R13* | OSS: **Temporal** for multi-step; spine: Action Types as steps | designed — Action Types compose; no orchestration engine bound |
| Long-running orchestration | Durable multi-step workflows with checkpointing | P7 | **R14** | OSS: **Temporal** | designed — R14 temporal binding specified; not implemented |

---

## Governance & audit (as it underpins the above)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Comprehensive audit | Immutable record of every read/write/export/admin/AI action | P1 | **R11** | **Spine** — audit envelope on the bus; OSS: **clickhouse** sink at scale | partial — `doibio` immutable event-log audit (`src/lib/event-log.ts`); broker WAL R11; reads not yet audited |
| Data lineage (Monocle) | Provenance graph source→dataset→object→derivation | P1 | **R12**, **R10** | **Spine** — lineage emit rules; OSS: **Marquez** (OpenLineage) | designed — per-field provenance is the seed; Marquez not bound |
| Markings + propagating security | A marking at ingest flows to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **Spine** — propagation rules; OSS: **OPA** (decisions) + **Marquez** (lineage) | partial — built in the platform core 2026-10-06 (`planetar-platform/spine/governed.ts` + `system.ts`, `npm run governance` 70/70); not in the live service; per-record sharing still designed |
| Purpose-based access control | Gate access by declared analytic purpose, not just role | P1 | **R13**, **R11** | OSS: **OPA** policy; spine: PEP adapters at each plane | designed — adapter-as-PEP model specified; OPA not bound |

---

## Coverage summary

Counts are over the **61** features enumerated above (a feature counted once, by its strongest status).

| Status | Count | Notes |
|---|---|---|
| **built** | 12 | Object/property/action types, Action executor + validation, identity resolution + per-field provenance, dark-vessel re-ID, golden record, Object API REST + WS, Object API live feed, Slate-pattern React apps, AI chat (Cohere donor), CSV export, webhooks — all backed by `planetar-ontology` and/or `doibio`. |
| **donor** | 3 | Exists only in `doibio`: pattern donor, no code reuse in planetar |
| **partial** | 21 | Link types, Object Sets, Ontology Manager, OSDK codegen, Object Explorer/views, global search, graph exploration, conflict handling, multi-source fusion, time-series + geo analytics, charting, SQL transforms, Workshop/widgets/action-forms, map app, AI observability, comprehensive audit, Automate — a named repo does part; the OSS specialty role or builder UI is unbound. |
| **designed** | 24 | Interfaces, Functions runtime, scenarios/branching, marketplace, semantic/vector search, Contour, code transforms, Quiver, calculated metrics, federation, dashboard builder, scheduled reports/jobs, embedded analytics, Object Views config, app publishing/sharing, all of AIP Logic/Agents/RAG/tool-use, approvals, orchestration, lineage, markings, purpose-based access. |
| **planned** | 1 | Notebook hosting (no donor). |

**Spine vs OSS split:** the Ontology core, Actions, identity resolution, Object API, and audit envelope are **spine** (built). The analytics engine (**clickhouse/duckdb**), search (**opensearch**), graph (**falkordb**), vector/RAG (**pgvector** + LLM gateway), BI surface (**Superset/Grafana**), lineage (**Marquez**), policy (**OPA**/**Keycloak**), and orchestration (**Temporal**) are the **OSS breadth** still to bind. Every feature decomposes onto **{R1, R10}** plus a specialty role, confirming the role-composition thesis.

---

## Notable gaps

- **No declarative flow/automation engine.** Foundry Automate / Workshop logic has no analog: `doibio` webhooks are the *only* automation, and there is no rules/flow builder. Closing this needs **R14** bound to **Temporal** plus an action-trigger layer (designed).
- **No analytics engine bound.** Contour/Quiver/dashboards/reporting all map to **R9** (clickhouse/duckdb) which is unbound; `doibio/analytics-app` is canned charts, not a report builder. This is the single largest cluster of `designed` rows.
- **AIP is design-only.** Agents, AIP Logic, and RAG are specified via kinetic containment (agents write solely through Action Types) but no LLM gateway or vector store (**R7** pgvector/qdrant) is wired; only `doibio`'s Cohere chat exists as a pattern.
- **Markings + propagating security is designed-only** (a known platform GAP). Neither donor has FLS/row-level sharing; this blocks any multi-tenant or classified deployment until **R12 + R13 + R11** propagation is implemented.
- **OSDK is partial.** `planetar-registry` codegen emits types but not a full typed OSDK client; app builders currently hand-call the REST/WS Object API (the `doibio` ~20-app pattern).
- **Graph + search engines unbound in the live ontology.** Link analysis and Object Explorer run on the SQLite store today; **falkordb (R5)** and **opensearch (R4)** are specified but not yet bound, so traversal/facet performance is single-node.
- **No Workshop-class app builder.** Object-backed apps are hand-coded React (Slate-pattern), proven at breadth in `doibio` but without a config-driven widget/layout/Object-Views builder.
- **Lineage store (Marquez) not bound.** Per-field provenance is the seed of lineage but the **R12** lineage graph + impact analysis (Monocle parity) is unimplemented.
