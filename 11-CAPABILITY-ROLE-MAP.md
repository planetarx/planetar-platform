# 11 — Capability → Role Map ⭐ (keystone)

This document shows how **any** Palantir or Salesforce capability decomposes into the planes ([`00`](./00-ARCHITECTURE-OVERVIEW.md)) and storage roles ([`10`](./10-STORAGE-ROLES.md)). Parity is achieved by **covering the role-compositions**, not by porting features one at a time — most features reuse the same handful of roles.

This is also what lets a client bind *only the roles it uses*: a maritime edge node that never does columnar reporting simply never binds R9; the manifest compiler confirms no required capability needs it.

---

## 1. The decomposition method

For any capability, ask four questions:

1. **Which plane owns it?** (P2–P8, or cross-cutting P0/P1) — determines whether it's spine code, an OSS component behind an adapter, or a surface.
2. **Which roles does it *require*?** — these MUST be bound in the manifest for the capability to function.
3. **Which roles does it *enhance*?** — optional bindings that improve it (e.g. R7 vector makes search semantic; without it, search is still keyword via R4).
4. **What's the spine vs. OSS split?** — what we own vs. what we wire in.

A capability is "covered" when all its **required** roles have a conforming adapter and the owning plane has an implementation (spine or OSS).

---

## 2. Worked decompositions (representative cross-section)

Roles use the R-numbers from [`10`](./10-STORAGE-ROLES.md). **Required** roles in **bold**; *enhancing* roles in italics.

| Capability (source) | Plane | Required + *enhancing* roles | Spine vs OSS |
|---|---|---|---|
| **Custom/standard objects + CRUD** (SF) | P4,P6 | **R1**, **R10**, *R4* | spine: canonical model + ontology; OSS: postgres |
| **Object Explorer / list views / search** (Foundry, SF Einstein Search) | P6,P8 | **R4**, **R1**, *R7*, *R2* | spine: Object API; OSS: opensearch + (pgvector) |
| **Link analysis / graph / dossiers** (Gotham, SF) | P6,P8 | **R5**, **R1**, *R4* | spine: ontology link types; OSS: falkordb |
| **Identity resolution / entity res** (Foundry, Data Cloud, Gotham) | P5 | **R1**, **R4** (blocking), **R12**, *R7* (fuzzy/visual) | **spine** (the moat); OSS: opensearch, pgvector |
| **Action Types / kinetic writes** (Foundry, the only write path) | P7 | **R10**, **R1**, **R11**, **R3**, *R13* | **spine** (executor); OSS: OPA for the gate |
| **Streaming ingestion / Platform Events / CDC** (Foundry, SF) | P2,P3 | **R3** | spine: broker + envelope; OSS: kafka alt |
| **Data Connection (200+ connectors)** (Foundry) | P2 | **R3**, *R6* (raw landing) | spine: detector SDK; **OSS: Airbyte/Singer** |
| **Reports & dashboards / Contour / CRMA** (SF, Foundry) | P8,P9? | **R9**, **R1**, *R8* | OSS: clickhouse/duckdb + Superset/Tableau |
| **Geotemporal / Geotime / Gaia / SF Maps** (Gotham, SF) | P8 | **R8**, **R1**, *R5* | spine: track model; OSS: postgis + maplibre |
| **Media sets / imagery / FMV / Files** (Foundry, Gotham, SF) | P2,P6,P8 | **R6**, **R1**, *R7* (similarity) | spine: blob handle in envelope; OSS: minio |
| **AIP / Agentforce agents (RAG + tool use)** | P7,P8 | **R7**, **R6**, **R10**, **R7**, *R5*; writes via **R7→P7** | spine: kinetic containment; OSS: vector + LLM gateway |
| **Markings + propagating security** (Foundry) | P1 | **R12**, **R13**, **R11** | **spine** (propagation rules); OSS: OPA, marquez |
| **Flow / automation / Automate / approvals** (SF, Foundry) | P7 | **R14**, **R1**, **R3**, *R13* | spine: action triggers; OSS: temporal (long-running) |
| **Omni-Channel routing / queues** (Service Cloud) | P7,P8 | **R14**, **R2**, **R1** | OSS: postgres/redis queue; spine: routing as actions |
| **Forecasting / pipeline / opportunity** (Sales Cloud) | P4,P6,P9 | **R1**, **R9**, *R4* | spine: objects+actions; OSS: olap for roll-ups |
| **Audit / Event Monitoring** (Foundry, SF Shield) | P1 | **R11** | spine: audit envelope; OSS: clickhouse sink |
| **Sandboxes / branching / scenarios** (Foundry, SF) | P0,P6 | **R10**, **R1** (copy-on-write) | spine: scenario overlay on canonical store |
| **Zero-copy federation** (Data Cloud, Foundry virtual tables) | P9 | **R9** (federated engine) | OSS: bigquery/snowflake/databricks query-in-place |
| **Lineage / Monocle / Data Lineage** (Foundry) | P1 | **R12**, **R10** | spine: lineage emit; OSS: marquez |
| **Dark-vessel kinematic re-ID** (planetar flagship) | P5 | **R1**, **R8**, *R7* | **spine** (kinematic matcher) |

> Read the table as: *to claim parity on this feature, the client's manifest must bind every bold role, and the owning plane must have an implementation.* The full feature-by-feature version (all ~80 Palantir + ~150 Salesforce features) lives in `20-PARITY-MATRIX/`.

---

## 3. The "role footprint" of a capability

Each capability has a **role footprint** — the set of required roles. Stacking footprints for everything a client wants yields the client's **required engine set** (after collapsing roles onto shared engines). Example footprints:

```
custom-objects     = {R1, R10}                    (+R4 enhancing)
link-analysis      = {R5, R1}
identity-resolution= {R1, R4, R12}
kinetic-writes     = {R10, R1, R11, R3}
agents-rag         = {R7, R6, R10}
reporting          = {R9, R1}
geotemporal        = {R8, R1}
propagating-security = {R12, R13, R11}
```

A **CRM-only** client (custom objects + reporting + automation + audit) needs `{R1, R10, R4, R9, R14, R3, R11}` → collapses to **postgres + redis + broker** (+opensearch if search volume is high). It never binds R5/R6/R7/R8 unless it adds graph/media/AI/geo features. That's why the same platform is a 2-process edge box for one client and a 12-engine cloud for another.

---

## 4. Universality check (why the spine doesn't fork per feature)

Notice every row in §2 routes through the **same spine planes**:

- writes → **P7 kinetic** → **R3 stream** (always)
- shape → **P4 canonical model** + **R10 registry** (always)
- identity → **P5 resolution** (whenever two sources describe the same thing)
- read surfaces → **P6 ontology Object API** (always)

The roles differ; the spine contract does not. This is the structural reason one codebase can present as Foundry, Gotham, *and* Salesforce: those products are different **role footprints and surfaces over one semantic spine** — exactly the bet in `ROADMAP-palantir-parity.md`.

---

## 5. Output of this map → the manifest

For a given client we:
1. List the capabilities they need (from `20-PARITY-MATRIX/`).
2. Union their role footprints → required roles.
3. Choose an engine per required role (collapsing where contracts allow).
4. Emit a [client manifest](./13-CLIENT-MANIFEST.md); the compiler validates contracts and wires adapters.

The four worked clients in `30-CLIENTS/` each run this procedure end-to-end.
