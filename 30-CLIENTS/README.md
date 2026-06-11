# 30 — Client Reference Architectures (index)

Four clients, one spine. Each is a different **role footprint** ([`11 §3`](../11-CAPABILITY-ROLE-MAP.md)) bound to a different **engine mix** via its [manifest](../13-CLIENT-MANIFEST.md). The ontology, resolver, kinetic executor, Object API, and identity-resolution code are **identical** across all four — only the manifest and the domain registry types differ. That invariance is the product.

| Client | File | Capabilities | Bound roles | Headline engine mix | Reuse |
|---|---|--:|---|---|---|
| **Maritime / Defence** (planetar) | [maritime-defence](./maritime-defence.md) | 9 | R1,R3,R4,R5,R6,R8,R10,R11,R12,R13,R14 | **edge:** sqlite + broker + postgis + fs + internal-OPA (0 external services) · **scale:** postgres + opensearch + broker→kafka + minio + clickhouse + falkordb + pgvector + keycloak/OPA | planetar-* unchanged |
| **Biotech / Research CRM** (doibio) | [biotech-research-crm](./biotech-research-crm.md) | 9 | R1,R2,R3,R4,R5,R6,R7,R9,R10,R11,R12,R13,R14 (R8 never binds) | postgres + redis + opensearch + falkordb + minio + pgvector + clickhouse + temporal + keycloak/OPA | doibio donor |
| **Generic Enterprise CRM+Ops** | [generic-enterprise](./generic-enterprise.md) | 13 | R1,R2,R3,R4,R6,R7,R9,R10,R11,R12,R13,R14 (R5 enhancing) | **standard:** postgres-multiplex + redis + opensearch + clickhouse + minio + keycloak/OPA + marquez + broker · **scale:** spanner + kafka + qdrant + neo4j + temporal (multi-region) | spine unchanged; net-new = `crm:*` types |
| **Intel / Financial-Crime Graph** | [intel-financial-crime](./intel-financial-crime.md) | 12 | R1,R3,R4,R5,R6,R7,R8,R10,R11,R12,R13,R14 (+R2,R9) | **scale:** cockroachdb + kafka + opensearch + neo4j + qdrant + clickhouse + minio + marquez + keycloak/OPA · **air-gapped:** sqlite + broker + falkordb + duckdb + append-wal + internal | spine unchanged; graph + governance heavy |

## What the four prove together

- **Same spine, 2-process edge box → 12-engine multi-region cloud.** Maritime-edge and generic-enterprise-scale run the same ontology code on `sqlite`+broker vs `spanner`+`kafka`+`clickhouse`. (Gap #2 — the manifest compiler — is what makes this real rather than aspirational; see [`../90-ROADMAP.md`](../90-ROADMAP.md).)
- **Role selectivity is real.** Biotech CRM and generic-enterprise **never bind R8** (no sensor firehose); maritime **never binds R9** at the edge. The compiler confirms no enabled capability needs the unbound role.
- **Salesforce and Gotham are the same machine.** Generic-enterprise presents the spine as Salesforce (objects/pipeline/cases/flow); intel-financial-crime presents it as Gotham (graph/watchlists/dossiers/markings). Different surfaces + footprints, one semantic core.
- **The shared blocker is governance.** All four list marking-propagation + FLS as the top gap (cross-cutting gap #1).
