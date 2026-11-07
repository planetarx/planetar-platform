# 91 — Session Handoff (2026-06-09 → 2026-06-10)

Everything decided, built, verified, and queued across the two-day session that created this repo. Written at session end (2026-06-10) so the next session — or a human reader — can pick up without the conversation.

---

## 1. What this is

**One platform that does everything Palantir does (Foundry · Gotham · AIP · Apollo) AND everything Salesforce does, composed per client from pluggable datastores over one custom semantic spine.** The repo is both the **design** (parity matrix, role catalog, client architectures, adapter sample code) and a **runnable zero-dependency core** that proves the mechanism.

The central idea that makes "track everything in the world, a different architecture per client" buildable by one person: **Foundry, Gotham, and Salesforce are not three products — they are different *role footprints and surfaces* over one semantic spine.** Parity = covering role-compositions, not porting ~584 features one at a time.

## 2. The four locked decisions (user, 2026-06-09)

1. **Deliverable** = design repo + sample code (implementation built *from* it, reusing the planetar-* repos + curated OSS).
2. **Datastore model** = **capability → role → engine manifest**: 14 storage roles (R1 canonical-store … R14 work-queue) with checkable contracts; each client's manifest binds a concrete engine per role. redis/sqlite/postgres/mysql/kafka/spanner all sit behind role adapters.
3. **Build philosophy** = **custom spine + OSS breadth**. Spine (the moat): zmesg envelope, planetar-broker bus, canonical data model, ontology semantic/kinetic layers, identity resolution, governance propagation. OSS (the coverage): storage engines, graph, search, vector, lineage, auth/policy, pipelines, BI. Spine code imports only role-port interfaces, never engine drivers.
4. **Reference clients** = all four: maritime/defence (planetar), biotech/research CRM (doibio), generic enterprise CRM+ops, intel/financial-crime graph.

## 3. What exists on disk (this repo)

### Design (~11k lines, mostly workflow-generated 2026-06-09)
- Keystone (hand-written): `README` · `00-ARCHITECTURE-OVERVIEW` (8 planes P0–P8) · `10-STORAGE-ROLES` ⭐ (the 14 roles + contracts) · `11-CAPABILITY-ROLE-MAP` ⭐ (role footprints) · `12-ADAPTER-CONTRACT` (ports) · `13-CLIENT-MANIFEST` (the per-client artifact).
- `20-PARITY-MATRIX/` — **584 features** (236 Palantir + 348 Salesforce) → plane → roles → spine/OSS component → status. Scorecard: **109 built (~19%) · 15 donor (~3%) · 189 partial (~32%) · 230 designed (~39%) · 41 planned (~7%)**; 51% built or partial. The README there ranks the **ten cross-cutting gaps** (#1 marking-propagation+FLS, #2 manifest compiler, #3 flow engine, #4 OLAP/report builder, #5 vector+LLM gateway, …).
- `30-CLIENTS/` — the 4 reference architectures, each a full manifest + Mermaid topology + reuse-vs-build.
- `40-ADAPTERS/` — production-engine sample code (postgres-multiplex, spanner/cockroach, kafka/redis-streams/NATS, opensearch, falkordb/neo4j, minio+pgvector/qdrant, timescale/clickhouse + zero-copy federation, marquez/keycloak/OPA).
- `90-ROADMAP.md` — dependency-ordered Phases 0–7 with progress annotations.

### Runnable (~3k lines, hand-written, zero npm dependencies, Node ≥22.18)
- `spine/` — `model.ts` (canonical types incl. markings), `ports.ts` (all 14 role ports + Adapter lifecycle + MarkingResolver), `contracts.ts` (ROLE_CONTRACT + `satisfies()` + binder + BoundPlatform), `capabilities.ts` (footprints), `compiler.ts` (**the manifest compiler**), `conformance.ts` (shared per-port suite), `governance.ts` (**MarkingPolicy PEP + Session governed reads + propagate()**), `kinetic.ts` (**Action-Type executor**), `flows.ts` (**declarative flow engine**), `json.ts`/`asyncqueue.ts` (helpers).
- `adapters/` — 15 zero-service adapters: sqlite ×6 (canonical-store, object-index, work-queue, graph, analytics-olap, timeseries-geo), file ×2 (stream-WAL, vector), fs ×3 (blob-cas, audit-log hash-chained, lineage), memory cache, git-fs registry, internal policy, **broker** (TCP wrapper with a zmesg codec verified against `zmesg.h`).
- `boot/` — `boot.ts` + 2 manifests, `conformance.ts`, `governance.ts`, `automation.ts`; `tools/review-workflow.js` (see §6).

### Verification state at session end (all green before the machine wedge, §7)
| Command | Result | Proves |
|---|---|---|
| `npm run boot:edge` | **9/9** | maritime edge client (9 roles, air-gappable) boots from its manifest |
| `npm run boot:enterprise` | **13/13** | generic CRM client (13 roles: +graph/vector/cache/olap) boots from the SAME spine — only the manifest differs |
| `npm run conformance` | **14/14** | every adapter passes the shared per-port suite, incl. broker zmesg codec round-trip |
| `npm run governance` | **8/8** | marking defined once at a source propagates along lineage; row-filter + FLS redaction per principal |
| `npm run automation` | **8/8** | flows-as-data: condition → case creation → precondition-guarded action → durable role-gated approval → audit chain |
| `npm run typecheck` | clean | whole repo under `tsc --strict` with `@types/node` |

Runtime notes (hard-won): Node 22 type-stripping demands **erasable-only TS** (no enums/param properties) and **explicit `.ts` extensions** on relative imports; `node:sqlite` needs `--experimental-sqlite`; bigint ns timestamps need the `jstr/jparse` `__big` envelope.

## 4. Phase status (maps to `90-ROADMAP.md`)

- **P0 contracts** ✅ — plus the open finding it answered: **zmesg v1 has NO markings field** (only a flags byte), so markings cannot ride the broker header today → needs a zmesg v2 field or markings-in-payload. (The `file` stream engine preserves markings as JSON.)
- **P1 compiler + conformance** ✅ — under/over-provisioning is a compile error; guardrail demonstrably rejects a non-durable R3 engine.
- **P2 second client** ✅ (zero-service tier) — role selectivity proven; production engines remain sample code until services+drivers exist.
- **P3 propagating security** ✅ core — in-process `MarkingPolicy`; production swap = Keycloak+OPA behind the same ports. Remaining: PEP enforcement inside *every* adapter (today only the read `Session`), read-audit breadth, SIEM export.
- **P4 declarative automation** ✅ core — one mechanism covers SF Flow + Approvals + Foundry Automate + Omni-Channel work items. Remaining: Temporal for long-running, scheduled triggers, visual builder surface, report-builder surface.
- **P5 AI plane / P6 graph+geo engines / P7 builders+connectors+Apollo** — next (see §8).

## 5. Insights worth not losing

- **A human decision and a sensor reading are both just envelopes on the bus.** Ingest (4.1) and kinetic writes (4.2) share one path; every store is a rebuildable projection of R3. That symmetry is why engines are swappable.
- **The manifest compiler is the product.** Before P1 it was the unnamed missing mechanism in `ROADMAP-palantir-parity.md`; "a different architecture per client" is exactly one validated JSON file per client.
- **Role collapse is the economics.** One postgres can serve R1+R4+R7+R8+R9+R11+R14; one sqlite file serves an edge box. The capability→role footprint computes the *minimum* engine set per client.
- **Governance composes from three primitives** (markings on data, lineage closure, PEP-at-adapter) — propagation is ~40 lines once those exist. The moat is the wiring, not any one piece.
- **AIP/Agentforce containment falls out of P7**: agents get the registered Action Types and nothing else. Phase 5 is mostly an agent loop + LLM-gateway port over machinery that now exists.
- **doibio's real donations** were the identity-resolution shape, the event-sourced-vault pattern, and the 35-schema object model — not code lift.

## 6. IN FLIGHT: the adversarial review (relaunch this first)

A 6-lens adversarial review of the runnable code (correctness, concurrency, **governance-bypass**, contract-drift, data-integrity, robustness; every finding attacked by skeptic verifiers) was launched and then **stopped mid-verify** by the machine wedge (§7). Its same-session resume cache is lost, but the script is preserved: **`tools/review-workflow.js`** — relaunch with `Workflow({scriptPath: '<repo>/tools/review-workflow.js'})`.

**Known suspects seeded into it (expect confirmations; fix these even if the review isn't rerun):**
1. `SqliteObjectIndex` ignores `markings` → **search/searchCandidates leak restricted entity ids** to low-clearance callers (R4 is not yet a PEP).
2. `FlowEngine` `createEntity` writes **directly to the store, bypassing the kinetic gate** (un-governed write path).
3. Pending approvals live in an **in-memory Map** → not restart-durable despite the R14 work item (resume state must be rebuilt from the queue payload).
4. `boot.ts` `rmSync('./.data')` wipes **all** demos' data (collateral across manifests).
5. `FlowEngine.stop()` doesn't unblock the awaited subscribe iterator until the next envelope arrives.
6. `BrokerStream`: unhandled socket `error` on the pub path; subscribe sockets never closed by `close()`.
7. `propagate()` re-stamps entities in R1 but **not their object-index copies** → stale searchable rows.

> **Update 2026-10-06:** suspects **1, 2 and 7 are closed** by the governed-ports work ([`docs/specs/2026-10-06-governed-ports-design.md`](./docs/specs/2026-10-06-governed-ports-design.md); `npm run governance` 70/70), together with a hole this list missed: an entity derived *after* its source was marked did not inherit the marking. Four more leaks of the same family were found by review and closed in the same work: raw storage columns and unmarked tables reachable through analytics-olap, a protected value readable in an action's audit detail and event payload, engine filters usable as an oracle on graph and vector, and unmarked work-queue jobs claimable by any principal (the queue is now system-only). Also fixed, and not on this list: concurrent transactions on the sqlite canonical store failed with a nested `BEGIN` (they now queue). A whole-branch review then found and closed: an existence oracle through `createEntity`, a propagation audit record readable by someone lacking a stamped entity's other markings, unknown projection rows counted as withheld in a reader's own trail, a lost field write when a propagation raced a write on an asynchronous engine (`addMarkings` + never-shrink upsert), a `null` clearance passing the in-engine filters, unredacted graph node fields, and raw protected fields reaching the index through the system handle. Suspects 3–6 are still open. The review workflow was not rerun.

## 7. The machine wedge (why the session ended)

From ~16:00 on 2026-06-10, **every freshly spawned shell hung before executing** (even `uptime`), while harness file ops kept working. Began during the review fleet's verify stage but **persisted after all load was shed** → external cause; signature matches shell profile init blocking on a stale/slow mount (prime suspect `~/data`) — or session-local shell-spawn corruption, since the user later believed the machine had recovered while this session's spawns still hung. All five checks were green *before* the wedge; no code state was lost.

## 8. Next-step queue (priority order)

1. **`git init` + first commit** of this repo — ~14k lines with no version control is the most overdue safety move.
2. **Relaunch the review** (`tools/review-workflow.js`) → triage confirmed findings → fix → re-run all six checks. Or skip straight to fixing §6's seven suspects.
3. **Phase 5: AI-plane core** (zero-dep buildable): agent loop whose only tools are registered Action Types; `llm-gateway` port (metered/audited/marking-gated) + mock engine; HITL approval inbox reusing flow approval gates; `boot/agent.ts` proof.
4. **Wire the real stack** (needs broker process — the *server agent* owns it, this session must not start/kill it): live `BrokerStream` integration; point `SqliteCanonicalStore` at the live 7.3 GB planetar-ontology DB.
5. **Production engines** (needs services + `npm install`): postgres-multiplex first → biotech-CRM manifest on real services; then redis/opensearch/minio; later Keycloak+OPA, Temporal, kafka, spanner, clickhouse.
6. **Surfaces**: flow-builder + report-builder UIs over the Object API; Apollo-style delivery to replace pm2.

## 9. Pointers

- Durable memory: `~/.claude/projects/-home-sness-github-planetarx/memory/project_planetar_platform.md` (kept current through session end).
- Strategy lineage: `~/data/vaults/docs/ROADMAP-palantir-parity.md` (the why) + `ARCH-canonical-data-model.md` (the what) — this repo is the how.
- A sibling session added `project_distributed_disruptor.md` (clock-sequenced LMAX rings + HLC + Spanner as north star) — future R3/R1 scale work should reconcile with the role contracts here.
- The CH13 proposal context (planetar/, deadlines) is historical; this platform is the post-submission build.
