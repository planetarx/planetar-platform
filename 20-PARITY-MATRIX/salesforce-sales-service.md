# 20 — Parity Matrix: Salesforce Sales Cloud + Service Cloud / Field Service

This slice maps **Salesforce's CRM core** — Sales Cloud (lead-to-cash), Service Cloud (case-to-resolution), and Field Service (dispatch-to-completion) — onto the Planetar plane/role model. The headline parity story: Salesforce's moat is a **metadata-driven object platform** where objects, automation, UI, sharing, and reporting are configuration rather than code. That maps almost 1:1 onto our spine: **canonical model + registry (R1+R10)** *is* the metadata-driven object store, the **ontology Object API (P6)** *is* the standard/custom-object CRUD + relationship layer (OSDK-equivalent), **Action Types (P7)** *are* the validated/audited write path that replaces Apex triggers + record-triggered Flow, and **identity resolution (P5)** *is* Duplicate Management + Data Cloud unification. The biotech CRM donor `doibio` already proves the Salesforce-leaning end: 35 JSON-schema custom objects, event-sourced vault→SQLite (37 tables), ~120 REST routes, ~20 React micro-frontends, immutable event-log audit, CSV import/export, webhooks, Elasticsearch search, and Cohere AI chat — i.e. a working, if narrow, Salesforce clone. What Salesforce has that we don't yet build are the **declarative breadth pieces**: a visual Flow engine, FLS / OWD / row-level sharing, a drag-drop report builder, Omni-Channel routing, CPQ, and Field Service scheduling. Those are mapped here as `designed`/`planned` against **R14 (work-queue)**, **R13 (policy-identity → OPA)**, and **R9 (analytics-olap → clickhouse)** with concrete OSS bindings so they are actionable.

> Status convention: **built** (a named repo does it) · **partial** (a named repo does part of it) · **designed** (spec exists, not coded) · **planned** (named but unspecified). Roles use R1..R14 from [`10-STORAGE-ROLES.md`](../10-STORAGE-ROLES.md); planes P0..P8 from [`00-ARCHITECTURE-OVERVIEW.md`](../00-ARCHITECTURE-OVERVIEW.md). **Required** roles bold, *enhancing* roles italic.

---

## Platform / Metadata Foundation

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Standard & custom objects | Define record types (Account, Contact, custom) as metadata, get CRUD for free | P4, P6 | **R1**, **R10**, *R4* | spine: canonical model + ontology object types; OSS: postgres / sqlite | built — `planetar-ontology` object types + `~/data/dev/doibio` 35 JSON-schema objects |
| Custom fields & field types | Add typed fields (text, number, picklist, lookup, formula) declaratively | P4, P6 | **R1**, **R10** | spine: registry schema + codegen; OSS: postgres column / JSON body | built (basic types) / partial (formula fields) — `planetar-registry` codegen slice |
| Record relationships (lookup / master-detail) | Typed links between objects with referential semantics | P4, P6 | **R1**, **R10**, *R5* | spine: ontology link types; OSS: falkordb for traversal | built — `planetar-ontology` link types (`src/store/`, `src/api/`) |
| Metadata API / Custom Metadata Types | Programmatic, versioned object/field/automation definitions as deployable metadata | P0, P6 | **R10**, **R1** | spine: git-vault registry SSOT + codegen; OSS: git + filesystem | partial — `planetar-registry` (codegen built; full deploy/diff tooling designed) |
| Validation rules | Field/record-level constraints enforced on save | P7 | **R10**, **R1** | spine: Action Type precondition checks; OSS: none | partial — `planetar-ontology` Action Type preconditions (`src/actions/`); declarative rule UI designed |
| Record types & page layouts | Per-profile variant schemas + form layouts for one object | P6, P8 | **R10**, *R1* | spine: ontology interfaces + registry; OSS: none (surface-side) | designed — interface/variant model speced; layout engine planned |
| Sandboxes / scenarios | Branched copy of org metadata + data for testing | P0, P6 | **R10**, **R1** (copy-on-write) | spine: scenario overlay on canonical store; OSS: none | designed — see [`11`](../11-CAPABILITY-ROLE-MAP.md) sandboxes row; not coded |
| Schema Builder / ER view | Visual map of objects + relationships | P6, P8 | **R5**, **R10** | spine: ontology link graph; OSS: falkordb + maplibre/graph render | partial — ontology graph tab in `planetar-ui` (built/partial); doibio `graph-app/` |

## Sales Cloud — Lead-to-Cash

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Leads | Capture unqualified prospects as records | P4, P6 | **R1**, **R10**, *R4* | spine: ontology object type; OSS: postgres | donor — `doibio` `leads-app/` + lead schema |
| Lead conversion | Convert a Lead into Account + Contact + Opportunity atomically | P7 | **R10**, **R1**, **R11**, **R3** | spine: Action Type (multi-effect, audited, reversible); OSS: none | partial — Action Type executor exists (`planetar-ontology/src/actions/`); ConvertLead action designed |
| Accounts & Contacts | Companies + people with hierarchy | P4, P6 | **R1**, **R10**, *R5* | spine: ontology objects + link types; OSS: postgres + falkordb (hierarchy) | donor — `doibio` `contact-app/` + party schema |
| Opportunities & stages | Deals progressing through a configurable pipeline | P4, P6 | **R1**, **R10**, *R9* | spine: ontology object + stage as picklist; OSS: postgres | partial — object model donor in `doibio`; opportunity-specific stage automation designed |
| Opportunity pipeline / forecasting | Roll up open deals by stage/owner/period for forecast | P4, P6, P9 | **R1**, **R9**, *R4* | spine: objects+actions; **OSS: clickhouse / duckdb** for roll-ups | designed — see [`11`](../11-CAPABILITY-ROLE-MAP.md) forecasting row; OLAP role unbound in built clients |
| Products & price books | Catalog of sellable items with per-book pricing | P4, P6 | **R1**, **R10** | spine: ontology objects; OSS: postgres | designed — schema pattern proven in doibio; not instantiated |
| Quotes / CPQ | Configure-price-quote: bundles, discounts, approval-gated quotes | P7, P4 | **R1**, **R10**, **R14**, *R9* | spine: Action Types for config+approval; OSS: temporal (multi-step), clickhouse (pricing analytics) | planned — CPQ rules engine not designed beyond Action Type containment |
| Campaigns & campaign influence | Group marketing efforts; attribute influenced pipeline | P4, P9 | **R1**, **R9**, *R4* | spine: objects + link types; OSS: clickhouse for influence rollup | planned |
| Activities (tasks / events) | Logged calls, emails, meetings tied to records | P4, P6, P7 | **R1**, **R10**, **R3** | spine: ontology objects + activity-as-event on bus; OSS: postgres | partial — event-sourced activity log in `doibio` (immutable event log) |
| Email integration / logging | Sync inbound/outbound email to records | P2, P4 | **R3**, **R1**, *R6* | spine: detector→envelope ingest; OSS: Airbyte/IMAP tap + minio (raw .eml) | partial — `doibio` `email-app/` + `comms-app/` (logging built; bidirectional sync designed) |
| Path & guidance for success | Stage-by-stage coaching surface on a record | P8 | **R1**, **R10** | spine: ontology stage metadata; OSS: none (surface-side) | planned — surface-only feature |
| Territory management | Assign accounts to reps by rules; roll up territory hierarchy | P1, P7 | **R13**, **R1**, **R14** | spine: assignment as Action Type; OSS: OPA (territory rules) + postgres | designed — maps to policy-identity membership; not coded |
| Sales Engagement / cadences | Sequenced multi-touch outreach steps | P7 | **R14**, **R1**, **R3** | spine: action triggers; **OSS: temporal** (durable sequence state) | planned |

## Service Cloud — Case-to-Resolution

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Cases | Support tickets as first-class records with status/priority | P4, P6 | **R1**, **R10**, *R4* | spine: ontology object type; OSS: postgres | partial — object model donor in `doibio`; case-specific lifecycle designed |
| Case assignment / escalation rules | Auto-route + escalate cases by criteria/time | P7 | **R14**, **R1**, *R13* | spine: routing as Action Types; OSS: postgres SKIP-LOCKED queue / temporal | designed — work-queue role speced; rule engine not coded |
| Omni-Channel routing | Push work items to the best available agent across channels | P7, P8 | **R14**, **R2**, **R1** | spine: routing actions; **OSS: postgres/redis queue** (presence in redis) | designed — see [`11`](../11-CAPABILITY-ROLE-MAP.md) omni-channel row; not coded |
| Queues & work distribution | Shared inboxes of pending work, claimed exactly-once | P7 | **R14**, **R1** | spine: WorkQueue port (`claim` / SKIP LOCKED); OSS: postgres / redis | designed — port defined in [`12`](../12-ADAPTER-CONTRACT.md) §3; queue logic not coded |
| Case milestones / entitlements / SLA | Track time-bound service commitments + breach alerts | P7, P1 | **R14**, **R8**, **R1** | spine: SLA timers as scheduled actions; OSS: temporal (timers) + timescaledb (breach metrics) | planned |
| Knowledge base / articles | Authored answer articles, versioned + searchable | P4, P6 | **R1**, **R4**, *R7* | spine: ontology object; **OSS: opensearch** (FTS) + pgvector (semantic match) | partial — `doibio` Elasticsearch search built (`es-app/`); article workflow designed |
| Knowledge semantic search / deflection | Suggest relevant articles by meaning to deflect cases | P6, P8 | **R7**, **R4**, **R1** | spine: Object API; **OSS: pgvector / qdrant** + opensearch | partial — `doibio` Cohere AI chat (`src/services/cohere.ts`); article grounding designed |
| Email-to-Case / Web-to-Case | Create cases from inbound email / web forms | P2, P3 | **R3**, **R1** | spine: detector→envelope ingest; OSS: Airbyte/IMAP tap | partial — `doibio` `email-app/` ingest pattern; case mapping designed |
| Live chat / messaging | Real-time agent↔customer conversation tied to a case | P3, P8 | **R3**, **R2**, **R1** | spine: broker streaming + presence; OSS: redis (presence) | partial — `doibio` `comms-app/` + `irc-cli/`/`chat-cli/` (chat built; case binding designed) |
| Case feed / chatter | Threaded activity + collaboration on a record | P3, P4, P8 | **R3**, **R1** | spine: event-sourced feed on bus; OSS: postgres projection | partial — `doibio` event-sourced feed + `comms-app/` |
| CTI / telephony (Open CTI) | Screen-pop + call control from a softphone | P2, P8 | **R3**, **R2** | spine: detector→envelope (call events); OSS: connector (Twilio/Asterisk) | planned |
| Service analytics / contact-center KPIs | Dashboards on volume, AHT, CSAT, SLA attainment | P9 | **R9**, **R1**, *R8* | OSS: **clickhouse** + Superset/Grafana | planned |
| Einstein Case Classification / next-best | Predict case fields / suggest actions | P6, P7 | **R7**, **R1**, *R9* | spine: Object API + kinetic suggestion; OSS: pgvector + LLM gateway | designed — kinetic containment pattern; ML model not built |

## Field Service

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Work orders & line items | On-site jobs decomposed into tracked tasks | P4, P6, P7 | **R1**, **R10**, **R14** | spine: ontology objects + Action Types; OSS: postgres + work-queue | designed — object + action pattern reusable; FS lifecycle not instantiated |
| Service appointments & scheduling | Time-slotted assignments with constraints | P7 | **R14**, **R8**, **R1** | spine: scheduling as actions; **OSS: temporal** (durable schedule) + timescaledb | planned |
| Dispatcher console / Gantt | Visual board to assign + balance technician load | P8 | **R14**, **R8**, *R5* | OSS: scheduling lib + maplibre; spine: WorkQueue state | planned — surface-heavy; not designed |
| Optimization / route assignment | Auto-assign + sequence appointments to minimize travel | P7 | **R14**, **R8** | OSS: OR-Tools / VROOM behind work-queue; spine: assignment actions | planned |
| Mobile / offline field app | Technician app that works disconnected and syncs | P8, P4 | **R1**, **R3**, *R6* | spine: edge sqlite + broker replay (rebuildable projection); OSS: sqlite | designed — edge-tier manifest (sqlite + broker) is exactly this topology ([`13`](../13-CLIENT-MANIFEST.md)) |
| Asset & inventory tracking | Track installed-base assets + truck-stock parts | P4, P6 | **R1**, **R10**, *R5* | spine: ontology objects + hierarchy links; OSS: postgres + falkordb | designed |
| Field photos / attachments | Capture site media tied to a work order | P2, P6, P8 | **R6**, **R1**, *R7* | spine: blob handle in envelope (`{sha256,size,mime}`); **OSS: minio/s3** | partial — blob-cas port + `ARCH-planetar-photos.md` design; FS-specific UI not built |
| Crew & territory dispatch | Group technicians + bound by service territory | P1, P7 | **R13**, **R14**, **R1** | spine: membership + assignment actions; OSS: OPA + postgres | planned |

## Automation & Process

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Flow (visual declarative automation) | No-code record-triggered / screen / scheduled flows | P7 | **R14**, **R1**, **R3**, *R13* | spine: action triggers; **OSS: temporal** (long-running orchestration) | designed — Action Type executor is the substrate; visual Flow engine **not built** (doibio has no declarative flow engine) |
| Workflow rules / process builder | Legacy field-update + task automation on save | P7 | **R1**, **R3**, **R14** | spine: post-effect action triggers; OSS: temporal | designed |
| Approval processes | Multi-step record approval with routing + locking | P7 | **R14**, **R1**, **R11**, *R13* | spine: approval as Action Type chain; **OSS: temporal** + OPA gate | designed — kinetic chain pattern; approval engine not coded |
| Apex triggers / classes (pro-code) | Imperative server-side logic on DML events | P7 | **R10**, **R1**, **R3**, **R11** | spine: Action Type executor (validated, audited, reversible) — the only write path; OSS: none | built — `planetar-ontology` Action Types (`src/actions/`); the canonical replacement for triggers |
| Platform Events / Change Data Capture | Publish/subscribe to record-change events | P3 | **R3** | spine: `zmesg` envelope + `planetar-broker` (every state change is an envelope); OSS: kafka alt | built — `planetar-broker` (SHM/TCP/UDP/WAL), `zmesg` envelope |
| Pub/Sub API | gRPC streaming of platform events to external consumers | P3, P8 | **R3** | spine: broker TCP/sub fan-out; OSS: kafka consumer groups | built (TCP/WS bridge) — `planetar-broker` ports 12001/12002; gRPC facade designed |
| Outbound messages / webhooks | Fire an HTTP callout on a record/automation event | P2, P7 | **R3**, **R14** | spine: action effect → webhook dispatch; OSS: postgres queue (retry) | donor — `doibio` `src/lib/webhooks.ts` (the only automation in doibio) |
| Scheduled / async jobs (batch Apex) | Run deferred or recurring bulk work | P7 | **R14**, **R1** | spine: WorkQueue port; **OSS: temporal** / postgres-cron | designed — port defined; scheduler not coded |
| Einstein / Agentforce agents | RAG + tool-use AI agents acting on records | P7, P8 | **R7**, **R6**, **R10**, *R5* | spine: kinetic containment (agents write only via Action Types); OSS: pgvector + LLM gateway | designed — containment via P7; agent studio not built; doibio Cohere chat is read-only precursor |

## Data, Reporting & Integration

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Reports & report builder | Drag-drop tabular/summary/matrix reports over objects | P8, P9 | **R9**, **R1**, *R4* | OSS: **clickhouse/duckdb** + Superset; spine: object-set source | partial — `doibio` has canned SQL reports only (`analytics-app/`); no drag-drop report builder |
| Dashboards | Charts/components over report data, refreshable | P8, P9 | **R9**, **R1** | OSS: clickhouse + **Superset/Grafana**; spine: Object API source | partial — `doibio` `analytics-app/` (fixed dashboards); composable builder planned |
| CRM Analytics (Tableau CRM / Einstein) | Self-service columnar analytics + predictions | P9 | **R9**, **R1**, *R7* | OSS: **clickhouse / duckdb** (+ Tableau connector); spine: object-set export | planned |
| List views & filters | Saved filtered/sorted views of an object | P6, P8 | **R4**, **R1**, *R2* | spine: Object API list query; **OSS: opensearch** (or pg-FTS / sqlite-FTS) | built — `planetar-ontology` Object API list/filter; `doibio` `tables-app/` |
| Global / Einstein Search | Unified full-text search across objects | P6, P8 | **R4**, **R1**, *R7* | spine: Object API; **OSS: opensearch** (+ pgvector for semantic) | built — `doibio` Elasticsearch (`es-app/`); ontology `object-index` port |
| Duplicate management / matching | Detect + merge duplicate records on rules | P5 | **R1**, **R4** (blocking), **R12**, *R7* | **spine: identity-resolution engine** (the moat); OSS: opensearch (blocking), pgvector (fuzzy) | built — `doibio/src/lib/identity-resolution.ts` (630 LOC) → ported into `planetar-ontology` (`src/resolve/`) |
| Data Cloud / unification & golden record | Resolve cross-source profiles into a unified record | P5, P4 | **R1**, **R4**, **R12**, *R7* | spine: identity resolution + per-field provenance; OSS: opensearch, pgvector | built (core) / designed (multi-source scale) — `planetar-ontology` per-field provenance + identity res; dark-vessel re-ID is the proven instance |
| Data import wizard / Data Loader | Bulk CSV import/export of records | P2, P4 | **R1**, **R3**, *R14* | spine: import→envelope→canonical projection; OSS: postgres | donor — `doibio/src/lib/import-export.ts` (CSV import/export) |
| External objects / OData (Connect) | Surface external data as live virtual records | P9, P6 | **R9** (federated), **R1** | OSS: **bigquery/snowflake/databricks** query-in-place; spine: virtual object type | planned — zero-copy federation row in [`11`](../11-CAPABILITY-ROLE-MAP.md); not coded |
| MuleSoft / connectors (integration) | 200+ prebuilt source/target connectors | P2 | **R3**, *R6* | spine: detector SDK; **OSS: Airbyte / Singer / Meltano** | designed — connectors-at-breadth deferred (per GAPS); broker ingest SDK exists |
| REST / SOAP / Bulk / GraphQL APIs | Programmatic record access for integrators | P6, P8 | **R1**, **R10**, *R4* | spine: ontology Object API (REST + WS, OSDK-equivalent); OSS: Hasura/GraphQL gen | built — `planetar-ontology` Object API REST+WS (`src/api/`); `doibio` ~120 REST routes |
| Streaming ingestion (sensor / event) | High-volume real-time event intake into the store | P2, P3 | **R3** | spine: broker + envelope + detector framework; OSS: kafka alt | built — detectors ais/sat/eo/acoustic → `planetar-broker` |

## Governance, Security & Audit

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Profiles & permission sets | Bundle object/field/feature permissions per user | P1 | **R13**, **R10** | spine: principal/role model; **OSS: Keycloak** + OPA | designed — policy-identity role speced; doibio uses Keycloak (`keycloak/`) for authn only |
| Org-Wide Defaults & role hierarchy | Baseline record visibility + manager rollup access | P1 | **R13**, **R1** | spine: marking + policy model; **OSS: OPA** (decisions), postgres (membership) | designed — propagating-security is designed-only (per GAPS) |
| Sharing rules / manual & criteria sharing | Grant row-level access by rule or share action | P1, P7 | **R13**, **R11**, *R14* | spine: share as Action Type + policy; **OSS: OPA** | designed — **no row-level sharing in doibio** (GAPS); OPA-backed design only |
| Field-Level Security (FLS) | Hide/restrict fields per profile | P1 | **R13**, **R10** | spine: marking on fields (PEP at adapter); OSS: OPA | designed — **no FLS in doibio** (GAPS); marking model designed |
| Markings / classification + propagation | Tag data sensitivity; carry it to every derived store | P1 | **R12**, **R13**, **R11** | spine: marking propagation rules along lineage; OSS: OPA + **marquez** | designed — markings + propagating security designed-only (GAPS) |
| Login / session / IP / MFA policies | Authentication and session governance | P1 | **R13** | OSS: **Keycloak** (SSO/SCIM/MFA); spine: PEP integration | partial — `doibio` `keycloak/` + `login-app/` (authn built; full policy set designed) |
| Field History / Field Audit Trail | Immutable per-field change history | P1, P4 | **R11**, **R12** | spine: event-sourced audit envelope + per-field provenance; OSS: clickhouse sink | built — `doibio` immutable event-log audit; `planetar-ontology` per-field provenance |
| Setup Audit Trail | Record of admin/config changes | P1 | **R11**, **R10** | spine: audit envelope on registry writes; OSS: append-WAL / clickhouse | built (data-plane) / designed (config-plane) — `planetar-broker` WAL audit log |
| Shield Event Monitoring | Log of reads/exports/API/AI usage for SIEM | P1 | **R11** | spine: audit envelope (read+export events); **OSS: clickhouse** sink → SIEM | partial — write/event audit built (`doibio` event log); read-event + export instrumentation designed |
| Encryption (Shield Platform Encryption) | Encrypt fields at rest with key management | P1, P4 | **R1**, **R13** | OSS: engine-native TDE / pgcrypto; spine: marking-driven field encryption | planned |
| Data residency / multi-tenancy isolation | Per-tenant data + compute boundaries | P0, P1 | **R13**, **R1** | spine: per-client manifest topology; OSS: engine-native | partial / planned — manifest gives per-client topology ([`13`](../13-CLIENT-MANIFEST.md)); multi-tenancy hardening is a GAP |

## Surfaces & UX

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Lightning App Builder / page layouts | Compose record/home/app pages from components | P8 | **R10**, *R1* | spine: ontology metadata source; OSS: React shell | partial — `planetar-ui` 4-pane shell + `doibio` ~20 React micro-frontends; declarative page builder designed |
| Record detail / related lists | Canonical record view with related-object panels | P8, P6 | **R1**, **R10**, *R5* | spine: Object API + link types; OSS: React shell | built — `planetar-ui` + `doibio` `contact-app/`/`tables-app/` |
| Console / split-view (Service Console) | Multi-record tabbed agent workspace | P8 | **R1**, **R2** | spine: Object API; OSS: React shell + redis (presence) | partial — `planetar-ui` 4-pane shell (built/partial) is exactly this layout |
| Kanban / pipeline board | Drag records across stages on a board | P8 | **R1**, **R10** | spine: Object API + stage metadata; OSS: React shell | designed — object/stage model exists; board surface not built |
| Maps / geo surface (Salesforce Maps) | Plot records on a map with geo filters | P8 | **R8**, **R1**, *R5* | spine: track model; **OSS: postgis + maplibre** | built — `planetar-ui` maplibre map tab |
| OSDK / typed client SDK | Generated typed client over the object model | P6, P8 | **R1**, **R10** | spine: Object API + registry codegen (OSDK-equivalent); OSS: none | built — `planetar-ontology` Object API + `planetar-registry` codegen |
| Mobile app | Native/responsive record access | P8 | **R1**, **R3** | spine: Object API + offline replay; OSS: React (responsive) | designed — edge sqlite+broker topology supports offline; native app not built |

---

## Coverage summary

Counts are by the first status word in each feature row.

| Status | Count | Notes |
|---|---|---|
| **built** | 17 | Object API + objects, Action Types, broker/Platform Events, webhooks, CSV import/export, identity resolution / duplicate mgmt, Elasticsearch search, list views, OSDK/codegen, maplibre map, event-log audit, per-field provenance, streaming ingestion, REST APIs |
| **donor** | 4 | Exists only in `doibio`: pattern donor, no code reuse in planetar |
| **partial** | 21 | Cases/Opportunities object donors, knowledge search, email/chat ingest, case feed, reports/dashboards (canned only), Data Cloud unification at scale, console/shell, login/Keycloak, Shield event monitoring, field/page builders |
| **designed** | 25 | Validation-rule UI, sandboxes, lead conversion action, territory mgmt, omni-channel/queues, SLA-adjacent, Flow engine, approvals, agents, FLS/OWD/sharing, markings + propagation, federation |
| **planned** | 14 | CPQ, campaigns, sales cadences, CTI, service analytics, full Field Service scheduling/optimization/dispatch, CRM Analytics, encryption, external objects |
| **Total features** | **81** | across 8 areas |

The "spine half" of Salesforce — metadata-driven objects, the kinetic write path (Apex/Flow substrate), Platform Events, identity resolution, audit, and the typed Object/OSDK API — is **largely built** in `planetar-ontology` + `doibio` + `planetar-broker`. The "breadth half" — visual Flow, sharing/FLS, report builder, Omni-Channel, CPQ, Field Service scheduling — is **designed/planned** and binds to named OSS (temporal, OPA, Keycloak, clickhouse, Superset, Airbyte, opensearch, pgvector).

## Notable gaps

- **No declarative Flow engine.** Action Types (P7) give the validated/audited/reversible write substrate, but there is no visual no-code Flow/Process-Builder authoring layer. `doibio`'s only automation is webhooks (`src/lib/webhooks.ts`). Target binding: **temporal** (R14) for long-running orchestration + an action-graph authoring surface.
- **No row-level sharing / FLS / OWD.** Record-level and field-level security are **designed-only** against R13 (Keycloak + OPA) and the marking model; `doibio` has neither. This is the same "markings + propagating security (designed-only)" GAP that blocks Foundry-style governance.
- **No drag-drop report builder.** Reporting is **canned SQL only** (`doibio/analytics-app/`); the composable report/dashboard builder over R9 (clickhouse/duckdb + Superset) is partial→planned. OLAP role (R9) is **unbound in every built client** today.
- **Field Service is almost entirely planned.** Work orders reuse the object/action pattern, but scheduling, optimization (OR-Tools/VROOM), dispatcher Gantt, and crew/territory dispatch are unbuilt; only the offline-mobile topology (edge sqlite + broker) is directly supported by the existing manifest.
- **CPQ and pricing logic** have no rules engine designed beyond generic Action Type containment.
- **Connectors at breadth (MuleSoft-equivalent) are deferred** (per inventory GAPS) — the detector/ingest SDK exists, but the Airbyte/Singer connector fleet is not wired.
- **Multi-tenancy hardening is incomplete.** Per-client *topology* isolation is first-class via the manifest, but in-tenant isolation (per-org compute/data boundaries, residency) is partial/planned.
- **Agentforce/AIP agent studio** is contained-by-design (agents write only through P7 Action Types) but the agent authoring + tool-registration studio is not built; `doibio`'s Cohere chat is a read-only precursor.
- **Postgres adapter for the CRM donor is a stub** in `doibio` (built path is event-sourced vault→SQLite); the production R1 postgres binding relies on the platform's own `PostgresCanonicalStore` adapter ([`12`](../12-ADAPTER-CONTRACT.md) §2.1), not doibio's.
