# Parity Matrix — Palantir AIP + Apollo

This slice covers two Palantir products that bracket the *top* and the *bottom* of the stack:

- **AIP (Artificial Intelligence Platform)** — LLM-grounded reasoning, agents, semantic/RAG search, and a guardrailed tool-use surface, all bound to the **Ontology**. In our model AIP is almost entirely a **surface (P8) over the kinetic plane (P7)**: an agent never writes directly — it proposes an **Action Type**, which is validated, governed, audited, and reversible exactly like a human edit. This is the structural reason agent containment is "free" here (00 §3 principle 3): the spine already forces every write through P7→R3. The new roles AIP introduces are **R7 vector** (embeddings/RAG) and a **LLM gateway** (a P8/P2 component, not a storage role) — everything else (objects, links, actions, audit) reuses the existing ontology spine.
- **Apollo** — Palantir's continuous-delivery / fleet-management control plane: it ships versioned releases across heterogeneous, often air-gapped, environments with policy constraints and automated rollback. In our model Apollo is **pure P0 control**: it is the runtime that *executes the manifest* (13) across a fleet, plus the registry/versioning (**R10**) and audit (**R11**) that make releases governed and reversible. We have the manifest+compiler design (the thing Apollo would deliver) but **not the fleet-delivery runtime** — Apollo-class deploy is explicitly **deferred** in the inventory.

**Headline parity story.** AIP parity is *high on the semantics, deliberately thin on the model weights*: we own the containment (kinetic), grounding (ontology + R7), and audit story end-to-end and already have the Object API/Action executor an agent would call — we wire in an OSS LLM gateway and pgvector rather than train models. Apollo parity is *designed, not built*: the manifest IS the Apollo release artifact, but the multi-environment delivery/rollback runtime is a P0 component we have specified (manifest compiler + binder, 12 §4) without the fleet orchestration around it.

Role IDs (R1..R14) and plane IDs (P0..P8) are exactly as defined in [`10-STORAGE-ROLES.md`](../10-STORAGE-ROLES.md) and [`00-ARCHITECTURE-OVERVIEW.md`](../00-ARCHITECTURE-OVERVIEW.md). **Required** roles are **bold**; *enhancing* roles are *italic*.

---

## AIP — Grounding & Retrieval

| Feature | What it does | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Ontology-grounded RAG | Retrieves ontology objects/links + unstructured chunks as context so the LLM reasons over real entities, not the open web | P6, P8 | **R7**, **R1**, **R10**, *R4*, *R5* | **Spine**: ontology Object API supplies the grounded objects; **OSS**: `pgvector` (R7) for chunk KNN, `opensearch` (R4) for keyword recall | partial — ontology Object API built (`planetar-ontology/src/api/server.ts`); R7 vector store **designed** (no embedding pipeline yet) |
| Semantic search over objects | Natural-language → nearest objects/documents by embedding cosine | P6, P8 | **R7**, **R1**, *R4* | **OSS**: `pgvector`/`qdrant` (R7); spine: ontology surfaces results as typed object sets | designed — vector role specified in [`10` R7]; doibio ships Elasticsearch keyword search (`doibio/src/api.ts`) but **not** vector |
| Document/chunk vectorization pipeline | Chunks + embeds media-set documents into the vector role on ingest | P2, P5 | **R6**, **R7**, **R3**, *R10* | **Spine**: detector/blob-handle emit (bytes→R6, `{sha256}` on bus); **OSS**: embedding model + `pgvector` | planned — blob-CAS handle pattern designed (`ARCH-planetar-photos.md`); no embed pipeline built |
| Visual / acoustic re-ID embeddings | Photo↔EO↔SAR↔SAI cosine match for vessel re-identification | P5 | **R7**, **R1**, *R6*, *R8* | **Spine**: identity-resolution feeds candidates; **OSS**: `pgvector`/`qdrant` for the visual lane | partial — kinematic re-ID built (`planetar-ontology/src/resolve/kinematics.ts`); **embedding** re-ID lane designed, not built |
| Knowledge-article / context grounding | Grounds answers in curated knowledge + provenance so claims are auditable | P6, P1 | **R7**, **R1**, **R12**, *R4* | **Spine**: per-field provenance (R12) gives source-of-claim; **OSS**: pgvector + opensearch | partial — provenance built (`planetar-ontology/src/resolve/resolve.ts`); vector grounding designed |

## AIP — Agents & Reasoning

| Feature | What it does | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Agent / agent-studio runtime | Hosts multi-step LLM agents that plan, call tools, and act on the ontology | P7, P8 | **R10**, **R1**, **R11**, **R3**, *R7*, *R14* | **Spine**: kinetic Action executor is the containment (agents act only via Action Types); **OSS**: LLM gateway + `temporal` (R14) for long agent runs | designed — kinetic containment built (`planetar-ontology/src/actions/executor.ts`); agent loop + LLM gateway not built (inventory: "AIP agent studio designed via kinetic containment") |
| Tool / function calling | Exposes ontology Functions + Action Types as callable tools to the model | P6, P7 | **R10**, **R1**, *R11* | **Spine**: Object API (read tools) + Action Types (write tools) ARE the tool catalog | partial — Action Types + Object API built (`planetar-ontology/src/api/server.ts`, `actions/executor.ts`); tool-schema export for an LLM not built |
| Agent writes = guardrailed Action Types | Every agent mutation is a validated, audited, reversible Action — never a raw write | P7, P1 | **R10**, **R1**, **R11**, **R3**, *R13* | **Spine**: precondition→effect→audit→reproject path (00 §4.2); **OSS**: `OPA` (R13) for the purpose/marking gate | built (containment path) — `planetar-ontology/src/actions/executor.ts` (precondition + effect + audit envelope); **OPA** policy gate designed |
| Action proposal / human-in-the-loop | Agent proposes an Action; a human approves before commit (review queue) | P7, P8 | **R14**, **R1**, **R11**, *R13* | **Spine**: Action executor; **OSS**: `postgres` SKIP-LOCKED (R14) work-queue for the approval inbox | designed — executor exists; the *propose-then-approve* queue not built (no work-queue binding in ontology) |
| Logic / decision functions | Pure ontology Functions (derived properties, scoring) the agent can invoke | P6 | **R10**, **R1** | **Spine**: ontology function registry | partial — registry + typed objects built (`planetar-ontology/src/registry/registry.ts`); a general Function VM not built (kinematic rule is hardcoded) |
| Model context / conversation memory | Per-session agent state, scratchpad, recent-tool cache | P8 | **R2**, *R1* | **OSS**: `redis` (R2) for session/scratchpad; spine: durable history via R3 replay | planned — hot-cache role specified ([`10` R2]); no agent session store built |

## AIP — Evaluation, Guardrails & Observability

| Feature | What it does | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Guardrails / policy gate on AI actions | Blocks AI actions that violate markings, purpose, or classification | P1, P7 | **R13**, **R11**, *R12* | **Spine**: adapters are PEPs (12 §1 `MarkingResolver`); **OSS**: `OPA` (R13) as the PDP | designed — marking model + propagation **designed-only** (inventory GAP: markings + propagating security); audit envelope built |
| AI usage / interaction audit | Records every prompt, retrieval, tool call, and action for review/export | P1 | **R11**, *R9* | **Spine**: audit envelope on R3→R11 (00 §4.2); **OSS**: `clickhouse` (R11/R9) sink for scale queries | partial — immutable audit-log built (envelope path + doibio `src/lib/event-log.ts`); AI-specific event shape + clickhouse sink designed |
| Eval / scoring harness | Runs eval sets against agent outputs; scores accuracy/groundedness | P8, P9-analytics | **R9**, **R1**, **R11**, *R7* | **OSS**: `clickhouse`/`duckdb` (R9) for eval-result aggregation | planned — no eval harness; R9 analytics role specified ([`10` R9]) |
| Lineage of an AI claim | Traces a generated answer back to the objects/sources it was grounded on | P1, P6 | **R12**, **R10**, *R7* | **Spine**: lineage emit + per-field provenance; **OSS**: `marquez` (R12) | designed — provenance built in resolver; full lineage graph store (marquez) designed |
| Rate limit / cost control | Throttles model calls per principal/tenant; tracks token spend | P0, P1 | **R2**, **R11**, *R13* | **OSS**: `redis` (R2) atomic counters; spine: per-principal policy | planned — Cache.incr port exists (12 §3); no LLM gateway to meter |

## AIP — Conversational Surface

| Feature | What it does | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Chat / copilot UI | Conversational pane that queries the ontology and renders typed results | P8 | **R1**, *R7*, *R2* | **Spine**: `planetar-ui` shell + Object API/WS; **OSS**: maplibre for geo answers | partial — 4-pane shell + map + Object-API wiring built (`planetar-ui`); a chat/copilot pane is a stub. doibio ships a **Cohere AI chat** (`doibio/` chat-cli) as the closest built analog |
| Live-feed / streaming responses | Streams partial answers + live entity updates as the agent works | P8, P3 | **R3**, **R1** | **Spine**: broker WS bridge + Object API `/subscribe` (00 §4.1) | built (transport) — WS live feed built (`planetar-ontology/src/api/ws.ts`); token streaming from a model not wired |
| Natural-language → object-set query | "Show me dark vessels near Hormuz since noon" → filtered object set | P6, P8 | **R1**, **R4**, *R7*, *R8* | **Spine**: Object API filters + object sets; **OSS**: opensearch (R4), timescale/postgis (R8) for the geotemporal predicate | partial — object filter/search built (`planetar-ontology/src/api/server.ts`); NL→query translation not built |

## Apollo — Release & Fleet Delivery

| Feature | What it does | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Manifest-driven release artifact | A versioned, declarative spec of an environment's full architecture (the unit Apollo ships) | P0, P1 | **R10**, *R11* | **Spine**: the **client manifest** (13) IS this artifact — registered as `planetar:ClientManifest`, validated + versioned | partial — manifest schema + JSON-Schema designed ([`13`]); compiler/binder spec'd (12 §4); not a running service |
| Continuous delivery / fleet orchestration | Rolls a release across many heterogeneous environments with ordering + gates | P0 | **R10**, **R14**, **R11**, *R13* | **OSS**: `temporal` (R14) for the rollout workflow; deploy target via manifest (`pm2`/`kubernetes`/`nomad`/apollo-style) | designed — deploy targets enumerated in manifest (`13` §1 `deploy.target`); fleet runtime **deferred** (inventory GAP: Apollo-class deploy) |
| Environment / topology compilation | Compiles a manifest into a concrete wired deployment (binds roles→engines) | P0 | **R10**, **R1** | **Spine**: manifest compiler + `binder.bind()` (12 §4) → `BoundPlatform` | partial — binder + contract-check algorithm fully specified (12 §4); reference binder code written, not productionized |
| Air-gapped / disconnected delivery | Ships + applies releases into networks with no inbound connectivity | P0 | **R10**, **R6**, *R11* | **Spine**: git-vault registry (R10) + blob-CAS (R6) bundle; engine binds to `sqlite`/filesystem/internal | designed — the `tier: air-gapped` manifest path is first-class (`13`; maritime edge runs zero external services) but no offline delivery tooling built |
| Constraint / compatibility checks | Refuses a release whose engines can't meet a role's contract, or that breaks a dependency | P0 | **R10** | **Spine**: `assertSatisfies(ROLE_CONTRACT, capabilities)` compile-time check (12 §4, 13 §2) | partial — contract-satisfaction rule designed + coded in the binder example (12 §4); not run as a release gate |
| Rollback / version pinning | Reverts a fleet to a prior known-good manifest version | P0, P1 | **R10**, **R11** | **Spine**: registry holds every manifest version (SemVer per type, `10` R10); revert = re-bind a prior manifest | designed — versioned registry role specified ([`10` R10]); rollback orchestration deferred with Apollo runtime |

## Apollo — Operations & Health

| Feature | What it does | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Fleet health / liveness | Aggregates per-adapter health across the fleet | P0 | **R11**, *R2* | **Spine**: every adapter implements `health()` (12 §1 `Adapter.health`); aggregator is P0 | partial — `health()` is in the base port contract (12 §1); ontology exposes `GET /health` (`planetar-ontology/src/api/server.ts`); no fleet aggregator |
| Config / secrets distribution | Pushes config + secrets to each environment per manifest | P0 | **R10**, *R13* | **OSS**: `Vault` (secrets) named in 00 §2 control row; spine: manifest `config` blocks | planned — manifest carries `config` per role ([`13`]); Vault integration not built |
| Audit of deploys / admin actions | Immutable record of who shipped what, where, when | P1 | **R11** | **Spine**: audit envelope (same R11 path as data/AI audit) | partial — immutable audit-log built (envelope WAL; doibio `event-log.ts`); deploy-event shape not modeled |
| Multi-tenant isolation | Each tenant gets an isolated manifest/topology; no cross-tenant bleed | P0, P1 | **R13**, **R10**, *R1* | **Spine**: per-client manifest = per-tenant architecture (`13`); **OSS**: `keycloak`+`OPA` (R13) | designed — per-client topology is first-class (00 §3 principle 7) but **multi-tenancy hardening** is an explicit inventory GAP |

---

## Coverage summary

Features assessed by area:
- AIP — Grounding & Retrieval: 5
- AIP — Agents & Reasoning: 6
- AIP — Evaluation, Guardrails & Observability: 5
- AIP — Conversational Surface: 3
- Apollo — Release & Fleet Delivery: 6
- Apollo — Operations & Health: 4

**Total: 29 features.**

By status:

| Status | Count | Notes |
|---|---|---|
| **built** | 2 | Agent-writes-as-guardrailed-Action-Types (the containment path: precondition→effect→audit→reproject), backed by `planetar-ontology/src/actions/executor.ts`. (Several other rows are *built in transport but partial overall*, scored `partial`.) |
| **partial** | 13 | Features where a real repo does the spine half but the AIP/Apollo-specific half (vector grounding, LLM gateway, fleet runtime) is missing — e.g. ontology Object API, kinematic re-ID, immutable audit, manifest compiler example, `health()` port. |
| **designed** | 9 | Specified in the spine docs with a clear role footprint but no code: guardrail/marking propagation, lineage store, air-gapped delivery, rollback, multi-tenant isolation, semantic search. |
| **planned** | 5 | Role exists in the catalog but no design beyond it: embed pipeline, agent memory, eval harness, rate/cost control, config/secrets distribution. |

Headline: of the AIP/Apollo surface, **the containment and grounding *spine* is built or partial** (the hard, custom part — kinetic writes, Object API, provenance, audit, manifest compiler), while **the model-weights side of AIP and the fleet-delivery side of Apollo are designed/planned** — consistent with the "custom spine + OSS breadth" decision (we wire in pgvector/temporal/OPA/marquez rather than build them) and with the two explicit inventory deferrals (AIP agent studio, Apollo-class deploy).

## Notable gaps

- **No LLM gateway component.** Every AIP retrieval/agent/chat row needs a model-call boundary (P8/P2) that meters, logs (R11), and gates (R13) — this is OSS-to-wire (a gateway in front of an external model), but nothing exists yet. It is the single highest-leverage missing piece for AIP parity.
- **Vector role (R7) is designed-only.** RAG, semantic search, and embedding re-ID all require **R7**; the port is specified ([`10` R7], [`12` §3 `VectorStore`]) but no embedding pipeline or `pgvector` adapter is built — so AIP grounding is currently keyword-only via doibio's Elasticsearch.
- **Apollo-class delivery runtime is deferred.** The manifest IS the release artifact and the compiler/binder are specified (12 §4), but the multi-environment rollout/rollback/air-gapped-delivery orchestration (the actual "Apollo") is not built; `temporal` (R14) is named as the OSS rollout engine but unwired.
- **Markings + propagating security are designed-only** (inventory GAP). The AIP guardrail gate and Apollo constraint/multi-tenant isolation rows all lean on **R13** (OPA PDP) + **R12** propagation rules that exist on paper but not in code — `doibio` notably has **NO FLS/row-level sharing**.
- **Multi-tenancy hardening** (inventory GAP) blocks true Apollo-style fleet isolation: per-client manifests give *architectural* separation, but runtime tenant isolation/quotas are unbuilt.
- **Agent loop + human-in-the-loop approval queue** are unbuilt: the Action executor can *commit* an agent's proposal, but there's no planner, tool-schema exporter, or **R14** approval inbox to drive propose-then-approve.
- **No eval/observability harness.** AIP groundedness/accuracy scoring (R9) and AI-claim lineage (R12 via marquez) are unbuilt — a parity-credibility gap if AIP is demoed on real decisions.
