# 20 — Parity Matrix · Salesforce Data Cloud + Analytics + AI/Agentforce

This slice maps the **data, analytics, and AI** halves of the Salesforce platform — **Data Cloud** (CDP / lakehouse / zero-copy / identity resolution / activation), **CRM Analytics + Reports & Dashboards** (Tableau-CRM / Einstein Analytics), and **Einstein AI + Agentforce** (predictions, generative AI, autonomous agents) — onto the Planetar plane model ([`00`](../00-ARCHITECTURE-OVERVIEW.md)), the 14 storage roles ([`10`](../10-STORAGE-ROLES.md)), and the spine/OSS split.

**Headline parity story.** Data Cloud is, structurally, *exactly* the read path Planetar already runs: external sources → envelopes on the bus (**R3**) → a canonical projection (**R1**) → identity resolution into golden entities (**P5**, the moat, built in `planetar-ontology/src/resolve/` and donor `doibio/src/lib/identity-resolution.ts`) → indexed for search/segments (**R4**) → activated through Action Types (**P7**). Data Cloud's "Data Model Objects + zero-copy + identity resolution + segmentation + activation" is our **R1+R4+R12 + P5 resolution + R9 federation + P7 kinetic** composition with a different surface. Analytics is the **R9 analytics-olap** role (clickhouse/duckdb) plus a BI surface (Superset/Tableau). Agentforce is the **agents-rag** footprint — **R7 vector + R6 blob + R10 registry**, grounded on the ontology, and *contained by the kinetic layer* (P7): agents never write except through audited, reversible Action Types, which is precisely how AIP-style containment works here. The spine is built; the breadth (real CDP-scale federation, a flow/automation engine, a no-code report builder, an LLM gateway) is largely OSS-to-wire or designed.

Role IDs (**R1**..**R14**) and plane IDs (P0..P8) are used verbatim from the spine. **Required** roles are **bold**; *enhancing* roles are *italic*.

---

## Data Cloud — data model & ingestion

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Data streams / ingestion API | Streaming + batch ingest of records/events into Data Cloud | P2,P3 | **R3**, *R6* | **spine**: detector SDK + `zmesg` envelope + `planetar-broker` (R3); OSS alt: kafka/redpanda | **built** — `planetar-broker` (SHM+TCP+UDP+WAL), `~/github/sness23/zmesg`; detectors `planetar-ais/sat/eo/acoustic` |
| Data Model Objects (DMOs) | Canonical, harmonized object schema independent of source | P4,P6 | **R1**, **R10**, *R4* | **spine**: canonical data model + registry codegen + ontology object types | **partial** — `planetar-ontology` object types + `planetar-registry` (slice); canonical model designed (`~/data/vaults/docs/ARCH-canonical-data-model.md`) |
| Data Lake Objects (DLOs) / raw landing | Untransformed source records landed before mapping | P2,P4 | **R1**, *R6*, *R9* | spine: raw-observation projection; OSS: minio/s3 (R6) + clickhouse/duckdb (R9) | **designed** — landing-as-Observation in canonical model; R6/R9 adapters planned |
| Source→DMO mapping & transforms | Map source fields into canonical model, normalize/cleanse | P2,P4 | **R1**, **R10**, *R3* | spine: write-projection logic against registry; OSS: dbt for batch transforms | **partial** — projection proven in `planetar-ontology/src/ingest/broker.ts`; declarative mapping UI not built |
| Ingestion connectors (CRM, web/mobile SDKs, cloud storage) | Prebuilt source connectors feeding data streams | P2 | **R3**, *R6* | spine: detector framework; **OSS: Airbyte / Singer taps** for breadth | **designed** — connectors-at-breadth deferred (GAP); detector pattern built for sensor lanes |
| CSV / file import & export | Bulk load and extract of records | P2,P8 | **R1**, *R6* | spine donor: doibio CSV import/export; OSS: minio for staging | **donor** — `doibio` CSV import/export path (`~/data/dev/doibio`) |
| Schema / metadata definitions (Data Cloud setup) | Versioned definition of DMOs, mappings, identity rules | P0,P4 | **R10**, **R1** | **spine**: git-vault registry SSOT + codegen | **partial** — `planetar-registry` vertical slice; full Metadata-API-equivalent designed |

## Data Cloud — identity resolution & profile

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Identity resolution rulesets | Match/merge records across sources into a unified entity | P5 | **R1**, **R4** (blocking), **R12**, *R7* | **spine** (the moat): identity-resolution engine | **built** — `planetar-ontology/src/resolve/resolve.ts`; donor `doibio/src/lib/identity-resolution.ts` (630 LOC) |
| Unified Individual / golden profile | The merged golden-master record surfaced to apps | P5,P6 | **R1**, **R4**, *R5* | **spine**: golden-master + ontology object | **built** — golden entity in `planetar-ontology` store (`src/store/store.ts`, SQLite) |
| Match rules (fuzzy / exact / probabilistic) | Configurable blocking + scoring keys for matching | P5 | **R4** (blocking), **R1**, *R7* (fuzzy/visual) | **spine**: blocking via object-index; OSS: opensearch, pgvector | **built** (exact/probabilistic) / **partial** (visual) — `planetar-ontology/src/resolve/`; visual re-ID via R7 designed |
| Reconciliation / survivorship rules | Pick winning field values across conflicting sources | P5 | **R1**, **R12** | **spine**: per-field provenance + survivorship | **built** — per-field provenance in `planetar-ontology` resolve; doibio per-field provenance |
| Field-level lineage to source | Trace each golden field back to its source record | P1,P5 | **R12**, **R10** | **spine**: lineage emit; **OSS: Marquez** (OpenLineage) for the lineage store | **partial** — per-field `_provenance` in canonical model + ontology; Marquez R12 adapter planned |
| Dark-vessel kinematic re-ID (planetar flagship) | Re-identify the same vessel across sensor gaps via kinematics | P5 | **R1**, **R8**, *R7* | **spine** (kinematic matcher) — the resolution moat applied to motion | **built** — `planetar-ontology/src/resolve/kinematics.ts` |

## Data Cloud — segmentation, federation & activation

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Segmentation (audience builder) | Define populations via filters/aggregates over the profile | P6,P8 | **R4**, **R1**, *R9* | spine: ontology object sets; **OSS: opensearch** (filter/facet) | **partial** — object-set filters via Object API; segment builder UI not built |
| Calculated Insights | Pre-aggregated metrics computed over the data graph | P9 | **R9**, **R1** | OSS: **clickhouse** / **duckdb** (columnar aggregate) | **designed** — R9 adapter planned; ontology supplies inputs |
| Zero-copy federation (query-in-place) | Query lakehouse data (Snowflake/BigQuery/Databricks) without copy | P9 | **R9** (federated engine) | OSS: **bigquery / snowflake / databricks** query-in-place adapter | **designed** — federated R9 binding designed; not implemented (GAP) |
| Activation (audience push to channels) | Send resolved segments to ad/email/CRM destinations | P7,P2 | **R14**, **R3**, **R1** | spine: activation as Action Type; OSS: temporal for delivery orchestration | **partial** — modeled as kinetic Action Types (`planetar-ontology/src/actions/executor.ts`); destination connectors deferred |
| Data Actions / streaming triggers | Fire downstream actions on data-graph changes | P3,P7 | **R3**, **R14**, *R13* | spine: bus subscription → Action Type; OSS: temporal (long-running) | **partial** — broker subscribe + action invoke built; declarative trigger UI not built |
| Profile / segment APIs (query at runtime) | Programmatic read of unified profile and membership | P6,P8 | **R1**, **R4** | **spine**: ontology Object API (REST+WS, OSDK-equivalent) | **built** — `planetar-ontology/src/api/server.ts` + `ws.ts` |
| Data sharing / Data Cloud → Snowflake share | Share governed data out to a partner warehouse | P1,P9 | **R9**, **R13**, **R11** | OSS: snowflake/databricks share + OPA gate | **designed** — federation + governance gate designed |

## Data Cloud — search & vector

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Search Index over unified data | Full-text + filter + facet over profiles/objects | P6,P8 | **R4**, **R1**, *R2* | **OSS: opensearch** (default), postgres-FTS / sqlite-FTS5 at edge | **partial** — `doibio` Elasticsearch search (`es-app`); ontology object-index via SQLite FTS designed |
| Vector / embedding store (Data Cloud Vector DB) | Store embeddings of unstructured data for semantic retrieval | P6,P7 | **R7**, **R6** | OSS: **pgvector** (default) / qdrant / milvus | **designed** — R7 vector adapter planned; envelope blob-handle pattern designed |
| Semantic search / hybrid retrieval | KNN + keyword retrieval over text/media | P6,P8 | **R7**, **R4**, *R6* | OSS: pgvector + opensearch (hybrid) | **designed** — hybrid R4+R7 path designed |
| Unstructured data ingestion (docs/PDF/media) | Land + index files for grounding | P2,P6 | **R6**, **R7**, *R4* | OSS: **minio/s3** (R6) + pgvector (R7) | **designed** — blob-CAS handle in envelope designed (`ARCH-planetar-photos.md`); minio adapter planned |

## Analytics — CRM Analytics / Reports & Dashboards

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Reports (canned + filtered) | Tabular/summary reports over objects | P8,P9 | **R9**, **R1**, *R4* | OSS: **clickhouse / duckdb**; spine: object inputs. doibio = canned SQL only | **partial** — `doibio` canned-SQL reports (`analytics-app`); no declarative report builder (GAP) |
| Report builder (no-code) | Drag-and-drop report/column/grouping designer | P8 | **R9**, **R10** | OSS: Superset (saved queries) + spine UI | **designed** — explicitly absent in doibio; Superset-backed builder designed (GAP) |
| Dashboards | Multi-widget visual summaries with filters | P8,P9 | **R9**, **R1**, *R2* | OSS: **Superset** / Grafana; alt Tableau connector | **partial** — `doibio` analytics-app dashboards; CRMA-grade dashboards designed |
| CRM Analytics datasets / lenses (Tableau CRM) | Materialized analytic datasets + exploratory lenses | P9 | **R9**, **R1** | OSS: **clickhouse** (cube/materialized) / duckdb | **designed** — R9 OLAP role; materialized-cube adapter planned |
| Einstein Discovery (auto-insights / what-drives) | Statistical/ML drivers and recommendations over a dataset | P9,P7 | **R9**, *R7* | OSS: duckdb + Python ML sidecar (statsmodels/sklearn) | **planned** — no auto-insight engine yet (GAP) |
| Calculated/derived fields & formulas | Computed columns over object/report data | P4,P9 | **R1**, **R9** | spine: ontology functions; OSS: dbt/SQL for batch | **partial** — ontology functions designed; computed fields in canonical model designed |
| Embedded analytics in UI | Charts/dashboards inside the app shell | P8 | **R9**, **R2** | OSS: Superset embed; spine: `planetar-ui` pane | **partial** — `planetar-ui` 4-pane shell built; analytics/timeline tab is a stub |
| Geo / map analytics (Salesforce Maps parity) | Spatial visualization + geofence/territory analytics | P8,P9 | **R8**, **R1**, *R5* | spine: track model; OSS: **postgis** + **maplibre** | **partial** — `planetar-ui` maplibre map built (R8); timeseries-geo postgis adapter planned |
| Scheduled report runs / async refresh | Background materialization of reports/datasets | P0,P9 | **R14**, **R9** | OSS: postgres SKIP-LOCKED (R14) / temporal; clickhouse refresh | **designed** — R14 work-queue role; scheduler designed |

## AI — Einstein predictions

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Predictive scoring (lead/opportunity/churn) | ML scores attached to objects | P9,P6 | **R9**, **R1**, *R7* | OSS: duckdb + sklearn sidecar; spine: scores as object fields | **planned** — no prediction service (GAP) |
| Einstein Prediction Builder (no-code models) | Train a model on object fields without code | P0,P9 | **R9**, **R10**, **R14** | OSS: ML sidecar + R14 training jobs | **planned** — not built (GAP) |
| Next-best-action / recommendations | Suggest the best action given context | P7,P6 | **R1**, **R14**, *R7* | spine: recommendation surfaced as candidate Action Types | **designed** — Action Type catalog built; ranking layer designed |
| Anomaly / detector outputs as predictions | Sensor detectors emit classified events (vessel/SAR/acoustic) | P2,P5 | **R3**, **R1**, *R7* | **spine**: detector framework → envelopes | **built** — `planetar-ais/sat/eo/acoustic` detectors emit classified detections |

## AI — Generative (Einstein GPT / Prompt Builder)

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Prompt templates / Prompt Builder | Reusable grounded prompts bound to object data | P6,P8 | **R10**, **R1**, *R7* | spine: prompts as registered types (R10) + ontology grounding | **designed** — prompt-as-registry-type designed |
| RAG grounding on org data | Retrieve relevant records/docs to ground generation | P6,P7 | **R7**, **R6**, **R1** | OSS: **pgvector** (R7) + minio (R6); spine: ontology context | **designed** — agents-rag footprint designed; R7/R6 adapters planned |
| Model gateway / Einstein Trust Layer | Route to LLMs with masking, grounding, audit | P0,P1 | **R13**, **R11**, *R7* | OSS: LLM gateway (LiteLLM/vLLM) behind adapter + **OPA** mask/policy | **designed** — Trust-Layer-equivalent via P1 governance + kinetic containment (GAP: not built) |
| AI chat / conversational assistant | Natural-language Q&A over org data | P8,P7 | **R7**, **R4**, **R1** | spine donor: doibio Cohere chat; OSS: vector + LLM gateway | **partial** — `doibio` Cohere AI chat (`src/services/cohere.ts`, `cohere-tools.ts`) |
| Generated-content audit & toxicity/PII gate | Log + filter every AI interaction | P1 | **R11**, **R13** | spine: audit envelope; OSS: OPA gate + PII scrubber sidecar | **partial** — immutable audit-log built (doibio event-log; broker WAL R11); content gate designed |
| Embeddings pipeline (index org data) | Batch/stream embed records and media | P2,P7 | **R7**, **R6**, **R14** | OSS: embedding model sidecar + pgvector + R14 jobs | **designed** — embeddings pipeline designed |

## AI — Agentforce (autonomous agents)

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Agent definition (Agent Builder / topics & instructions) | Declare an agent's role, topics, and instructions | P0,P6 | **R10**, **R1** | spine: agent as registered type + ontology object set | **designed** — agent-as-registry-type designed (AIP agent studio via kinetic containment) |
| Agent actions / tools | The bounded set of operations an agent may invoke | P7 | **R10**, **R1**, **R11**, **R3**, *R13* | **spine** (the moat): agent tools == registered **Action Types**; OSS: OPA gate | **built** (mechanism) — `planetar-ontology/src/actions/executor.ts` is the containment boundary; agent binding designed |
| Agent reasoning loop / planner | Plan → call tools → observe → repeat | P7,P8 | **R7**, **R1**, *R14* | OSS: agent runtime (LLM gateway) behind adapter; spine: tools = Action Types | **designed** — agents-rag + kinetic containment design |
| Knowledge / RAG retrieval for agents | Ground agent on knowledge articles + records | P6,P7 | **R7**, **R6**, **R4** | OSS: pgvector + minio + opensearch | **designed** — same agents-rag footprint |
| Agent guardrails / containment | Constrain what an agent can read/write | P1,P7 | **R13**, **R11**, **R7** | **spine**: kinetic-only write path + per-action governance gate; OSS: OPA | **partial** — kinetic-only write path **built** (P7); declarative guardrail policy designed |
| Agent run audit & observability | Full trace of every agent decision/action | P1 | **R11**, **R12** | spine: audit + lineage envelopes; OSS: clickhouse sink / Marquez | **partial** — audit envelope on bus built; AIP-style usage dashboard designed |
| Async agent task inbox / orchestration | Durable queue of agent jobs and long-running tasks | P7 | **R14**, **R3** | OSS: **temporal** (durable orchestration) / postgres SKIP-LOCKED | **designed** — R14 work-queue role; temporal binding designed |
| Human-in-the-loop approval of agent actions | Route risky agent actions to a human for approval | P7,P8 | **R14**, **R1**, *R13* | spine: approval as a precondition on Action Type; OSS: temporal | **designed** — precondition/approval modeled on existing Action Type executor |

## Governance & platform (cross-cutting, applies to all of the above)

| Feature | What it does (1 line) | Owning plane(s) | Required (**bold**) + enhancing (*italic*) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Data spaces / tenant isolation | Logical separation of data per business unit/tenant | P0,P1 | **R13**, **R1**, **R10** | spine: marking-scoped object sets; OSS: OPA + keycloak | **designed** — multi-tenancy hardening is a known GAP |
| Field-level security (FLS) / sharing | Per-field + row-level access control | P1 | **R13**, **R11** | OSS: **OPA** (PDP) + keycloak (identity); adapters are PEPs | **designed** — FLS/row-level sharing absent in doibio (GAP); propagating-security designed |
| Markings + propagating security | A marking at ingest flows to every derived store/object | P1 | **R12**, **R13**, **R11** | **spine** (propagation rules); OSS: marquez (R12) + OPA (R13) | **designed** — markings designed-only (GAP); lineage substrate (R12) per-field provenance built |
| Audit / Event Monitoring (Shield parity) | Immutable record of reads/writes/exports/AI actions | P1 | **R11** | spine: audit envelope; OSS: clickhouse sink / kafka to SIEM | **partial** — immutable event-log audit built (`doibio`); broker WAL is the append-only R11 default |
| Consent / data privacy (GDPR/CCPA holds) | Track consent + honor deletion/anonymization | P1 | **R13**, **R12**, **R11** | OSS: OPA policy + lineage-driven deletion; spine: kinetic delete action | **designed** — lineage-driven impact + kinetic delete designed |
| Identity / SSO / principals | Users, service accounts, AI agents as governed principals | P1 | **R13** | OSS: **keycloak** (SSO/SCIM) — donor present in doibio | **partial** — `doibio/keycloak/` present; OPA policy layer designed |
| Lineage / provenance graph (Data Cloud lineage) | Source → object → derivation impact graph | P1,P5 | **R12**, **R10** | spine: lineage emit; **OSS: Marquez** | **partial** — per-field provenance built in ontology + doibio; Marquez R12 store planned |

---

## Coverage summary

Counts over the **58** feature rows in this slice (status against the BUILT INVENTORY; conservative — `built` only when a named repo does it). Each row is counted once under its **dominant** status (a few rows carry a split label such as "built/partial" or "built (mechanism)"):

| Status | Count | Notes |
|---|---|---|
| **built** | 9 | Streaming ingest (broker+zmesg+detectors), CSV import/export, identity-resolution ruleset, golden profile, match rules (exact/probabilistic), survivorship, field-lineage core, dark-vessel kinematic re-ID, profile/segment Object API, detector-as-prediction, agent-tools-as-Action-Types (mechanism) |
| **donor** | 1 | Exists only in `doibio`: pattern donor, no code reuse in planetar |
| **partial** | 20 | DMOs, source→DMO mapping, schema/metadata, field-lineage store, segmentation, activation, data-actions, search index, reports (canned SQL), dashboards, embedded analytics, geo analytics, computed fields, AI chat (Cohere), gen-AI audit gate, agent guardrails/containment, agent run audit, audit/Event-Monitoring, identity/SSO, lineage graph |
| **designed** | 25 | DLOs, breadth connectors, calculated insights, zero-copy federation, data sharing, vector DB, semantic/hybrid search, unstructured ingest, report builder, CRMA datasets, scheduled refresh, NBA, prompt builder, RAG grounding, model gateway/Trust-Layer, embeddings pipeline, agent definition/planner/RAG/inbox/HITL, data spaces, FLS/sharing, markings propagation, consent/privacy |
| **planned** | 3 | Predictive scoring, Prediction Builder, Einstein Discovery (no ML prediction service exists yet) |

Total: 9 + 1 + 20 + 25 + 3 = **58** distinct feature rows across nine areas.

The structural takeaway: **every `built` row is a spine component** (R1/R3/R5 + P5/P6/P7), and **every `designed`/`planned` row is OSS-to-wire or a model sidecar** — none requires changing the semantic spine. Parity is dominated by wiring named OSS engines (opensearch, pgvector, minio, clickhouse, duckdb, Superset, Marquez, OPA, keycloak, temporal, an LLM gateway) behind the existing role adapters.

## Notable gaps

- **No declarative flow/automation engine.** doibio has only webhooks as automation; Salesforce Flow / Data Actions / activation orchestration need an OSS work-queue + orchestrator (postgres SKIP-LOCKED or **temporal**, R14) plus a declarative trigger surface. Designed, not built.
- **No no-code report builder / Einstein Discovery.** Reporting is canned SQL only (doibio `analytics-app`); a Superset/duckdb-backed (R9) drag-and-drop builder and an auto-insight/ML-driver engine are unbuilt.
- **No ML prediction service.** Predictive scoring, Prediction Builder, and next-best-action ranking have no implementation — they need an R9 + Python ML sidecar; currently `planned`.
- **Vector / RAG / LLM gateway not built.** R7 (pgvector/qdrant) adapter, embeddings pipeline, and the model gateway / Einstein-Trust-Layer-equivalent are all `designed`. doibio's Cohere chat is the only live generative path and is not grounded through the spine R7.
- **Zero-copy federation (CDP scale) deferred.** Query-in-place against Snowflake/BigQuery/Databricks (R9 federated binding) is the load-bearing Data Cloud differentiator and is designed-only — connectors-at-breadth is an explicit deferral.
- **Markings + propagating security designed-only.** The R12 lineage substrate (per-field provenance) is built, but marking propagation, FLS, and row-level sharing are not enforced; OPA (R13) + Marquez (R12) wiring is pending. This is the single biggest governance gap for true multi-tenant Data Cloud parity.
- **Multi-tenancy hardening incomplete.** Data spaces / tenant isolation rely on marking-scoped object sets that are not yet enforced end-to-end — a known platform GAP.
- **Connectors at breadth deferred.** Salesforce's prebuilt source connectors map to Airbyte/Singer behind the detector SDK, but only the sensor detectors (AIS/SAR/EO/acoustic) are built; generic enterprise connectors are deferred.
- **Agentforce is a design over a built mechanism.** The containment boundary (agent tools == audited, reversible Action Types via `planetar-ontology/src/actions/executor.ts`) is real and built; the agent runtime, planner, RAG grounding, task inbox, and HITL approval surfaces are designed against it but not implemented.
