# Planetar Platform — Design Repository

**One platform that aims to do everything Palantir does (Foundry · Gotham · AIP · Apollo) *and* everything Salesforce does — composed per client from pluggable datastores, over a single custom semantic spine.**

This repository is a **design artifact**, not (yet) the implementation. It contains the reference architecture, the Palantir + Salesforce **parity matrix**, the **capability→role→engine** composition model, and **runnable sample code** for every layer and storage adapter. The implementation is built *from* these specs (reusing the already-built spine repos and a curated set of open-source projects).

> Status legend used throughout: ✅ built · 🟡 partial/designed · 🔲 planned · ⭐ keystone (read first)

---

## The thesis in one paragraph

Palantir's moat is **one semantic Ontology** that data-engineering, apps, security, and AI all speak — decoupled from storage. Salesforce's moat is a **metadata-driven platform** where objects, automation, UI, and permissions are configuration, not code. We already have the hard, custom parts of both: a nanosecond message **bus**, a frozen **envelope**, a **canonical data model**, a working **ontology** (semantic + kinetic + Object API), and a generic **identity-resolution** engine. What's missing — and what this repo designs — is the layer that lets **each client compose a different physical architecture** (redis + postgres + kafka here, sqlite + files air-gapped there, spanner + clickhouse at global scale) **without changing the semantic model or the application code**. That layer is the **capability→role→engine manifest**.

---

## The two halves: Spine (custom) + Breadth (OSS)

| | **Spine — custom, the moat** | **Breadth — open-source, the coverage** |
|---|---|---|
| What | Envelope, Bus, Canonical Model + Registry, Ontology (semantic/kinetic/governance), Identity Resolution | Storage engines, connectors, graph, search, vector, lineage, auth/policy, pipelines, BI, deploy |
| Why custom/OSS | These define the contract everything else speaks; performance + correctness are the differentiator | Solved problems with mature OSS; reinventing them is waste and slows breadth |
| Examples | `zmesg`, `planetar-broker`, `planetar-ontology`, `planetar-registry`, doibio identity-resolution | redis, sqlite, postgres, mysql, kafka/redpanda, spanner, opensearch, falkordb/neo4j, duckdb/clickhouse, minio/s3, pgvector/qdrant, OpenLineage/Marquez, Keycloak, OPA, Airbyte, dbt |

Decision (locked): **custom spine + OSS breadth.** The spine never depends on a specific engine; every engine sits behind a **storage-role adapter** (a *port*). See [`00-ARCHITECTURE-OVERVIEW.md`](./00-ARCHITECTURE-OVERVIEW.md).

---

## Repository map

| Path | Contents | Status |
|---|---|---|
| [`00-ARCHITECTURE-OVERVIEW.md`](./00-ARCHITECTURE-OVERVIEW.md) | The plane model, spine/breadth layering, design principles, request lifecycles | ⭐ |
| [`10-STORAGE-ROLES.md`](./10-STORAGE-ROLES.md) | **The storage-role catalog** — the canonical set of roles every capability decomposes into, with contracts | ⭐ keystone |
| [`11-CAPABILITY-ROLE-MAP.md`](./11-CAPABILITY-ROLE-MAP.md) | How any Palantir/Salesforce capability decomposes into storage roles; worked examples | ⭐ keystone |
| [`12-ADAPTER-CONTRACT.md`](./12-ADAPTER-CONTRACT.md) | The adapter (port) interfaces per role + a reference adapter implementation | ⭐ |
| [`13-CLIENT-MANIFEST.md`](./13-CLIENT-MANIFEST.md) | The per-client manifest schema (assigns engines to roles) + validation + a worked example | ⭐ |
| [`spine/`](./spine/README.md) | **Real TypeScript** of the locked contracts: `model.ts`, `ports.ts` (14 role ports), `contracts.ts` (binder), `compiler.ts`+`capabilities.ts` (manifest compiler), `conformance.ts`, `governance.ts` + `governed.ts` + `system.ts` (policy, the read gate over every role, and the write-side marking invariants), `kinetic.ts` (Action Types), `flows.ts` (declarative automation). Type-checks clean. | ✅ Phases 0–4 |
| [`adapters/`](./adapters/) | 15 runnable zero-service adapters (sqlite ×6, file ×2, fs ×3, memory, git-fs, internal, broker-over-node:net) registered into the binder; all 14 conformant | ✅ Phase 1 + 2 |
| [`boot/`](./boot/README.md) | Runnable proofs: `boot:edge` (9/9), `boot:enterprise` (13/13), `conformance` (14/14), `governance` (70/70), `automation` (8/8) | ✅ runnable proof |
| [`20-PARITY-MATRIX/`](./20-PARITY-MATRIX/README.md) | Palantir + Salesforce feature parity: 584 features → spine/OSS component → storage roles → status | ✅ 11 slices + scorecard |
| [`30-CLIENTS/`](./30-CLIENTS/README.md) | The 4 reference client architectures, each a full manifest + topology + sample code | ✅ 4 clients |
| [`40-ADAPTERS/`](./40-ADAPTERS/README.md) | Per-engine adapter sample code (redis, sqlite, postgres, mysql, kafka, spanner, …) | ✅ 9 adapter sets |
| [`90-ROADMAP.md`](./90-ROADMAP.md) | Dependency-ordered implementation plan (Phase 0–7) | ✅ |
| [`91-HANDOFF.md`](./91-HANDOFF.md) | **Session handoff (2026-06-10)**: decisions, verification state, insights, in-flight review + known suspects, next-step queue — read this to resume work | ✅ |
| `examples/` | Runnable sample code referenced by the docs | 🔲 |

## Parity at a glance

584 Palantir + Salesforce features cataloged → **109 built (~19%) · 15 doibio-only donor (~3%) · 189 partial (~32%) · 230 designed (~39%) · 41 planned (~7%)**. Built or partial covers 51% overall, 47% for Salesforce. Statuses describe planetar's side, not mechanism equivalence. Full scorecard + the ten cross-cutting gaps: [`20-PARITY-MATRIX/README.md`](./20-PARITY-MATRIX/README.md). Build sequence: [`90-ROADMAP.md`](./90-ROADMAP.md).

---

## The four reference clients (anchors for the design)

Each is a different *topology* over the same spine — that's the whole point.

1. **Maritime / defence (`planetar`)** — real-time sensor fusion, geotemporal, edge/air-gapped. Gotham-leaning. *Built.*
2. **Biotech / research CRM (`doibio`)** — entity resolution, knowledge graph, Salesforce-leaning. *Built.*
3. **Generic enterprise CRM+ops** — clean Salesforce parity (sales/service/data-cloud) without domain baggage.
4. **Intel / financial-crime graph** — Gotham-style entity/link analysis, watchlists, dossiers.

Each gets a manifest in `30-CLIENTS/` that proves the same capabilities run on a different engine mix.

---

## What already exists (don't rebuild — wire in)

| Spine component | Repo / path | State |
|---|---|---|
| Envelope (`zmesg`) | `~/github/sness23/zmesg` | ✅ 66-byte LE header, UUIDv7, ns timestamps, zero-copy |
| Bus (`planetar-broker`) | `~/github/planetarx/planetar-broker` | ✅ C, SHM/TCP/UDP, WAL+CRC32 |
| Canonical model | `~/data/vaults/docs/ARCH-canonical-data-model.md` | 🟡 designed + vertical-slice proven |
| Registry (codegen) | `~/github/planetarx/planetar-registry` | ✅ vertical slice |
| Ontology (L4) | `~/github/planetarx/planetar-ontology` | ✅ semantic+kinetic, Object API, identity res |
| Identity resolution | doibio `src/lib/identity-resolution.ts` (631 LOC) → ported into ontology | ✅ |
| CRM donor | `~/data/dev/doibio` | ✅ 35 schemas, event-sourced vault→SQLite, ~120 REST routes, ~20 React apps |
| Shell (L5) | `~/github/planetarx/planetar-ui` | 🟡 4-pane, Object-API wired |

See [`20-PARITY-MATRIX/`](./20-PARITY-MATRIX/) for the full mapping of these onto the ~80 Palantir + ~150 Salesforce features.

---

## How to read this repo

1. Start with [`00-ARCHITECTURE-OVERVIEW.md`](./00-ARCHITECTURE-OVERVIEW.md) for the plane model.
2. Read [`10-STORAGE-ROLES.md`](./10-STORAGE-ROLES.md) and [`11-CAPABILITY-ROLE-MAP.md`](./11-CAPABILITY-ROLE-MAP.md) — these are the keystone that makes per-client composition work.
3. Read [`12-ADAPTER-CONTRACT.md`](./12-ADAPTER-CONTRACT.md) and [`13-CLIENT-MANIFEST.md`](./13-CLIENT-MANIFEST.md) to see how engines plug in and how a client is described.
4. Then pick a client in `30-CLIENTS/` to see it all composed end-to-end.
