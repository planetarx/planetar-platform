# 10 — Storage Roles ⭐ (keystone)

A **storage role** is an abstract data-handling responsibility with a fixed *contract* (access pattern + consistency + latency + durability), satisfied by one or more concrete **engines**. The spine and applications reference **roles**; a client's [manifest](./13-CLIENT-MANIFEST.md) **binds** each role to an engine.

This is the layer that makes "a different architecture per client" real: the same capability (e.g. *opportunity pipeline*, *dark-vessel re-ID*) decomposes into the same roles everywhere; only the engine bound to each role changes.

> **Rule:** application/spine code may depend only on a role's adapter interface ([`12`](./12-ADAPTER-CONTRACT.md)). It may never import an engine driver directly. The manifest compiler wires concrete engines in at boot.

---

## 0. The role catalog at a glance

| # | Role | One-line responsibility | Default engine | Other engines |
|---|---|---|---|---|
| R1 | **canonical-store** | Current-state of canonical entities/observations (the system of record projection) | postgres | sqlite, mysql, spanner, cockroachdb |
| R2 | **hot-cache** | Sub-ms ephemeral reads: sessions, presence, rate limits, materialized hot keys | redis | memcached, in-process LRU |
| R3 | **stream** | Ordered, durable, append-only event log + fan-out (the bus) | planetar-broker | kafka/redpanda, redis-streams, NATS JetStream |
| R4 | **object-index** | Full-text + filter + aggregation + sort over objects (search 360 / Einstein Search / OSv2) | opensearch | postgres-FTS, typesense, meilisearch |
| R5 | **graph** | Typed entity/link traversal: link charts, neighborhood expansion, shortest path | falkordb | neo4j, memgraph, postgres+AGE |
| R6 | **blob-cas** | Content-addressed unstructured bytes: media sets, photos, documents, attachments | minio/s3 | filesystem, GCS |
| R7 | **vector** | Embedding storage + KNN: semantic search, RAG grounding, visual/acoustic re-ID | pgvector | qdrant, milvus, opensearch-knn |
| R8 | **timeseries-geo** | High-volume sensor/track time series + geospatial queries (Geotime, Gaia, telemetry) | timescaledb (+postgis) | clickhouse, duckdb, postgis |
| R9 | **analytics-olap** | Columnar scan analytics: reports, dashboards, Contour/CRMA, calculated insights | clickhouse | duckdb, bigquery (fed), snowflake (fed), postgres |
| R10 | **registry** | SSOT for schema/ontology/action/manifest definitions (git-vault + compiled copy) | git + filesystem | sqlite, postgres |
| R11 | **audit-log** | Immutable append-only record of reads/writes/exports/admin/AI actions | append-WAL | clickhouse, kafka, postgres |
| R12 | **lineage** | Provenance graph: source→dataset→object→derivation edges; impact analysis | marquez (postgres) | graph engine, postgres |
| R13 | **policy-identity** | Principals, roles, markings, policy decisions (PEP/PDP) | keycloak + OPA | postgres, internal |
| R14 | **work-queue** | Durable task/job/work-item queue + orchestration state (routing, Automate, Flow, async jobs) | postgres (SKIP LOCKED) | redis, temporal, kafka |

**The six listed engines from the brief map cleanly:** `redis`→R2/R3/R14, `sqlite`→R1/R4(small)/R10, `postgres`→R1/R4/R7/R9/R11/R12/R14, `mysql`→R1, `kafka`→R3/R11/R14, `spanner`→R1 (global-scale). Plus the OSS breadth engines for the specialized roles.

---

## 1. Contract dimensions

Every role specifies its contract along these axes, so an engine binding is *checkable* (the manifest compiler rejects an engine that can't meet the role's contract):

- **Access pattern** — point-get / range-scan / full-text / aggregate / traverse / append / pub-sub / knn
- **Consistency** — strong / read-your-writes / eventual / append-only-immutable
- **Latency target** — the p99 the platform assumes when scheduling against this role
- **Durability** — must-survive-restart? replicated? WAL-backed?
- **Scale axis** — single-node / vertically-scaled / horizontally-sharded / globally-distributed
- **Rebuildable?** — can this store be dropped and re-derived from the `stream` (R3) event log? (Most projections: yes. Source-of-record streams + blobs: no.)

---

## 2. Role details

### R1 · canonical-store
- **Holds:** the current-best-knowledge projection of every canonical entity, observation, identifier, link, event, discrepancy (1:1 with the core types in `ARCH-canonical-data-model.md`).
- **Access:** point-get by id, filtered range-scan, secondary-index lookup, transactional multi-row write.
- **Contract:** strong / read-your-writes; p99 ≤ 10 ms point-get; durable, replicated; **rebuildable from R3**.
- **Engines:** `sqlite` (single-node, edge, air-gapped, demo) · `postgres` (default workhorse) · `mysql` (when the client standardizes on it) · `spanner`/`cockroachdb` (globally-distributed, planet-scale, 99.999%).
- **Powers:** Foundry object storage, Salesforce standard/custom objects, the ontology's SQLite store today.
- **Note:** this is where `spanner` lives in the brief — *same role, different engine* is the headline demonstration: maritime-edge binds `sqlite`, planet-scale enterprise binds `spanner`, and **no application code changes**.

### R2 · hot-cache
- **Holds:** ephemeral, derivable hot data — sessions, auth tokens, rate-limit counters, presence (who's online / which vessel is "live"), denormalized hot object cards, pub-sub for UI nudges.
- **Access:** point-get/set, TTL expiry, atomic counters, sorted sets, pub-sub.
- **Contract:** eventual; p99 ≤ 1 ms; **not durable** (loss is tolerable, repopulates); single-node or clustered.
- **Engines:** `redis` (default) · `memcached` · in-process LRU (tiny/edge).
- **Powers:** Salesforce Platform Cache, live-channel presence pins (the UI's per-modality control-plane state), Foundry interactive query acceleration.

### R3 · stream (the bus)
- **Holds:** the ordered, durable, append-only log of **every** envelope — sensor readings *and* action effects *and* audit. The nervous system; all other stores are projections of it.
- **Access:** append, ordered consume (by offset/topic), fan-out pub-sub, replay from offset.
- **Contract:** append-only-immutable, ordered within a partition/topic; durable (WAL); p99 publish ≤ 1 ms (broker SHM path: ns); **not rebuildable — it is the source.**
- **Engines:** `planetar-broker` (default; ns SHM + TCP/UDP + WAL) · `kafka`/`redpanda` (when the client wants the Kafka ecosystem / infinite retention / consumer groups) · `redis-streams` (lightweight) · `NATS JetStream`.
- **Powers:** Foundry streaming ingestion + dataset transactions, Salesforce Platform Events / CDC / Pub-Sub API, the entire planetar fusion pipeline.
- **Note:** the broker and Kafka are *both* valid bindings of R3 — a client can run the ns broker at the edge and bridge to Kafka in the cloud; the envelope (`zmesg`) is the wire contract across both.

### R4 · object-index
- **Holds:** an inverted + columnar index over canonical objects for search, filter, facet, sort, aggregate — what Foundry OSv2 and Salesforce Einstein Search / Gotham Search 360 provide.
- **Access:** full-text query, structured filter, facet/aggregate, sort, pagination, geo-filter.
- **Contract:** read-your-writes-within-seconds (eventual vs R1); p99 ≤ 50 ms query; durable but **rebuildable from R3/R1**.
- **Engines:** `opensearch`/`elasticsearch` (default) · `postgres` FTS + GIN (when avoiding a second system) · `typesense`/`meilisearch` (light).
- **Powers:** Object Explorer, list views, global search, the resolver's **blocking** step (R5 leans on R4 to avoid O(n²) entity comparison).

### R5 · graph
- **Holds:** typed nodes (entities) and edges (links) optimized for traversal — link analysis, "search around," neighborhood expansion, shortest path, pattern match.
- **Access:** neighbor expansion, k-hop traversal, shortest-path, subgraph pattern (Cypher-ish).
- **Contract:** read-your-writes-within-seconds; p99 ≤ 100 ms for bounded traversal; durable; **rebuildable from R1 links**.
- **Engines:** `falkordb` (default; Redis-module, fast, light) · `neo4j` (mature, Cypher) · `memgraph` · `postgres + Apache AGE` (avoid a second system).
- **Powers:** Gotham Graph/Vertex, dossiers, financial-crime ring detection, doibio's ontology graph view.

### R6 · blob-cas
- **Holds:** unstructured bytes addressed by content hash (sha256) — imagery, SAR chips, photos, FMV frames, PDFs, attachments, Salesforce Files. **Bytes never travel the bus**; envelopes carry a `{sha256, size, mime}` handle (per `ARCH-planetar-photos.md`).
- **Access:** put-by-hash, get-by-hash, presigned read URL, range-get (video).
- **Contract:** immutable once written; eventual; durable, replicated; **not rebuildable** (it is source bytes); large scale.
- **Engines:** `minio`/`s3` (default) · filesystem + sidecar (POC/edge) · `gcs`.
- **Powers:** Foundry media sets, Gotham imagery/FMV exploitation, planetar-photos, Salesforce Files/Content.

### R7 · vector
- **Holds:** embeddings (text, image, audio-SAI) + metadata for nearest-neighbor retrieval.
- **Access:** upsert vector, KNN/ANN query (cosine/dot), filtered KNN.
- **Contract:** eventual; p99 ≤ 50 ms ANN; durable; **rebuildable** (re-embed from R6/R1).
- **Engines:** `pgvector` (default; rides the postgres a client already runs) · `qdrant` · `milvus` · `opensearch`-knn.
- **Powers:** AIP/Agentforce RAG grounding, semantic search, vessel **visual re-ID** (photo↔EO↔SAR cosine), Data Cloud vector DB, knowledge-article semantic match.

### R8 · timeseries-geo
- **Holds:** high-frequency time-stamped, often geospatial, observations — AIS tracks, telemetry, PSD waterfalls, sensor histories; pattern-of-life and geofence queries.
- **Access:** time-range scan, downsample/rollup, geo-within/near, track playback, continuous aggregates.
- **Contract:** read-recent-fast; p99 ≤ 50 ms recent window; durable; high write throughput; **rebuildable from R3**.
- **Engines:** `timescaledb` + `postgis` (default; postgres extensions — one engine, two roles) · `clickhouse` (huge volume) · `duckdb` (embedded analytics) · plain `postgis`.
- **Powers:** Gotham Geotime/Gaia, Foundry time-series stack, Salesforce Maps, the planetar map/track lanes.

### R9 · analytics-olap
- **Holds:** wide, columnar, append-mostly fact tables for scan-heavy analytics over millions–billions of rows.
- **Access:** columnar aggregate scan, group-by-rollup, window functions, materialized cubes.
- **Contract:** eventual; seconds-scale for big scans; durable; horizontally scalable; **rebuildable**.
- **Engines:** `clickhouse` (default) · `duckdb` (embedded/single-node) · `bigquery`/`snowflake`/`databricks` (federated, *query-in-place* — the Data-Cloud / Foundry-virtual-tables pattern) · `postgres` (small).
- **Powers:** Foundry Contour/Quiver, Salesforce Reports & Dashboards / CRM Analytics, Data Cloud Calculated Insights, campaign/process analytics.

### R10 · registry
- **Holds:** the SSOT for schema types, object/link/action definitions, source registry, field-id dictionary, and the per-client manifest — versioned. Loaded into a compiled in-memory copy at runtime (no I/O on the data path).
- **Access:** read-all-at-boot, versioned diff, validated write (governed).
- **Contract:** strong; read-mostly; durable; versioned (SemVer per type).
- **Engines:** `git` + filesystem (default; matches `ARCH-canonical-data-model.md` git-vault SSOT) · `sqlite`/`postgres` (when a running registry service is wanted).
- **Powers:** Foundry Ontology Manager, Salesforce Metadata API / Custom Metadata Types, the registry+codegen toolchain.

### R11 · audit-log
- **Holds:** immutable record of every read, write, export, admin change, and AI interaction — exportable to a client SIEM.
- **Access:** append, time/principal/resource-filtered scan, export.
- **Contract:** append-only-immutable; durable, tamper-evident; **never rebuilt** (it is evidence).
- **Engines:** append-`WAL` (broker-style, default) · `clickhouse` (queryable at scale) · `kafka` (stream to SIEM) · `postgres`.
- **Powers:** Foundry comprehensive audit, Salesforce Shield Event Monitoring / Setup Audit Trail / Field Audit Trail, AIP usage observability.

### R12 · lineage
- **Holds:** the provenance/lineage graph — which source produced which observation, which transform derived which dataset/object, field-level provenance edges. The substrate for **propagating security** (the roadmap's "next" piece).
- **Access:** upstream/downstream traversal, impact analysis, field-provenance lookup.
- **Contract:** read-your-writes; durable; **rebuildable from R3 + transform metadata**.
- **Engines:** `marquez` (OpenLineage, postgres-backed; default) · reuse the R5 graph engine · `postgres`.
- **Powers:** Foundry Data Lineage (Monocle) + Markings propagation, Data Cloud lineage-to-source, the canonical model's per-field `_provenance`.

### R13 · policy-identity
- **Holds:** principals (users, service accounts, AI agents), roles, group/territory membership, markings/classifications, and the policy rules that gate access (the PDP); adapters at every plane are the PEP.
- **Access:** authn (token issue/verify), authz decision (`can principal do action on resource under marking?`), membership lookup.
- **Contract:** strong for decisions; low-latency (cache in R2); durable.
- **Engines:** `keycloak` (identity/SSO/SCIM) + `OPA` (policy decisions; default) · `postgres` · internal for edge/air-gapped.
- **Powers:** Salesforce profiles/permission-sets/OWD/sharing/FLS, Foundry markings/orgs/spaces/RBAC/purpose-based-access, AIP guardrails.

### R14 · work-queue
- **Holds:** durable units of pending work and orchestration state — routing queues, assigned work items, automation runs, async jobs, long-running orchestrations.
- **Access:** enqueue, claim (exactly-once / SKIP LOCKED), complete/retry, schedule, orchestration checkpoint.
- **Contract:** at-least-once or exactly-once; durable; ordered-per-key optional.
- **Engines:** `postgres` (FOR UPDATE SKIP LOCKED; default — reuse the workhorse) · `redis` (light, fast) · `temporal` (durable multi-step orchestration) · `kafka`.
- **Powers:** Service Cloud Omni-Channel routing + queues, Salesforce Flow Orchestration / async Apex / Approval Processes, Foundry build schedules + Automate, AIP agent task inboxes.

---

## 3. How roles compose into a deployment

A client doesn't pick 14 engines. The art is **collapsing roles onto as few engines as the contract allows**:

- **Minimal (edge / air-gapped / demo):** one `sqlite` file covers R1, R4 (FTS), R10; the `planetar-broker` covers R3, R11; filesystem covers R6; in-process covers R2. **Two processes, zero external services.** (This is essentially planetar today.)
- **Standard (single-cloud SaaS):** `postgres` covers R1, R4 (FTS), R7 (pgvector), R8 (timescale+postgis), R9 (small), R12, R14; `redis` covers R2, R3 (streams) or `redpanda` for R3; `opensearch` for R4 at scale; `minio` for R6; `keycloak`+`OPA` for R13.
- **Scale / regulated:** `spanner` or `cockroachdb` for R1; `kafka` for R3+R11; `opensearch` R4; `falkordb`/`neo4j` R5; `clickhouse` R8+R9; `qdrant` R7; `s3` R6; `marquez` R12; `temporal` R14.

The manifest compiler validates that the chosen collapse still satisfies every role's contract (e.g., it won't let you bind R3 to in-process memory if any consumer needs durable replay). See [`11-CAPABILITY-ROLE-MAP.md`](./11-CAPABILITY-ROLE-MAP.md) for which roles each capability *requires* (so a client that doesn't need graph analysis never binds R5).
