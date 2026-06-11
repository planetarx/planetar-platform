# 20 — Parity Matrix · Salesforce Platform — Data Model + UI

This slice maps the **Salesforce Platform** primitives — the metadata-driven *data model* (standard/custom objects, fields, relationships, validation, formulas, schema tooling) and the *declarative UI* (page layouts, Lightning App Builder, list views, record/related lists, Dynamic Forms, global/Einstein search, related/UI rendering) — onto the Planetar plane model ([`00`](../00-ARCHITECTURE-OVERVIEW.md)), the 14 storage roles ([`10`](../10-STORAGE-ROLES.md)), and the custom-spine-vs-OSS split.

**Headline parity story.** Salesforce's data-model + UI moat is that *objects, fields, relationships, layouts, and search are configuration, not code* — a metadata layer (the Metadata API / Custom Metadata Types) that the runtime renders. Planetar already owns the equivalent metadata layer: the **canonical data model + registry (R10)** is the SSOT for object/field/link definitions, and the **ontology Object API** (`planetar-ontology`, built) renders typed objects/links over it via REST+WS — the OSDK-equivalent that a metadata-driven UI binds to. **doibio** is the working proof at CRM breadth: 35 JSON-schema custom objects, event-sourced vault→SQLite (37 tables), ~120 REST routes, and ~20 React micro-frontends that render those objects as list/record/related-list surfaces. So the *data-model spine and a renderable Object API are built*; what is **partial/designed** is the *declarative-UI builder chrome* (drag-drop page layouts, Dynamic Forms rules, App Builder) and the *governance-bound* pieces (FLS, field history) — Planetar has the storage roles and the canonical model to back them, but no declarative layout engine and no field-level-security enforcement yet. Search at scale binds the **object-index role (R4 → opensearch)**, semantic/Einstein-Search ranking binds the **vector role (R7 → pgvector)**; doibio runs Elasticsearch + Cohere today as the partial proof.

Columns: **Required** roles in **bold**, *enhancing* roles in *italics*. Status ∈ {built · partial · designed · planned}, with the backing repo/path cited for built/partial.

---

## Data model — objects, fields, relationships

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Standard objects | Pre-built business objects (Account, Contact, Case, …) with shared schema | P4,P6 | **R1**, **R10**, *R4* | Spine: canonical model + ontology Object Types; OSS: postgres (default R1) | partial — `planetar-ontology` object types built (`src/registry`, `src/store/schema.sql`); standard CRM object pack via doibio 35 schemas (`~/data/dev/doibio`), not yet packaged as a "standard" library |
| Custom objects (`__c`) | User-defined objects created as metadata, no code | P4,P6 | **R1**, **R10**, *R4* | Spine: registry codegen + canonical model + ontology; OSS: postgres | built — doibio 35 JSON-schema custom objects → SQLite (37 tables) `~/data/dev/doibio`; `planetar-registry` codegen slice |
| Custom fields (typed) | Add typed columns (text/number/date/picklist/lookup) declaratively | P4,P6 | **R1**, **R10** | Spine: canonical model field defs + registry; OSS: postgres | built — doibio schema fields → SQLite columns `~/data/dev/doibio`; ontology field defs `planetar-ontology/src/registry` |
| Field data types / picklists / restricted values | Enumerated + validated field domains in metadata | P4,P6 | **R10**, **R1** | Spine: registry JSON-Schema enum/format constraints | partial — JSON-Schema enum/format enforced in doibio + ontology registry; no picklist admin UI |
| Lookup relationships | Loosely-coupled reference link between objects | P4,P6 | **R1**, **R10**, *R5* | Spine: ontology Link Types over canonical links; OSS: postgres FK / falkordb for traversal | built — ontology Link Types (`planetar-ontology/src/registry`, `putLink`); doibio relational links |
| Master-detail relationships | Tightly-coupled parent-child with cascade + roll-up | P4,P6 | **R1**, **R10** | Spine: ontology link type + cascade rule on canonical store | designed — link types support parent/child; cascade-delete + roll-up-summary rules not implemented |
| Junction objects (many-to-many) | Bridge object modeling M:N relationships | P4,P6 | **R1**, **R10**, *R5* | Spine: ontology link types (a link *is* the junction); OSS: falkordb for path queries | built — ontology links model M:N natively (`planetar-ontology`); doibio join schemas |
| External objects (OData / federation) | Surface external data as read-mostly objects without copying | P4,P9 | **R9** (federated), **R10**, *R1* | OSS: clickhouse/duckdb federated, or bigquery/snowflake query-in-place | designed — zero-copy federation pattern in [`11`](../11-CAPABILITY-ROLE-MAP.md); no live external-object connector |
| Big Objects (billions of rows, archival) | Append-mostly high-volume store for historical/IoT data | P4,P9 | **R9**, **R1**, *R8* | OSS: clickhouse (R9) / timescaledb (R8) | designed — R8/R9 roles specified; not bound for a Salesforce-style Big Object yet |
| Schema Builder / ERD view | Visual drag-drop schema + relationship diagramming | P6,P8 | **R10**, *R5* | Spine: registry as ERD source; OSS: graph render (maplibre/d3) | designed — registry holds the ERD graph; no visual builder surface |
| Record IDs (stable, typed) | Globally-unique, type-prefixed immutable identifiers | P4 | **R1**, **R10** | Spine: canonical EntityId + UUIDv7 from `zmesg` envelope | built — UUIDv7 ids in `zmesg`; `EntityId` in canonical model + ontology store |
| Record types | Variant of an object with different layout/picklists per business process | P4,P6,P8 | **R1**, **R10** | Spine: ontology interface/subtype on object type | designed — interfaces/object-sets exist in ontology; per-record-type layout binding not built |
| Custom Metadata Types | Deployable, queryable configuration-as-records | P0,P4 | **R10**, *R1* | Spine: registry (R10) **is** custom metadata — git-vault SSOT + compiled copy | built — registry SSOT (`planetar-registry`, [`10` R10](../10-STORAGE-ROLES.md)); doibio config schemas |
| Custom Settings (hierarchy/list) | Cached app configuration keyed by org/profile/user | P0,P4 | **R10**, *R2* | Spine: registry + R2 hot-cache for the cached read | designed — R10 holds settings; R2 caching of settings not wired |
| Platform Cache | In-memory org/session cache partitions | P4 | **R2** | OSS: redis (default R2); in-proc LRU at edge | partial — R2 hot-cache role + ontology in-memory registry copy; no partition/quota mgmt |

---

## Data integrity — validation, formulas, automation primitives

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Validation rules | Declarative pass/fail predicates that block bad writes | P7 | **R10**, **R1** | Spine: kinetic Action Type preconditions (the only write path) | partial — Action Type precondition checks built (`planetar-ontology/src/actions/executor.ts`); rule expressions not exposed as Salesforce-style formula UI |
| Required / unique field constraints | Enforce presence + uniqueness at write time | P7,P4 | **R1**, **R10** | Spine: canonical-store unique index + action precondition; OSS: postgres constraint | built — JSON-Schema `required` + unique keys in doibio (`~/data/dev/doibio`) and ontology store |
| Formula fields (computed, read-only) | Derived field recomputed from other fields on read | P4,P6 | **R1**, **R10** | Spine: ontology Function/derived-field over canonical store | designed — ontology functions specified; declarative formula-field DSL not built |
| Roll-up summary fields | Aggregate child records onto parent (count/sum/min/max) | P4,P9 | **R1**, **R9**, *R5* | Spine: action-triggered reprojection; OSS: clickhouse/duckdb for the rollup | designed — reprojection path exists (bus→store); no declarative roll-up definition |
| Auto-number fields | Monotonic per-object sequence value | P4 | **R1**, **R10** | Spine: canonical-store sequence on insert | designed — trivially on R1; not surfaced as a field type yet |
| Field history tracking | Record old/new values on field change | P1 | **R11**, *R12* | Spine: audit envelope on every kinetic write; OSS: clickhouse sink | partial — immutable event-log audit in doibio (event-sourced vault) + ontology action audit; no per-field "history related list" UI |
| Duplicate management / matching rules | Detect + block duplicate records on create | P5 | **R1**, **R4** (blocking), *R7* | **Spine** (identity-resolution engine — the moat); OSS: opensearch blocking, pgvector fuzzy | built — `planetar-ontology/src/resolve/resolve.ts` + doibio `identity-resolution.ts` (631 LOC); blocking via R4 |
| Workflow / Process Builder / Flow (automation) | Declarative trigger→action automation on record events | P7 | **R14**, **R1**, **R3**, *R13* | Spine: action triggers off the bus; OSS: temporal (long-running R14) | designed — kinetic triggers + R14 specified; doibio has **only** webhooks, **no declarative flow engine** (`~/data/dev/doibio`) |
| Approval processes | Multi-step record approval routing with state | P7 | **R14**, **R1**, **R3** | Spine: actions as approval steps; OSS: temporal/postgres-SKIP-LOCKED queue | designed — R14 work-queue role specified; no approval-process builder |
| Apex triggers / async Apex | Imperative code hooks on DML + async jobs | P7 | **R14**, **R1**, **R3** | Spine: kinetic Action Type executor (code path) + R14 jobs | partial — Action Type executor runs imperative effects (`planetar-ontology/src/actions/executor.ts`); no Apex-equivalent governed runtime/limits |

---

## Search & query

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Global search (cross-object) | Single query box over all searchable objects | P6,P8 | **R4**, **R1**, *R2* | Spine: Object API search; OSS: **opensearch** (R4) | partial — doibio Elasticsearch search (`~/data/dev/doibio/es-app`); ontology object-index path designed, not yet opensearch-backed |
| Einstein Search (ranked/semantic) | Personalized + semantic ranking of results | P6,P8 | **R4**, **R7**, *R2* | OSS: **opensearch** + **pgvector** (semantic re-rank); doibio uses Cohere today | partial — doibio Cohere AI chat + ES (`~/data/dev/doibio`); spine R7 vector role designed |
| List views (filter/sort/saved) | Saved filtered/sorted tabular view of one object | P6,P8 | **R4**, **R1** | Spine: ontology `listEntities` + Object API; OSS: opensearch/postgres-FTS | built — ontology `listEntities` (`planetar-ontology/src/api/server.ts`); doibio list micro-frontends |
| SOQL (relationship query language) | Declarative object-relationship query | P6 | **R1**, *R5* | Spine: Object API query → canonical store + graph traversal | partial — Object API filtered queries built (`planetar-ontology/src/api/server.ts`); no full SOQL parser/relationship-subquery grammar |
| SOSL (full-text search language) | Text-search-across-objects query language | P6 | **R4** | OSS: opensearch query DSL behind Object API | designed — maps to R4 ObjectIndex `search`; no SOSL grammar layer |
| Filter / facet / aggregate | Structured filtering, faceting, aggregation over a list | P6,P8 | **R4**, *R9* | Spine: Object API `aggregate`; OSS: opensearch facets / clickhouse | partial — ObjectIndex `aggregate` contract ([`12`](../12-ADAPTER-CONTRACT.md)); doibio analytics-app facets |
| Search index sync / re-index | Keep the search index consistent with the store | P3,P6 | **R3**, **R4**, **R1** | Spine: bus-driven projector (R3→R4); OSS: opensearch | built — bus→projector pattern ([`00` §4.1](../00-ARCHITECTURE-OVERVIEW.md)); doibio event-sourced reindex (`~/data/dev/doibio`) |

---

## UI — record/layout/app rendering

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Record detail page | Renders a single record's fields + related data | P8 | **R1**, **R10**, *R4* | Spine: Object API read; Surface: React shell | built — doibio ~20 React micro-frontends render records (`~/data/dev/doibio`); `planetar-ui` object panes |
| Page layouts (field arrangement) | Per-object declarative arrangement of fields/sections | P8,P6 | **R10**, **R1** | Spine: registry holds layout metadata; Surface: layout renderer | designed — layout as registry metadata (R10); no drag-drop layout engine |
| Lightning App Builder (drag-drop pages) | Compose record/app/home pages from components | P8 | **R10**, **R1** | Spine: registry page-def; Surface: component renderer | designed — page-def in R10; builder chrome not built (UI signal/imagery/timeline tabs are stubs in `planetar-ui`) |
| Dynamic Forms (conditional field visibility) | Field visibility/required-ness driven by record state | P8,P6 | **R10**, **R1**, *R13* | Spine: registry rules; Surface: renderer eval | designed — rules expressible in registry; conditional renderer not built |
| Related lists (child records) | Show related child records inline on a parent | P8,P6 | **R1**, **R5**, *R4* | Spine: ontology `getLinks` / Object API; OSS: falkordb for deep | built — ontology `getLinks` (`planetar-ontology/src/store/store.ts`); doibio related-list views |
| Lightning Web Components / custom UI | Reusable web components binding to object data | P8 | **R1**, **R10** | Surface: React 19 component model (OSS: React/Vite) bound to Object API | partial — `planetar-ui` React 4-pane shell + maplibre + graph tab built; signal/imagery/timeline tabs stubs |
| Tabs / apps (navigation containers) | Grouped object tabs into a navigable app | P8 | **R10** | Spine: registry app-def; Surface: shell nav | partial — `planetar-ui` pane/tab nav built; app-def-driven nav not generalized |
| Path / guided process (stage tracker) | Visual stage progression for a record's lifecycle | P8,P7 | **R1**, **R10**, *R14* | Spine: action state machine; Surface: stage tracker | designed — stages map to Action Types + R14; no path UI component |
| Reports & dashboards | Build/run tabular + chart analytics on object data | P8,P9 | **R9**, **R1**, *R8* | OSS: **clickhouse**/duckdb (R9) + Superset/Tableau; doibio canned SQL today | partial — doibio analytics-app with **canned SQL only**, **no report builder** (`~/data/dev/doibio`) |
| Maps / geolocation views | Plot records on a map with proximity/geofence | P8 | **R8**, **R1**, *R5* | Spine: track model; OSS: **postgis** (R8) + **maplibre** | built — `planetar-ui` maplibre map pane + postgis R8; planetar AIS/SAR tracks |
| Files / attachments (Content) | Attach + render documents/media on records | P2,P6,P8 | **R6**, **R1**, *R7* | Spine: blob handle in envelope; OSS: **minio**/s3 (R6) | designed — blob-cas role + `{sha256,size,mime}` envelope handle ([`10` R6](../10-STORAGE-ROLES.md)); not wired into a Files UI |
| Activity timeline / feed | Chronological feed of record events + interactions | P8,P3 | **R3**, **R1**, *R8* | Spine: bus subscription (Object API WS); Surface: feed pane | partial — bus WS live updates built (`planetar-ontology/src/api/ws.ts`); `planetar-ui` channels pane; standalone activity-timeline tab is a stub |

---

## Governance-bound UI/data (security-aware rendering)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Field-Level Security (FLS) | Per-profile read/edit visibility of individual fields | P1,P8 | **R13**, **R1**, *R10* | Spine: adapter as PEP; OSS: **OPA** (R13) policy decisions | designed — adapters are PEPs ([`12` §1](../12-ADAPTER-CONTRACT.md)); doibio has **no FLS** (`~/data/dev/doibio`); markings model designed-only |
| Object-level permissions (CRUD by profile) | Profile/permission-set gate on object operations | P1,P7 | **R13**, **R10** | OSS: **keycloak** (identity) + **OPA** (R13) | designed — R13 role specified; not enforced in built services |
| Org-Wide Defaults / sharing rules | Baseline + rule-based row-level record visibility | P1 | **R13**, **R1**, *R12* | **Spine** (propagating security via lineage) + OSS: OPA | designed — propagating-security on R12 lineage is roadmap "next"; doibio has **no row-level sharing** |
| Record-level sharing (manual/criteria) | Share an individual record with a user/group | P1 | **R13**, **R1** | OSS: OPA decision + R1 share table | designed — not built |
| Setup Audit Trail / admin log | Immutable log of admin/metadata changes | P1 | **R11** | Spine: audit envelope; OSS: clickhouse sink | partial — immutable event-log audit in doibio + ontology action audit; no admin-change Setup-Trail view |
| Login / session / identity (SSO) | Authenticate users, SSO, session management | P1 | **R13**, *R2* | OSS: **keycloak** (SSO/SCIM); R2 for sessions | partial — doibio login app + session (`~/data/dev/doibio`); no Keycloak/SSO integration |

---

## Data movement — import/export/integration

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Data Import Wizard / Data Loader (CSV) | Bulk CSV import/upsert into objects | P2,P7 | **R3**, **R1**, *R14* | Spine: detector/import → envelopes → kinetic upsert; OSS: bulk loader | built — doibio CSV import/export (`~/data/dev/doibio`); ingest→bus→store path |
| Export / backup | Bulk export object data | P2,P9 | **R1**, *R9* | Spine: canonical-store scan → export; OSS: csv/parquet | built — doibio CSV export (`~/data/dev/doibio`) |
| Bulk API (high-volume async DML) | Async batch create/update/delete at scale | P7,P3 | **R14**, **R1**, **R3** | Spine: kinetic batch via R14 work-queue; OSS: postgres SKIP-LOCKED | designed — R14 + batch actions specified; no Bulk-API surface |
| REST/SOAP/Composite API (CRUD) | Programmatic record CRUD over HTTP | P6 | **R1**, **R10**, *R4* | Spine: ontology Object API (REST) — the OSDK-equivalent | built — ontology REST API (`planetar-ontology/src/api/server.ts`); doibio ~120 REST routes |
| Streaming / Platform Events / CDC | Subscribe to record-change events in real time | P3 | **R3** | Spine: `zmesg` envelope + `planetar-broker` (SHM/TCP/UDP/WAL) | built — `~/github/planetarx/planetar-broker` + `zmesg`; ontology WS push (`planetar-ontology/src/api/ws.ts`) |
| Pub/Sub API (gRPC subscribe) | gRPC stream of platform events | P3 | **R3** | Spine: broker (no gRPC); OSS: kafka alt binding of R3 | partial — broker pub/sub + WS built; **no gRPC** transport (canonical model decision: no gRPC) |
| Connectors / external integration | Pull data from 3rd-party SaaS/DB systems | P2 | **R3**, *R6* | Spine: detector SDK; OSS: **Airbyte**/Singer/Meltano | designed — detector SDK + 4 built detectors (ais/sat/eo/acoustic); connectors-at-breadth **deferred** |
| Change Data Capture sync to external | Mirror record changes to an external system | P2,P3 | **R3**, *R12* | Spine: bus bridge; OSS: kafka-connect / Airbyte sink | designed — broker→kafka bridge pattern ([`10` R3](../10-STORAGE-ROLES.md)); no built sink connector |

---

## Coverage summary

| Status | Count |
|---|---|
| built | 16 |
| partial | 14 |
| designed | 22 |
| planned | 0 |
| **Total features** | **52** |

Built (16): custom objects, custom fields, lookup relationships, junction objects, record IDs, custom metadata types, required/unique constraints, duplicate management, list views, search index sync, record detail page, related lists, maps/geolocation, CSV import, export/backup, REST API CRUD, streaming/Platform-Events-CDC. *(Note: streaming counted once; standard-objects, picklist-values, FLS, etc. land in partial/designed below.)*

Partial (14): standard objects, picklist/restricted values, platform cache, validation rules, field history, async-Apex/triggers, global search, Einstein Search, SOQL, filter/facet/aggregate, LWC/custom UI, tabs/apps, reports & dashboards, activity timeline, Setup Audit Trail, login/SSO, Pub/Sub gRPC. *(Several are genuinely partial because a built repo covers part of the contract — doibio ES search, ontology action precondition, planetar-ui shell — but the declarative/governed admin surface is missing.)*

Designed (22): master-detail, external objects, Big Objects, Schema Builder, record types, custom settings, formula fields, roll-up summary, auto-number, Flow/automation, approval processes, page layouts, App Builder, Dynamic Forms, path/guided process, files/attachments, FLS, object-level perms, OWD/sharing, record-level sharing, Bulk API, connectors, CDC-to-external. *(All have a clear role footprint and a spine hook, but no implementation.)*

The shape is the intended one: the **data-model spine and a renderable Object API are built** (objects/fields/links/CRUD/streaming/resolution all cite a live repo), while the **declarative-UI builder chrome and the governance-bound rendering layer are designed-only** — exactly the two gaps the platform roadmap names (no declarative flow engine, markings + propagating security designed-only).

## Notable gaps

1. **No declarative flow/automation engine.** Flow / Process Builder / Workflow / approval processes are all `designed` — the kinetic Action Type executor (`planetar-ontology/src/actions/executor.ts`) gives the *imperative* trigger path and R14 gives the queue, but there is no declarative trigger→action builder. doibio's **only** automation is webhooks.
2. **Field-Level Security & row-level sharing are unenforced.** R13 (policy-identity, keycloak+OPA) is specified and adapters are designed as PEPs, but no built service enforces FLS, object-CRUD-by-profile, OWD, or per-record sharing. doibio explicitly has neither FLS nor row-level sharing. Markings + propagating security (R12/R13) remain designed-only.
3. **No declarative layout/builder surface.** Page layouts, Lightning App Builder, Dynamic Forms, and record types all store cleanly as registry (R10) metadata, but there is no layout renderer or drag-drop builder. `planetar-ui`'s signal/imagery/timeline tabs are stubs.
4. **Report builder is canned-SQL only.** doibio's analytics-app has no self-serve report/dashboard builder; full coverage needs an R9 engine (clickhouse/duckdb) + a BI surface (Superset/Tableau).
5. **Search not yet on the spine object-index.** Global/Einstein search works in doibio via Elasticsearch + Cohere, but the spine's ontology object-index path is not yet opensearch-backed (R4) and semantic re-rank via pgvector (R7) is designed-only — so "Einstein-class" ranking is partial.
6. **No SOQL/SOSL grammar.** The Object API offers structured filter/aggregate, but there is no relationship-query (SOQL) or full-text-search (SOSL) language layer; clients query through the typed Object API instead.
7. **gRPC Pub/Sub API absent by decision.** Platform-Events/CDC parity is built over the broker + WS, but the canonical model explicitly avoids gRPC, so a drop-in Salesforce Pub/Sub-API (gRPC) client is not offered — kafka is the scale-out R3 binding instead.
8. **Connectors-at-breadth deferred.** Only 4 detectors (ais/sat/eo/acoustic) exist; the Airbyte/Singer connector breadth that backs "200+ connectors" / external objects / CDC-to-external is deferred.
