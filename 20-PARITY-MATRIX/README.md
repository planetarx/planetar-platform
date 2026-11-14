# 20 — Parity Matrix (index + scorecard)

> Palantir-side claims corrected 2026-11-14 against the planetar-palantir research (2026-11-06); rows it did not cover are unchanged.

Every Palantir + Salesforce feature, decomposed to planes ([`00`](../00-ARCHITECTURE-OVERVIEW.md)) and storage roles ([`10`](../10-STORAGE-ROLES.md)), with a spine-vs-OSS component named and a build status assigned against the [`README` built inventory](../README.md). Status is conservative: **built** only when a named repo demonstrably does it.

> Legend: **built** = a planetar repo does it · **donor** = exists only in `doibio`, a pattern donor with no code reuse, so it does not count as built · **partial** = spine primitive exists, breadth/surface incomplete · **designed** = specified here, no code · **planned** = needs an external provider, ML model, or new subsystem.

## Scorecard

| Slice | File | Features | built | donor | partial | designed | planned |
|---|---|--:|--:|--:|--:|--:|--:|
| Foundry — Data/Pipelines/Modeling | [palantir-foundry-data](./palantir-foundry-data.md) | 40 | 14 | 1 | 10 | 12 | 3 |
| Foundry — Ontology/Analytics/Apps | [palantir-foundry-semantic](./palantir-foundry-semantic.md) | 67 | 12 | 3 | 21 | 24 | 7 |
| Foundry — Security/Governance/Cross | [palantir-foundry-governance](./palantir-foundry-governance.md) | 51 | 9 | 0 | 19 | 21 | 2 |
| Gotham | [palantir-gotham](./palantir-gotham.md) | 63 | 14 | 1 | 19 | 18 | 11 |
| AIP + Apollo | [palantir-aip-apollo](./palantir-aip-apollo.md) | 40 | 2 | 0 | 13 | 9 | 16 |
| **Palantir subtotal** |  | **261** | **51** | **5** | **82** | **84** | **39** |
| SF Platform — Data + UI | [salesforce-platform-data-ui](./salesforce-platform-data-ui.md) | 58 | 16 | 1 | 17 | 24 | 0 |
| SF Platform — Automation/Security/DevOps | [salesforce-platform-automation-security-devops](./salesforce-platform-automation-security-devops.md) | 47 | 6 | 0 | 13 | 24 | 4 |
| SF Sales + Service/Field | [salesforce-sales-service](./salesforce-sales-service.md) | 81 | 17 | 4 | 21 | 25 | 14 |
| SF Marketing + Commerce/Industry | [salesforce-marketing-commerce](./salesforce-marketing-commerce.md) | 57 | 0 | 3 | 23 | 26 | 5 |
| SF Data Cloud + Analytics + AI | [salesforce-data-analytics-ai](./salesforce-data-analytics-ai.md) | 58 | 9 | 1 | 20 | 25 | 3 |
| SF Integration/Collab/Trust/Experience | [salesforce-integration-collab-trust-experience](./salesforce-integration-collab-trust-experience.md) | 47 | 10 | 1 | 13 | 22 | 1 |
| **Salesforce subtotal** |  | **348** | **58** | **10** | **107** | **146** | **27** |
| **TOTAL** |  | **609** | **109** | **15** | **189** | **230** | **66** |

**Read:** ~18% built, ~2% donor, ~31% partial, ~38% designed, ~11% planned. Recounted row by row on 2026-11-06, by the first status word in each row's last cell (9 rows have split statuses); the earlier 555 total had drifted from the 584 rows in the slices. On 2026-11-14, 25 Palantir rows were added for omissions the planetar-palantir research named (CBAC, governed declassification, Target Workbench, Nexus Peering, AI FDE, Apollo recalls and others), each `planned (not built)`; that is the whole change from 584 to 609. Row statuses are otherwise unchanged: governance rows date from 2026-10-06 and every other row from 2026-06-09. **Built or partial covers 49% of all features (298 of 609): 51% of Palantir and 47% of Salesforce.** Most features reduce to {objects, links, actions, identity-resolution, streaming, audit}, which exist in `planetar-ontology` / `planetar-broker`, with `doibio` as a pattern donor only. The work is breadth and governance, not a from-scratch core.

## What this matrix does and does not show

- **It is not evidence about how Salesforce or Palantir work.** Feature descriptions were written without external citations. Palantir-side descriptions were corrected on 2026-11-14 where the planetar-palantir research (2026-11-06) found them wrong, with citations to Palantir's docs; the remaining Palantir rows and all Salesforce rows have not been audited row by row.
- **A status describes planetar's side only.** "built" says a planetar feature exists, not that its mechanism matches the product. Known differences on the Salesforce side:

| Row | planetar today | Salesforce's documented mechanism |
|---|---|---|
| Custom objects and fields | Compiled schemas with per-object physical tables | Designed to avoid per-tenant physical DDL ([US 7,779,039](https://patents.google.com/patent/US7779039B2/en), [Platform Multitenant Architecture](https://architect.salesforce.com/fundamentals/platform-multitenant-architecture)) |
| Record IDs | UUIDv7 `EntityId`, no type prefix | 3-character type prefix ([US 7,779,039](https://patents.google.com/patent/US7779039B2/en); a patent shows what was claimed, not necessarily what shipped) |
| Platform Events, CDC | Topics on the bus | Publish-boundary semantics and 72-hour replay ([Platform Events](https://developer.salesforce.com/docs/atlas.en-us.264.0.platform_events.meta/platform_events/platform_events_intro_emp.htm)) |
| SOQL | Object API filters, no grammar | Translated to SQL with a tenant-aware optimizer ([CIDR 2026](https://vldb.org/cidrdb/papers/2026/p28-arora.pdf)) |
| Profiles, OWD, sharing, FLS | Default-deny policy with grants and redaction | Precomputed grants checked by joins appended to SQL ([Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)) |
| Apex triggers | Action handlers, no sandboxed runtime | Interpreted tenant code under hard counters ([Execution Governors and Limits](https://developer.salesforce.com/docs/atlas.en-us.264.0.apexcode.meta/apexcode/apex_gov_limits.htm)) |

## The ten cross-cutting gaps (ranked by how many slices they block)

These recur across nearly every matrix. They — not the per-feature long tail — are the real backlog. Sequencing is in [`../90-ROADMAP.md`](../90-ROADMAP.md).

| # | Gap | Blocks (slices) | Unblocks |
|---|---|---|---|
| 1 | **Marking propagation + FLS/row-level sharing** (R12 propagation + R13 OPA PEP) — *core built 2026-10-06 in the zero-service tier; open: OPA/Keycloak, the live service, per-record sharing, governed declassification (no marking-removal path; see [`../40-ADAPTERS/governance.md` §4.4](../40-ADAPTERS/governance.md))* | all 11 | multi-tenancy, classified/compartmented, CRM sharing, purpose-based access. Propagation itself is a common mechanism (Snowflake tags, Atlas plus Ranger); what is hard is complete lineage and governed declassification, which planetar lacks |
| 2 | **Manifest compiler / binder** (12 §4 — spec-only today) | foundational | the entire per-client composition thesis; nothing composes without it |
| 3 | **Declarative Flow/automation engine** (R14 + Temporal + action-graph compiler) | ~8 | Flow/Process/Approvals/Journeys/Automate/Workshop-logic |
| 4 | **Analytics/OLAP + report builder** (R9 clickhouse/duckdb + Superset) | ~6 | Contour/Quiver/Reports/Dashboards/CRMA/Calculated-Insights/forecasting |
| 5 | **Vector + LLM gateway + embeddings** (R7 + model gateway) | ~5 | all AIP/Agentforce/RAG/semantic-search/visual-reID |
| 6 | **Graph engine binding** (R5 falkordb/neo4j) | Gotham, fincrime, CRM graph | shortest-path, ring/subgraph, link analysis at scale |
| 7 | **Search engine binding** (R4 opensearch; rebind doibio ES) | ~5 | Object Explorer / global search / resolver blocking |
| 8 | **Config-driven UI builder** (Workshop / Lightning App Builder / Experience Cloud) | ~5 | no-code app + portal surfaces (today hand-coded React) |
| 9 | **Connectors-at-breadth** (Airbyte/Singer behind detector SDK) | ~4 | the connector long tail (Foundry's docs nav listed 213 connector slugs on 2026-11-06, an upper bound; today: 4 detectors + CSV + webhooks) |
| 10 | **Apollo-class delivery** (today pm2) | deploy | multi-env zero-downtime, air-gapped signed bundles, fleet |

## A recurring spine-coherence note (surfaced by the adapter code)

Writing the adapters revealed that [`12-ADAPTER-CONTRACT.md`](../12-ADAPTER-CONTRACT.md) fully specifies only ~8 ports; **R8/R9/R10/R11/R12/R13 ports, the canonical `spine/model.ts` types, `FieldFilter`, binder pool-multiplexing, `ObjectIndex.searchCandidates/remove`, and the R2-vs-R14 default asymmetry are referenced but not yet pinned.** Several adapters had to assume shapes. This is **Phase 0** in the roadmap — lock the contracts before building from the specs.
