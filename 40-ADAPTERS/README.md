# 40 — Engine Adapters (index)

Sample-code adapters implementing the storage-role ports from [`12-ADAPTER-CONTRACT.md`](../12-ADAPTER-CONTRACT.md). Each file gives one adapter class per engine, all conforming to the same port + the same conformance suite, so a client can bind any of them by manifest.

| File | Roles | Engines | Built today |
|---|---|---|---|
| [relational](./relational.md) | R1 (+R4/R7/R8/R14 multiplex) | sqlite, postgres, mysql | sqlite ✅ (wraps `planetar-ontology` store); postgres 🟡; mysql 🔲 |
| [global-scale](./global-scale.md) | R1 @ global | spanner, cockroachdb, yugabyte | 🔲 designed |
| [stream](./stream.md) | R3 | **planetar-broker** ✅, kafka/redpanda, redis-streams, NATS | broker ✅ (TCP path; ns is SHM/C-to-C) |
| [cache-queue](./cache-queue.md) | R2, R14 | redis, memcached, in-proc LRU / postgres-skiplocked, redis, temporal | LRU + pg-pool present; durable queue 🟡 |
| [object-index](./object-index.md) | R4 | opensearch, postgres-FTS, typesense/meili, sqlite-FTS5 | doibio ES 🟡; opensearch 🔲 |
| [graph](./graph.md) | R5 | falkordb, neo4j, memgraph, postgres+AGE | 🔲 (R1 links built; no graph engine wired) |
| [blob-vector](./blob-vector.md) | R6, R7 | minio/s3, fs, gcs / pgvector, qdrant, milvus, opensearch-knn | fs CAS 🟡; vector 🔲 |
| [timeseries-olap](./timeseries-olap.md) | R8, R9 | timescale+postgis, clickhouse, duckdb, bigquery/snowflake/databricks (federated) | 🟡 data exists; adapters 🔲 |
| [governance](./governance.md) | R10, R11, R12, R13 | git-fs/sql · append-wal/clickhouse/kafka · marquez/graph · keycloak+OPA | registry ✅; audit substrate 🟡; lineage/policy 🔲 |

## Engine × role coverage

The six engines named in the brief, plus the OSS breadth, mapped to the roles they satisfy:

| Engine | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R11 | R14 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **sqlite** | ● | | | ○ | | | | | | | ○ |
| **postgres** | ● | | | ○ | ○(AGE) | | ○(pgvec) | ○(timescale) | ○ | ○ | ● |
| **mysql** | ● | | | | | | | | | | ○ |
| **redis** | | ● | ○(streams) | | ○(falkor) | | | | | | ● |
| **kafka**/redpanda | | | ● | | | | | | | ● | ○ |
| **spanner**/cockroach | ● | | | | | | | | | | |
| **planetar-broker** | | | ● | | | | | | | ● | |
| opensearch | | | | ● | | | ○(knn) | | | | |
| falkordb/neo4j | | | | | ● | | | | | | |
| minio/s3 | | | | | | ● | | | | | |
| qdrant/milvus | | | | | | | ● | | | | |
| clickhouse/duckdb | | | | | | | | ● | ● | ○ | |
| timescale+postgis | | | | | | | | ● | | | |

● primary binding · ○ also satisfies. **Note** how `postgres` alone can multiplex R1+R4+R7+R8+R9+R11+R14 — the "one engine, many roles" collapse that makes a standard client cheap (see [`relational.md §6`](./relational.md)).

## Coherence debt (must resolve before building from these)

Adapter authors flagged that several ports/types are referenced but not yet pinned in the spine: `spine/model.ts` canonical types, R8–R13 port interfaces, `FieldFilter`, `ObjectIndex.searchCandidates/remove`, binder pool-multiplexing, the R2-vs-R14 default asymmetry, and markings placement in the zmesg header. This is **Phase 0** of [`../90-ROADMAP.md`](../90-ROADMAP.md).
