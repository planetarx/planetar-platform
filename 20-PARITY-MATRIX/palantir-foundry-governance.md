# 20 — Parity Matrix · Palantir Foundry — Security / Governance + Cross-cutting

This slice maps Foundry's **security, governance, and cross-cutting platform** features onto the Planetar spine ([`00`](../00-ARCHITECTURE-OVERVIEW.md)) and the 14 storage roles ([`10`](../10-STORAGE-ROLES.md)). It is the **P1 Governance** story plus the P0/P5/P11-adjacent cross-cuts: markings & purpose-based access, lineage, audit, branching/sandboxes, the registry/metadata SSOT, identity & RBAC, encryption, and retention.

> Palantir-side claims corrected 2026-11-14 against the planetar-palantir research (2026-11-06); rows it did not cover are unchanged.

**Headline parity story.** Foundry's governance moat is *propagation of mandatory controls*: a marking, organization or CBAC classification, applied at any point and retroactively ([remove markings](https://www.palantir.com/docs/foundry/building-pipelines/remove-markings/)), is inherited along the file hierarchy and direct data dependencies to derived datasets ([markings](https://www.palantir.com/docs/foundry/security/markings/)). It is not "everywhere": discretionary controls (project roles, restricted views, object and property policies) do not propagate, the source policy does not follow data into function returns, action edits, AIP Logic tool calls, OSDK responses, writeback or exports ([propagation](https://www.palantir.com/docs/foundry/security/access-control-propagation/)), an object security policy can add or remove inherited controls ([object policies](https://www.palantir.com/docs/foundry/object-permissioning/object-security-policies/)), and an inherited marking can be removed through a governed `stop_propagating` declaration ([remove inherited](https://www.palantir.com/docs/foundry/building-pipelines/remove-inherited-markings/)). Propagation itself is not unique to Foundry: Snowflake tags and Atlas plus Ranger classifications also propagate (see planetar-palantir report, 2026-11-06). Every store enforces — rather than re-implements — the policy the governance plane hands it (principle 4 in [`00 §3`](../00-ARCHITECTURE-OVERVIEW.md)). We already own the three load-bearing primitives: **per-field provenance** (the resolver writes `_provenance` on every entity field — `planetar-ontology/src/store/schema.sql`, `doibio/src/lib/identity-resolution.ts`), an **immutable audit-as-event** path (every Action Type lands a `core:Event` — `planetar-ontology/src/actions/executor.ts`; doibio's append-only `event-log.ts`), and the **kinetic single-write-path** that makes audit/attribution structural rather than bolted-on. **Marking propagation across stores** and **PEP-at-every-role** enforcement are built in the platform core (2026-10-06) but not in the live service; **governed declassification** is not built at all. The OSS breadth here is unusually clean — **Marquez/OpenLineage** for R12, **Keycloak + OPA** for R13, **ClickHouse/Kafka** sinks for R11 — because lineage, identity, and policy are mature solved problems we wire in behind adapters rather than rebuild.

Every governance feature decomposes (honestly) into `{R1, R10}` plus a specialty role — usually **R12 lineage**, **R13 policy-identity**, or **R11 audit-log**. Required roles are **bold**; enhancing roles are *italic*.

---

## Markings & Purpose-Based Access Control

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Markings (classification labels) | Tag datasets/objects/columns with security markings that gate visibility | P1 | **R13**, **R10**, *R12* | **spine** (marking model + adapter-as-PEP); OSS: **OPA** for the decision, **Keycloak** for principal/group membership | partial — **built in the platform core 2026-10-06**: markings on entities, observations, envelopes and index rows; one visibility rule (`planetar-platform/spine/governance.ts` `MarkingPolicy`) enforced on every storage role by the gate (`spine/governed.ts`); `npm run governance` 70/70. Not in the live service (`planetar-ontology/src/store/schema.sql` has no marking column) and not on the `zmesg` wire |
| Propagating security (marking flows along lineage) | A mandatory control (marking, organization, CBAC) applied upstream is inherited by derived datasets; discretionary controls do not propagate ([propagation](https://www.palantir.com/docs/foundry/security/access-control-propagation/)) | P1 | **R12**, **R13**, **R11** | **spine** (propagation rules over the lineage graph — the moat); OSS: **Marquez** (lineage store), **OPA** (eval) | partial — **built in the platform core 2026-10-06**: a marking applied at a source is persisted in lineage (`applyMarking` / `effectiveMarkings`, `adapters/fs/lineage.ts`), stamped on existing derivations and inherited by later ones in either write order, index copies included (`spine/system.ts`). Marquez adapter and the live service remain |
| Mandatory (need-to-know) markings | Conjunctive markings: principal must hold *all* required marks (true of markings; CBAC adds hierarchy and disjunctive categories, see the CBAC row) | P1 | **R13**, **R10** | spine: marking-set intersection in the PEP; OSS: **OPA** policy bundle | partial — the conjunctive rule is built and fixed in the spine (`MarkingPolicy.visible`: the principal must hold every marking) and applied in-engine by the sqlite index and OLAP adapters (`enforcesMarkings`). No OPA bundle bound |
| Organization / namespace markings | Org-scoped data isolation (multi-org boundary) | P1,P0 | **R13**, **R10**, *R1* | spine: org dimension on canonical id; OSS: **Keycloak** orgs/realms | designed — multi-tenancy hardening listed as a GAP |
| Purpose-based access | Access granted for a declared *purpose*. Weakly evidenced: no dedicated current docs page; best read as a pattern over Projects, markings, approvals and Checkpoints ([2023 blog](https://blog.palantir.com/protecting-data-with-privacy-first-principles-f76f20d8e63)) | P1,P7 | **R13**, **R11**, **R10** | spine: purpose param on Action Type + governance gate (lifecycle `00 §4.2`); OSS: **OPA** | designed — kinetic gate exists (`planetar-ontology/src/actions/executor.ts` precondition+effect+audit), purpose dimension not yet a policy input |
| Restricted views / row-column security | Restricted views are discretionary, row-limiting policies that cannot feed transforms ([restricted views](https://www.palantir.com/docs/foundry/security/restricted-views/)); column control belongs to object and property security policies. Neither propagates | P1,P4,P6 | **R13**, **R1**, *R4* | spine: PEP wraps `CanonicalStore`/`ObjectIndex` reads; OSS: **OPA** filter compilation, **opensearch** doc-level security | partial — **built in the platform core 2026-10-06**: `platform.as(principal)` returns governed ports for all 14 roles (row filter + field redaction; counts only from engines that filter in-engine); adversarial suite `spine/governance-conformance.ts`. OPA filter compilation and opensearch doc-level security not bound |
| Marking inheritance on derived/exported artifacts | Downstream Foundry files carry inherited markings; carriage into exports *outside* Foundry is unverified, and the [propagation page](https://www.palantir.com/docs/foundry/security/access-control-propagation/) lists exports among places the source policy does not follow | P1 | **R12**, **R6**, **R11** | spine: propagation rule extends to blob handles + exports; OSS: **Marquez**, **minio** object tags | designed |
| Classification-based access controls (CBAC) | Classification markings with hierarchy and disjunctive categories such as RELEASE TO; not on by default ([CBAC](https://www.palantir.com/docs/foundry/security/classification-based-access-controls/)) | P1 | **R13**, **R10** | spine: a classification lattice in the policy; OSS: **OPA** | planned (not built) — row added 2026-11-14; `MarkingPolicy.visible` (`spine/governance.ts`, every marking must be held) cannot express hierarchy or disjunctive categories |
| Governed marking removal (declassification) | Remove an inherited marking in a transform via `stop_propagating`, on a protected branch with an approver holding the removal permission; affects new output transactions only ([remove inherited](https://www.palantir.com/docs/foundry/building-pipelines/remove-inherited-markings/)) | P1 | **R12**, **R13**, **R11** | spine: governed removal on the lineage closure + approver separation | planned (not built) — row added 2026-11-14; the marking model is union-only with no removal API (see [`40-ADAPTERS/governance.md` §4.4](../40-ADAPTERS/governance.md)) |

---

## Lineage & Provenance

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Data Lineage — dataset graph ("Monocle" is an unconfirmed, possibly legacy name; verify before external use) | Upstream/downstream dataset DAG with impact analysis; documented lineage is dataset-and-job grained, hung off the build system ([builds](https://www.palantir.com/docs/foundry/data-integration/builds/)) | P1 | **R12**, **R10** | spine: lineage emit on every transform; OSS: **Marquez** (OpenLineage, postgres-backed) | partial — lineage *edges* recorded source→observation in the ingest lifecycle (`00 §4.1`), but no Marquez adapter / full DAG UI yet |
| Field-level / per-field provenance | Every canonical field records {observation, source, confidence, ts} | P1,P5 | **R1**, **R12** | **spine** (the resolver's core output — the moat) | **built** — `planetar-ontology/src/store/schema.sql` (`provenance TEXT` per entity), written by `executor.ts` effects (`target.provenance[eff.field]`) and `doibio/src/lib/identity-resolution.ts` |
| Conflict / discrepancy provenance | When two sources disagree, record both with provenance for adjudication | P5,P1 | **R1**, **R12** | **spine** (resolution conflict model) | **built** — `discrepancy` table in `planetar-ontology/src/store/schema.sql`; resolver in `src/resolve/resolve.ts` |
| Impact analysis ("what breaks if I change X") | Traverse lineage downstream to find affected datasets/objects | P1 | **R12** | spine: impact query; OSS: **Marquez** downstream traversal (or reuse **falkordb** R5) | designed — lineage substrate specified (`10` R12), traversal API not built |
| Lineage-to-source (Data Cloud style) | Trace any derived value back to the originating raw event | P1,P3 | **R12**, **R3** | **spine** (every store is a projection of the R3 stream — provenance is structural) | partial — bus-as-source-of-record is built (`planetar-broker` WAL), explicit lineage edge emit is partial |
| Transform/derivation registration | Each pipeline transform registers its inputs→outputs for lineage | P1,P2 | **R12**, **R10** | spine: detector SDK emits OpenLineage events; OSS: **Marquez**, **dbt** lineage | designed — detectors emit envelopes (built) but not OpenLineage run-events |

---

## Audit & Monitoring

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Comprehensive audit log (reads/writes/admin) | Immutable record of every read, write, export, admin + AI action | P1 | **R11** | spine: audit envelope on R3; OSS: **ClickHouse** / **Kafka** sink for scale | partial — **write/action** audit built (every Action Type emits a `core:Event`, `planetar-ontology/src/actions/executor.ts` step 5; doibio append-only `src/lib/event-log.ts`); **read** auditing built in the platform core 2026-10-06 (one record per governed call, itself marked so a reader cannot see what was withheld from it — `planetar-platform/spine/governed.ts`); not in the live service |
| Audit-as-event (writes are evented) | A write *is* an envelope on the bus, so it's auditable by construction | P1,P7,P3 | **R11**, **R3**, **R1** | **spine** (kinetic = single write path; lifecycle `00 §4.2`) | **built** — `planetar-ontology/src/actions/executor.ts` (precondition→effect→`core:Event`); `planetar-broker` WAL is the durable audit substrate |
| Immutable / tamper-evident audit | Append-only, never rebuilt, exportable as evidence. Disputed on the Palantir side: the current [audit overview](https://www.palantir.com/docs/foundry/security/audit-logs-overview/) makes no tamper-evidence claim, while a 2022 UK service definition says audit logs "can be made tamper-evident"; treat tamper evidence as planetar's design, not parity | P1 | **R11** | spine: append-WAL (broker-style); OSS: **ClickHouse** (queryable), **Kafka** (SIEM stream) | **built** (file-level) — `planetar-broker` WAL+CRC32; doibio `event-log.ts` append-only markdown event files (status `pending|applied|failed`) |
| SIEM export / streaming | Stream audit to a client's external SIEM | P1 | **R11** | OSS: **Kafka** connector / **ClickHouse** export | designed — sink abstraction noted in `13` (`audit: { export: none }`) |
| AI / agent usage observability | Log every agent prompt, tool call, and grounding retrieval | P1,P7 | **R11**, *R12* | **spine** (agents act only through Action Types → auto-audited); OSS: ClickHouse for dashboards | partial — agent writes route through kinetic (auditable by construction, designed); no agent runtime wired yet (AIP studio is a GAP) |
| Audit retention & search | Time/principal/resource-filtered scan over historical audit | P1 | **R11**, *R4* | OSS: **ClickHouse** (scale) or **opensearch** (R4) over the audit stream | designed |

---

## Identity, RBAC & Access Management

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Principals (users, service accts, AI agents) | Unified principal model including non-human/agent identities | P1 | **R13** | spine: principal as a canonical type; OSS: **Keycloak** (SSO/SCIM) | partial — doibio has users+sessions (`src/lib/auth.ts`, single `role` string), Keycloak adapter designed |
| RBAC (roles / groups / spaces) | Role- and group-scoped access to projects/spaces | P1 | **R13**, **R10** | spine: role binding in registry; OSS: **Keycloak** groups + **OPA** | partial — coarse single-`role` RBAC in doibio `src/lib/auth.ts`; spaces/groups designed |
| SSO / SAML / OIDC / SCIM provisioning | Federated login + automated user provisioning | P1,P0 | **R13** | OSS: **Keycloak** (identity broker, SCIM) | designed — Keycloak named default in `10` R13; no adapter wired |
| Authorization decision (PDP/PEP) | "Can principal do action on resource under marking?" | P1 | **R13** | spine: adapters are PEPs (`12 §1`); OSS: **OPA** is the PDP | partial — kinetic preconditions act as a coarse PDP (`executor.ts`); OPA externalized decision designed |
| Field-level security (FLS) | Hide/mask specific fields per principal | P1,P6 | **R13**, **R1** | spine: PEP masks on Object API read; OSS: **OPA** field policy | partial — **built in the platform core 2026-10-06**: field map in the client manifest (`governance.fls`); redaction on every governed read; protected fields kept out of shared projections (`indexDocFor`); filter / sort / aggregate on a protected field refused (`spine/governed.ts`). Limitation: a protected field is searchable by nobody. Not in the live service (doibio has *no* FLS — `src/lib/auth.ts`) |
| Row-level / record sharing | Grant access to individual records beyond role defaults | P1 | **R13**, **R1** | spine: sharing table + PEP filter; OSS: **OPA** | designed — **explicit GAP** (doibio has no row-level sharing) |
| Two-factor / step-up auth | MFA, step-up for sensitive actions | P1 | **R13** | OSS: **Keycloak** (MFA flows) | designed |
| Token-scoped service access (OSDK tokens) | Scoped tokens for programmatic Object API access | P1,P6 | **R13**, **R2** | spine: token check at Object API; OSS: **Keycloak** client credentials; cache in **redis** (R2) | partial — Object API exists (`planetar-ontology/src/api/server.ts`, `ws.ts`); scoped-token issuance designed |

---

## Branching, Sandboxes & Change Management

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Dataset/ontology branching | Branch the model/data and edit in isolation. Dataset branches do not merge: code merges in Git and data on `master` is rebuilt; Global Branching adds proposals across resources ([branching](https://www.palantir.com/docs/foundry/data-integration/branching/)) | P0,P6 | **R10**, **R1** | **spine** (registry is git-vault SSOT → branching is git-native) | partial — registry is git+filesystem (`10` R10; `planetar-registry` vertical slice); copy-on-write data branches designed |
| Scenarios / what-if overlays | Overlay hypothetical edits on canonical state without committing | P6,P0 | **R1** (copy-on-write), **R10** | **spine** (scenario overlay on canonical store — `11 §2`) | designed |
| Proposals / review & approval of model changes | Governed review workflow before a schema/ontology change lands | P0,P7 | **R10**, **R14**, *R13* | spine: change = an Action Type (audited); OSS: **Temporal** for long-running review, **OPA** gate | designed — registry writes are "validated write (governed)" (`10` R10); approval workflow not built |
| Versioned schema / SemVer types | Every object/link/action type is versioned (SemVer) | P0,P6 | **R10** | **spine** (registry codegen) | **built** (slice) — `planetar-registry` codegen + `planetar-ontology/registry/`; SemVer-per-type per `10` R10 |
| Dataset transactions / atomic commits | Multi-row writes commit atomically or roll back | P4,P7 | **R1**, **R3** | **spine** (`CanonicalStore.transaction`, `12 §2`) | **built** — `transaction<T>()` in adapter contract; `executor.ts` applies effects atomically |
| Rollback / time-travel | Restore prior state by replaying the event log to an offset | P3,P4 | **R3**, **R1** | **spine** (stores are rebuildable projections of R3 — `00 §3` principle 2) | partial — replay-from-offset is built in the bus (`planetar-broker` WAL); point-in-time store rebuild is designed |

---

## Registry / Metadata SSOT (Ontology Manager)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Ontology Manager (object/link/action type defs) | Author and version the semantic model definitions | P6,P0 | **R10** | **spine** (registry + codegen) | **built** — object/link/action types in `planetar-ontology/src/registry/registry.ts`; defs in `registry/` |
| Metadata-driven schema (no-code types) | Define entity types as config; code generates from them | P0,P4 | **R10**, **R1** | **spine** (registry → codegen → adapter DDL, `12 §2`) | **built** (slice) — `planetar-registry`; doibio's 35 JSON-schema custom objects (`~/data/dev/doibio/cfm/json/`) |
| Source / connection registry | Catalog of ingest sources and their markings | P2,P1 | **R10**, *R12* | spine: source registry (`10` R10); OSS: **Airbyte** connector catalog | partial — detectors registered (ais/sat/eo/acoustic built; RF lane registered, no service per inventory) |
| Field-id dictionary / canonical field map | Namespaced field SSOT across all types | P4,P0 | **R10** | **spine** (canonical data model field dictionary) | partial — designed + vertical-slice proven (`ARCH-canonical-data-model.md`) |
| Manifest registry (per-client architecture) | The client manifest is itself a versioned registered type | P0,P10 | **R10** | **spine** (`13 §5` — manifest is a `planetar:ClientManifest` SchemaType) | designed — manifest schema specified (`13`), compiler designed |

---

## Encryption, Retention & Compliance

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Encryption at rest | Per-store at-rest encryption of canonical/blob data | P1,P0 | **R1**, **R6** | OSS: engine-native (postgres TDE, **minio** SSE), KMS via **Vault** | designed |
| Encryption in transit | TLS between planes; signed envelopes on the bus | P3,P1 | **R3** | spine: envelope integrity (`zmesg` + WAL CRC32); OSS: TLS termination | partial — bus has CRC32 frame integrity (`planetar-broker`); TLS designed |
| Secrets management | Centralized secret/key storage for adapters | P0 | **R13** | OSS: **Vault** (named default in `00 §2` P0 row) | designed |
| Retention & purge policies | Time-based deletion / tombstoning of data and audit | P1,P4 | **R1**, **R11**, *R12* | spine: retention as a governed Action Type; OSS: engine TTL | designed |
| Right-to-be-forgotten / redaction | Targeted deletion across all derived stores via lineage | P1 | **R12**, **R1**, **R11** | **spine** (lineage-driven cascade — same propagation rules as markings) | designed |
| Data classification at ingest | Auto-assign markings/sensitivity at the edge | P2,P1 | **R13**, **R10** | spine: detector SDK applies source marking (`00 §4.1`); OSS: **OPA** | partial — source marking attached at ingest is in the lifecycle spec; auto-classification designed |

---

## Cross-cutting Control Plane (P0)

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Manifest compiler (capability→role→engine) | Compile a client manifest into a wired, contract-checked deployment | P0 | **R10** | **spine** (binder + contract checker, `12 §4`) | designed — `binder.bind()` / `assertSatisfies` specified in `12 §4`; compiler not implemented |
| Contract validation (engine ⊨ role) | Reject an engine whose capabilities don't satisfy a role's contract | P0 | **R10** | **spine** (`assertSatisfies(ROLE_CONTRACT, capabilities)`) | designed — rule specified (`12 §1`, `13 §2`) |
| Fleet / deploy delivery (Apollo-class) | Orchestrated rollout of versioned bundles across environments | P0 | **R10**, **R14** | OSS: **Kubernetes** / **Nomad** / pm2; **Temporal** for orchestration | designed — **explicit GAP** ("Apollo-class deploy" deferred per inventory) |
| Health / liveness + contract self-check | Per-adapter health probe round-trips a write | P0,P1 | (all roles) | **spine** (`Adapter.health()`, `12 §1`) | **built** (contract) — `health(): Promise<HealthStatus>` mandated on every adapter |
| Config / per-client topology emission | Emit Mermaid topology + resolved config from a manifest | P0 | **R10** | **spine** (`13 §4` topology emitter) | designed |

---

## Coverage summary

Counts are over the **51** governance / cross-cutting features in this slice (49 rows, plus the CBAC and governed-marking-removal rows added 2026-11-14).

| Status | Count | What it means here |
|---|---|---|
| **built** | 9 | A named repo demonstrably does it (per-field provenance, discrepancy provenance, audit-as-event, immutable WAL audit, versioned types, atomic transactions, Ontology Manager type defs, metadata-driven schema). Backing: `planetar-ontology`, `planetar-registry`, `planetar-broker`, `doibio`. |
| **partial** | 19 | Spine primitive exists but the governance breadth is incomplete (lineage edges without Marquez DAG, write-audit without read-audit, coarse single-`role` RBAC, branching on git-registry without COW data, encryption-in-transit via CRC32 only, etc.). |
| **designed** | 21 | Specified in the spine docs (OPA/Keycloak adapters, row sharing, retention, manifest compiler) but not implemented. |
| **planned** | 2 | Not built: classification-based access controls (CBAC) and governed marking removal (declassification), both added 2026-11-14 from the planetar-palantir research. |

Spine-owned: marking model, propagation rules, per-field provenance, audit-as-event, kinetic gate, registry/codegen, manifest compiler. OSS breadth named and actionable: **Marquez/OpenLineage** (R12), **Keycloak** + **OPA** (R13), **ClickHouse** / **Kafka** (R11 sinks), **minio** (R6 at-rest + object tags), **Vault** (secrets), **Temporal** (governed long-running review/rollout), **opensearch** (audit/restricted-view doc security).

---

## Notable gaps

- **No governed declassification path.** The marking model is union-only: markings can be added and inherited but never removed (`adapters/fs/lineage.ts` has only `applyMarking`, `effectiveMarkings` and `propagateMarking`). Foundry's `stop_propagating` (protected branch plus an approver holding the removal permission, new transactions only) is what keeps its model usable; without it, union-only marking over-marks until analysts cannot use anything or admins stop marking. Open design item in [`40-ADAPTERS/governance.md` §4.4](../40-ADAPTERS/governance.md).
- **Marking propagation is built in the platform core (2026-10-06) but not in the live service.** Lineage-persisted markings are inherited by existing and later derivations (`spine/system.ts`, `adapters/fs/lineage.ts`); the live ontology schema has a `provenance` column but **no marking column** (`planetar-ontology/src/store/schema.sql`), and markings are not on the `zmesg` wire. Only mandatory controls should propagate; the mandatory-versus-discretionary split is not modelled explicitly.
- **FLS is built in the platform core (2026-10-06); row-level / record sharing is not.** Field redaction runs on every governed read (`spine/governed.ts`), but there is no per-record grant table, and the live services still lack both (doibio `src/lib/auth.ts`: a single coarse `role` string).
- **PEP enforcement is built in the platform core (2026-10-06) through the governed gate** (`platform.as(principal)` over all 14 roles, `spine/governed.ts`); OPA is not bound, and CBAC and purpose-based access are not policy inputs.
- **Read auditing is built in the platform core (2026-10-06)** (one marked record per governed call, `spine/governed.ts`); the live service audits writes only.
- **External identity (Keycloak/OPA/SSO/SCIM/MFA) is entirely designed.** doibio's homegrown `auth.ts` (users + sessions) is the only running identity; federated SSO and externalized policy decisions have no adapter yet. Multi-tenancy hardening is an open GAP.
- **Lineage has edges but no engine.** Source→observation edges are recorded in the ingest lifecycle, but there is no Marquez adapter, no full DAG, and no impact-analysis traversal API. Right-to-be-forgotten and retention cascades depend on this.
- **Manifest compiler is spec-only.** The contract-checking binder (`12 §4`) is fully specified but not implemented — so contract validation, topology emission, and per-client composition are designed rather than running.
- **Apollo-class fleet delivery is deferred** (per BUILT INVENTORY); deploy is pm2 today, with Kubernetes/Nomad/Temporal named for the future.
- **Encryption is mostly designed.** Only frame-level integrity (CRC32 on the broker WAL) is built; at-rest encryption, TLS-in-transit, and Vault-backed secrets are designed.
