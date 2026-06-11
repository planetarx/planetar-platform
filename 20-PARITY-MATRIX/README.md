# 20 — Parity Matrix (index + scorecard)

Every Palantir + Salesforce feature, decomposed to planes ([`00`](../00-ARCHITECTURE-OVERVIEW.md)) and storage roles ([`10`](../10-STORAGE-ROLES.md)), with a spine-vs-OSS component named and a build status assigned against the [`README` built inventory](../README.md). Status is conservative: **built** only when a named repo demonstrably does it.

> Legend: **built** = a named repo does it · **partial** = spine primitive exists, breadth/surface incomplete · **designed** = specified here, no code · **planned** = needs an external provider, ML model, or new subsystem.

## Scorecard

| Slice | File | Features | built | partial | designed | planned |
|---|---|--:|--:|--:|--:|--:|
| Foundry — Data/Pipelines/Modeling | [palantir-foundry-data](./palantir-foundry-data.md) | 40 | 13 | 8 | 14 | 5 |
| Foundry — Ontology/Analytics/Apps | [palantir-foundry-semantic](./palantir-foundry-semantic.md) | 61 | 15 | 20 | 25 | 1 |
| Foundry — Security/Governance/Cross | [palantir-foundry-governance](./palantir-foundry-governance.md) | 42 | 8 | 13 | 19 | 0 |
| Gotham | [palantir-gotham](./palantir-gotham.md) | 57 | 14 | 18 | 20 | 5 |
| AIP + Apollo | [palantir-aip-apollo](./palantir-aip-apollo.md) | 29 | 1 | 13 | 9 | 6 |
| **Palantir subtotal** | | **229** | **51** | **72** | **87** | **17** |
| SF Platform — Data + UI | [salesforce-platform-data-ui](./salesforce-platform-data-ui.md) | 52 | 16 | 14 | 22 | 0 |
| SF Platform — Automation/Security/DevOps | [salesforce-platform-automation-security-devops](./salesforce-platform-automation-security-devops.md) | 47 | 6 | 13 | 24 | 4 |
| SF Sales + Service/Field | [salesforce-sales-service](./salesforce-sales-service.md) | 67 | 18 | 17 | 19 | 13 |
| SF Marketing + Commerce/Industry | [salesforce-marketing-commerce](./salesforce-marketing-commerce.md) | 57 | 4 | 21 | 25 | 7 |
| SF Data Cloud + Analytics + AI | [salesforce-data-analytics-ai](./salesforce-data-analytics-ai.md) | 58 | 10 | 20 | 25 | 3 |
| SF Integration/Collab/Trust/Experience | [salesforce-integration-collab-trust-experience](./salesforce-integration-collab-trust-experience.md) | 45 | 7 | 13 | 24 | 1 |
| **Salesforce subtotal** | | **326** | **61** | **98** | **139** | **28** |
| **TOTAL** | | **555** | **112** | **170** | **226** | **45** |

**Read:** ~20% built, ~31% partial, ~41% designed, ~8% planned. **Over half (51%) of all Palantir+Salesforce features already have a spine primitive** — because most features reduce to {objects, links, actions, identity-resolution, streaming, audit}, which exist in `planetar-ontology` / `planetar-broker` / `doibio`. The work is breadth and governance, not a from-scratch core.

## The ten cross-cutting gaps (ranked by how many slices they block)

These recur across nearly every matrix. They — not the per-feature long tail — are the real backlog. Sequencing is in [`../90-ROADMAP.md`](../90-ROADMAP.md).

| # | Gap | Blocks (slices) | Unblocks |
|---|---|---|---|
| 1 | **Marking propagation + FLS/row-level sharing** (R12 propagation + R13 OPA PEP) | all 11 | multi-tenancy, classified/compartmented, CRM sharing, purpose-based access — the hardest-to-clone moat |
| 2 | **Manifest compiler / binder** (12 §4 — spec-only today) | foundational | the entire per-client composition thesis; nothing composes without it |
| 3 | **Declarative Flow/automation engine** (R14 + Temporal + action-graph compiler) | ~8 | Flow/Process/Approvals/Journeys/Automate/Workshop-logic |
| 4 | **Analytics/OLAP + report builder** (R9 clickhouse/duckdb + Superset) | ~6 | Contour/Quiver/Reports/Dashboards/CRMA/Calculated-Insights/forecasting |
| 5 | **Vector + LLM gateway + embeddings** (R7 + model gateway) | ~5 | all AIP/Agentforce/RAG/semantic-search/visual-reID |
| 6 | **Graph engine binding** (R5 falkordb/neo4j) | Gotham, fincrime, CRM graph | shortest-path, ring/subgraph, link analysis at scale |
| 7 | **Search engine binding** (R4 opensearch; rebind doibio ES) | ~5 | Object Explorer / Search 360 / resolver blocking |
| 8 | **Config-driven UI builder** (Workshop / Lightning App Builder / Experience Cloud) | ~5 | no-code app + portal surfaces (today hand-coded React) |
| 9 | **Connectors-at-breadth** (Airbyte/Singer behind detector SDK) | ~4 | the 200-connector long tail (today: 4 detectors + CSV + webhooks) |
| 10 | **Apollo-class delivery** (today pm2) | deploy | multi-env zero-downtime, air-gapped signed bundles, fleet |

## A recurring spine-coherence note (surfaced by the adapter code)

Writing the adapters revealed that [`12-ADAPTER-CONTRACT.md`](../12-ADAPTER-CONTRACT.md) fully specifies only ~8 ports; **R8/R9/R10/R11/R12/R13 ports, the canonical `spine/model.ts` types, `FieldFilter`, binder pool-multiplexing, `ObjectIndex.searchCandidates/remove`, and the R2-vs-R14 default asymmetry are referenced but not yet pinned.** Several adapters had to assume shapes. This is **Phase 0** in the roadmap — lock the contracts before building from the specs.
