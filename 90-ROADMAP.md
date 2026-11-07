# 90 — Implementation Roadmap

How to get from "19% built / 51% built or partial" to broad Palantir+Salesforce parity, **dependency-ordered**. The ordering is driven by the ten cross-cutting gaps ([`20 §scorecard`](./20-PARITY-MATRIX/README.md)) — not the per-feature long tail — because each phase unblocks dozens of features at once.

Principle (from `ROADMAP-palantir-parity.md`): **mechanism before breadth, governance before connectors.** Don't build the 200-connector long tail before there's governed lineage for it to land in.

---

## Phase 0 — Lock the spine contracts (coherence pass) · *prerequisite*

Writing the adapters revealed contract drift: the ports and canonical types must be pinned before any code is built *from* these specs.

- Author `spine/model.ts`: `CanonicalEntity`, `Observation`, `Link`, `Identifier`, `Source`, `Event`, `Discrepancy`, `EntityId`, `TypeName`, `FieldFilter`, `Page`, `Tx`, `HealthStatus` — the types every port speaks. (Promote from `ARCH-canonical-data-model.md` + the live `planetar-ontology` shapes.)
- Promote the R8/R9/R10/R11/R12/R13 port interfaces from the adapter files into `12-ADAPTER-CONTRACT.md` (or dedicated `spine/ports/*.ts`).
- Reconcile the deltas adapters needed: `ObjectIndex.searchCandidates()`+`remove()`, binder **pool-multiplexing** (one `pg` serving R1+R4+R7+R8+R14), the **R2-may-default / R14-may-not** asymmetry in the compiler, `ownsExecution` flag (Temporal), serializable-retry wrapper (CRDB/Yugabyte).
- Verify **markings field placement** in the frozen 66-byte `zmesg` header (governance depends on ingest-time stamping).

**Exit:** every port + type has one authoritative definition; the generated adapters compile against it. ~1–2 weeks.

> **Progress (2026-06-09):** the contract core is authored and type-checks clean → [`spine/model.ts`](./spine/model.ts) (canonical types), [`spine/ports.ts`](./spine/ports.ts) (all 14 role ports + `Adapter` + `MarkingResolver`), [`spine/contracts.ts`](./spine/contracts.ts) (`ROLE_CONTRACT` + `satisfies()` + binder skeleton). Remaining P0: verify markings placement in the frozen `zmesg` header; reconcile the 40-ADAPTERS sample code to import these exact symbols.

---

## Phase 1 — The manifest compiler + conformance harness · *the mechanism (gap #2)*

Make capability→role→engine actually run. This is the single highest-leverage build: without it, "per-client architecture" is paper.

- Implement the compiler/binder of [`12 §4`](./12-ADAPTER-CONTRACT.md) + [`13 §2`](./13-CLIENT-MANIFEST.md): parse manifest → resolve capabilities to required roles → contract-check → bind adapters → emit topology Mermaid.
- Build the shared **conformance suite** per port; make the **already-built** adapters pass: `SqliteCanonicalStore` (wraps `planetar-ontology`), `BrokerStream`, `FsBlobCas`, in-proc cache, sqlite work-queue.
- **Proof:** the maritime **edge** manifest boots the existing planetar stack *from a manifest*, zero new external services.

**Exit:** the thesis runs end-to-end on already-built code. ~2–4 weeks.

> **DONE (2026-06-09):** the compiler + binder + contract-check + topology emit are implemented in [`spine/compiler.ts`](./spine/compiler.ts) + [`spine/capabilities.ts`](./spine/capabilities.ts), and **9 zero-service adapters** (sqlite canonical-store/object-index/work-queue, file stream, fs blob-cas/audit-log/lineage, git-fs registry, internal policy-identity) are built and registered. [`boot/boot.ts`](./boot/boot.ts) compiles [`boot/manifests/maritime-edge.json`](./boot/manifests/maritime-edge.json) and runs **9/9** end-to-end smoke checks through the spine ports; the contract guardrail correctly **rejects** a non-durable engine for R3. The whole repo (spine + adapters + boot) type-checks clean under `tsc --strict` with `@types/node`.
> **P1 ALSO DONE:** the **`broker` TCP stream adapter** ([`adapters/broker/stream.ts`](./adapters/broker/stream.ts)) is written with a correct zmesg codec (verified against `zmesg.h`), and the **shared conformance suite** ([`spine/conformance.ts`](./spine/conformance.ts)) passes **14/14** adapters (incl. the broker codec round-trip). Finding: zmesg v1 has no markings field, so markings can't ride the broker header today (the answer to the P0 "verify markings placement" item). Remaining P1: a live broker integration run (needs the broker process) + porting `SqliteCanonicalStore` to wrap the live `planetar-ontology` 7.3 GB store.

---

## Phase 2 — Bind the breadth-unlocking engines · *standard-tier (gaps #4,#7 partial)*

One `postgres` multiplexed across roles turns the edge stack into a real single-cloud platform.

- `PostgresCanonicalStore` (R1) + the multiplex: R4 (tsvector/GIN), R7 (pgvector), R8 (timescale+postgis), R14 (SKIP LOCKED) on one pool.
- `RedisCache` (R2); `OpenSearchIndex` (R4) for higher search volume; `MinioBlobCas` (R6).
- Rebind doibio's Elasticsearch onto the R4 port; project doibio's vault→bus→`postgres`.

**Exit:** biotech-CRM + generic-enterprise **standard** manifests boot. Most "partial" CRM/object/search rows flip to built. ~3–5 weeks.

> **PROGRESS (2026-06-09):** the **generic-enterprise** client now boots — `npm run boot:enterprise` → **13/13** checks — on the same spine/compiler as the edge, binding **13 roles** (adds graph, vector, hot-cache, analytics-olap; omits timeseries-geo). 5 more zero-service adapters added + conformant: `memory` cache (R2), `file` vector (R7), `sqlite` graph (R5, recursive-CTE traversal + shortest-path), `sqlite` analytics-olap (R9, GROUP BY over the live entity table), `sqlite` timeseries-geo (R8, haversine geo-within). This proves edge→standard / role-selectivity on one codebase. Remaining P2: the **production** engine adapters (postgres-multiplex, redis, opensearch, minio, kafka, spanner, clickhouse) — written as sample code in [`40-ADAPTERS/`](./40-ADAPTERS/), become runnable once a deploy provides the services + drivers (the runnable repo stays zero-dependency until then).

---

## Phase 3 — Governance: propagating security · *the moat + gap #1*

The #1 blocker across all 11 slices, and the hardest-to-clone differentiator. Do it **before** connectors.

- Marking model (envelope field + store columns); `MarkingResolver` consulted at every adapter PEP.
- R12 lineage: `MarquezLineage` adapter + the **propagation engine** (union+stamp markings down the downstream closure).
- R13: `KeycloakOpaPolicy` (authn + default-deny Rego PDP); FLS + row-level sharing; purpose-based access.
- Read-auditing (not just write/action) → R11 hash-chained + SIEM export.

**Exit:** multi-tenant / classified / CRM-sharing unblocked; the largest "designed" cluster flips. ~6–10 weeks.

> **PROGRESS (2026-06-10):** the propagating-security **core is built and runs** — `npm run governance` → **8/8**. [`spine/governance.ts`](./spine/governance.ts) ships `MarkingPolicy` (a real PEP: no-read-up mandatory access control + per-field FLS redaction), `Session` (per-principal governed reads — row filter + field redaction over the canonical store), and `propagate()` (stamps a marking down the lineage closure). [`boot/governance.ts`](./boot/governance.ts) demonstrates the moat end-to-end: a restriction defined **once at a source** propagates along lineage to a derived entity, after which a low-clearance principal can no longer see that row while a high-clearance principal still can, and an FLS field stays redacted for the low principal throughout — all audited. Markings now ride `CanonicalEntity`/`Observation` ([`spine/model.ts`](./spine/model.ts)). Remaining P3: swap the in-process policy for **Keycloak (authn/SSO/SCIM) + OPA (Rego PDP)** behind the same `PolicyIdentity`/`MarkingResolver` ports (needs those services); enforce the PEP inside every adapter (not just the read `Session`); read-auditing breadth + SIEM export.

> **PROGRESS (2026-10-06):** enforcement moved from one helper class to **a gate over every role** — `npm run governance` → **70/70** (adversarial suite, [`spine/governance-conformance.ts`](./spine/governance-conformance.ts)). `BoundPlatform.role()` is gone: callers take `platform.as(principal)` ([`spine/governed.ts`](./spine/governed.ts)) or `platform.system(component)` ([`spine/system.ts`](./spine/system.ts)). Closed: search/count/graph/vector/track/stream/audit leaks, the flow engine's un-gated write, stale index copies after propagation, and derivations made after a source was marked. Design: [`docs/specs/2026-10-06-governed-ports-design.md`](./docs/specs/2026-10-06-governed-ports-design.md). Remaining P3: Keycloak + OPA behind the same ports; in-engine enforcement in the production adapters; the live `planetar-ontology` service; markings on the `zmesg` wire; SIEM export formats.

---

## Phase 4 — Automation + analytics breadth · *gaps #3,#4*

The two biggest fan-out gaps across the Salesforce clouds + Foundry.

- R14 **Temporal** adapter + the declarative **Flow/journey → Action-Type compiler** (visual trigger→action graph). Unblocks Flow/Process/Approvals/Journeys/Automate/Workshop-logic/Omni-Channel routing.
- R9 **clickhouse/duckdb** adapters + a **report/dashboard builder** surface (Superset-embedded or native). Unblocks Reports/Dashboards/Contour/Quiver/CRMA/Calculated-Insights/forecasting roll-ups.

**Exit:** the bulk of Sales/Service/Marketing/Data-Cloud + Foundry analytics flips. ~8–12 weeks.

> **PROGRESS (2026-06-10):** the **declarative automation core is built and runs** — `npm run automation` → **8/8**. [`spine/kinetic.ts`](./spine/kinetic.ts) is the P7 executor: registered `ActionTypeDef`s (typed params, preconditions, effects, marking gates) invoked through authorize → preconditions → atomic effects → audit + bus event; this is the **only** write path flows/agents use. [`spine/flows.ts`](./spine/flows.ts) is the flow engine: a `FlowDef` is **pure data** (stream trigger + condition/createEntity/action/approval steps with `{from:'payload.x'}` bindings), registered in R10 like a schema, executed off the bus, with **approval gates parked as durable R14 work items** that a role-gated human resumes — the approved action runs *as the approver*. [`boot/automation.ts`](./boot/automation.ts) proves the dark-vessel-response flow end-to-end: condition gate, case auto-creation, precondition-guarded flagging, omni-channel-claimable approval, analyst denied / supervisor approved, full audit chain. This is one mechanism covering SF Flow + Approval Processes + Foundry Automate + Omni-Channel work items. Remaining P4: Temporal adapter for long-running orchestration; the visual flow-builder *surface*; scheduled triggers; R9 report-builder surface (the sqlite OLAP adapter already serves `boot:enterprise`).

---

## Phase 5 — AI plane · *gap #5*

Containment already exists (agents act only through Action Types); add the rest.

- R7 vector adapters (pgvector/qdrant) + embeddings pipeline; the **LLM gateway** (metered, gated, audited model-call boundary — the highest-leverage single AIP piece).
- Agent runtime/planner + tool-schema exporter + **HITL approval inbox** (R14); evals/observability (R9 + R12).

**Exit:** AIP/Agentforce/RAG/semantic-search/visual-reID flip from designed. ~6–10 weeks.

---

## Phase 6 — Graph + geo specialty · *gaps #6, geo*

- R5 `FalkorDB`/`Neo4j` adapters (shortest-path, ring/subgraph) behind the built `GraphStore` port — Gotham graph/Vertex, fincrime rings, CRM collaboration graph.
- R8 geo-playback (timescale+postgis) → Gotham Geotime/Gaia, SF Maps, the planetar Timeline tab.

**Exit:** Gotham + financial-crime graph slices flip. ~4–6 weeks.

---

## Phase 7 — Surface builders + connectors + Apollo · *gaps #8,#9,#10 (the long tail)*

- Config-driven **app builder** (Workshop / Lightning App Builder / Experience Cloud) over the Object API — replaces hand-coded React surfaces.
- **Connectors-at-breadth**: Airbyte/Singer fleet behind the P2 detector SDK (the 200-connector tail).
- **Apollo-class delivery**: constraint-based rollout, air-gapped signed bundles, fleet management (replaces pm2).

**Exit:** the remaining breadth + enterprise deploy story. Ongoing.

---

## Dependency graph (why this order)

```
P0 lock contracts ─► P1 compiler ─┬─► P2 standard engines ─► P4 automation+analytics ─┐
                                  │                          P5 AI plane ─────────────┤─► P7 builders+connectors+Apollo
                                  └─► P3 governance ─────────► (gates multi-tenant) ───┘
                                                          P6 graph+geo (parallel after P2)
```

- P1 needs P0. Everything needs P1 (the mechanism).
- P3 governance is sequenced before P7 connectors (the roadmap's explicit "don't ETL into ungoverned lineage" rule).
- P4/P5/P6 are largely parallelizable once P2 lands.

## Mapping to the existing roadmap

This refines `ROADMAP-palantir-parity.md` (ontology ✅ → kinetic ✅ → lineage+security → connectors → Apollo) by inserting the **manifest compiler (P1)** as the missing mechanism it didn't name, and by sequencing the **OSS breadth engines** (P2) and the **automation/analytics/AI fan-out** (P4/P5) that the parity matrix showed dominate the backlog.
