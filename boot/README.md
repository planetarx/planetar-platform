# boot/ — the platform boots from a manifest (Phase 1 + 2 proof)

**The manifest compiler is real, and TWO different clients boot end-to-end on the same spine with zero external services — proving "an architecture per client."**

```bash
npm run boot:edge          # client 1: maritime/defence edge  → 9/9 checks
npm run boot:enterprise    # client 2: generic enterprise CRM → 13/13 checks
npm run conformance        # one suite, every adapter         → 14/14 conformant
npm run governance         # Phase 3: governed ports          → 70/70 checks
npm run automation         # Phase 4: declarative flows       → 8/8 checks
```

## Declarative automation ([`automation.ts`](./automation.ts), Phase 4)

`npm run automation` proves flows-as-data — one mechanism covering Salesforce Flow, Approval Processes, Foundry Automate, and Omni-Channel work items:

- A `FlowDef` (pure JSON: stream trigger + condition/createEntity/action/approval steps) is **registered in R10 like a schema**, not coded.
- A `vessel.anomaly` envelope triggers the flow: the condition gate passes only `ais_lost`; a `planetar:Case` is created from payload bindings; `planetar:FlagVessel` runs through the **kinetic executor** (typed params, precondition `status == 'normal'`, atomic effects, audit + bus event).
- The approval step parks a **durable work item** (R14) an omni-channel console can claim; an analyst without the `supervisor` role is denied (and audited); the supervisor's approval runs `planetar:ConfirmDarkVessel` **as the approver**.
- Re-flagging a suspect vessel is rejected by the kinetic precondition guard; the audit trail shows the whole chain (flow writes, supervisor write, denied attempt).

## Governed ports ([`governance.ts`](./governance.ts), Phase 3)

`npm run governance` runs the adversarial suite ([`spine/governance-conformance.ts`](../spine/governance-conformance.ts)): it binds every data role, plants public, restricted and derived entities, and attacks each role as a principal cleared only for `UNCLASS`. The client passes when that principal can never observe the restricted rows. It runs twice: against a client with every data role bound, and against one that binds only the five roles kinetic writes need.

- **One gate** — callers take `platform.as(principal)` (filtered reads, no data writes) or `platform.system(component)` (spine internals, seeding). There is no raw `role()`.
- **No leak, per role** — ids, counts, graph neighbours and paths, nearest neighbours, tracks, stream envelopes, audit records and lineage edges of a restricted row are withheld; a high-clearance principal sees all of them.
- **Inheritance that holds over time** — a marking applied **once at a source** restricts what was already derived from it and what is derived later, in either write order; markings never shrink.
- **Writes** — entities are created and changed only through the action gate; a restricted target looks like a missing one.
- **Field-level security** — the field map lives in the manifest (`governance.fls`); a protected field is redacted, is kept out of shared projections, and cannot be used to filter, sort or aggregate.
- **Structure** — every port method is classified governed / open / system, and the suite fails if one is not.

The policy engine is in-process ([`MarkingPolicy`](../spine/governance.ts)); the **production swap is Keycloak (authn) + OPA (Rego PDP)** behind the same `PolicyIdentity` / `MarkingResolver` ports — no spine change.

## Two clients, one spine (the headline)

| | Maritime edge | Generic enterprise |
|---|---|---|
| tier | `edge` (air-gappable) | `standard` |
| bound roles | **9** | **13** |
| extra roles | — | graph, vector, hot-cache, analytics-olap |
| omits | graph/vector/olap/cache (not needed) | timeseries-geo (no sensor firehose) |
| ingest | ais/sat detectors | salesforce-sync / email-to-case |
| surfaces | planetar-ui shell + Object API | acme-console + Object API + customer-portal |

**Identical** `compiler.ts`, spine ports, and adapter code run both. The only differences are the two JSON manifests. That is the product: role selectivity + per-client topology, mechanically enforced. The maritime smoke exercises 9 roles; the enterprise smoke additionally exercises graph (link analysis), vector (re-ID/RAG), hot-cache (presence/counters), and analytics-olap (a `GROUP BY type` report over the live entity table) — all through the same engine-agnostic ports.

`boot.ts` loads [`manifests/maritime-edge.json`](./manifests/maritime-edge.json), runs the [compiler](../spine/compiler.ts) (capabilities → required roles → contract-check → bind adapters → topology), health-checks every bound role, then exercises each adapter **through the engine-agnostic spine ports** ([`../spine/ports.ts`](../spine/ports.ts)).

## What it proves

1. **The mechanism runs.** 7 capabilities resolve to 8 required roles; 9 adapters are contract-checked and bound; the topology is emitted — all from a manifest, no code change.
2. **The contract guardrail works.** Binding a non-durable engine to R3 `stream` is **rejected at compile time** (`role requires durability`), while `postgres` is accepted for R1.
3. **The spine is engine-agnostic.** The smoke writes/reads entities, indexes+searches, publishes+subscribes envelopes, stores a content-addressed blob, runs a durable work-queue claim, appends a hash-chained audit record, propagates a marking along lineage, and makes a policy decision — all via ports, never touching an engine driver.
4. **Role selectivity.** The edge client never binds `vector`/`graph`/`analytics-olap`/`timeseries-geo`/`hot-cache` — nothing it enabled needs them (the `vector` enhancing-role warning is informational).

## Captured run

```
=== Compiling manifest: Maritime / Defence (edge) (tier=edge) ===
required roles (8): stream, registry, canonical-store, audit-log, object-index, lineage, blob-cas, work-queue
bound roles    (9): stream, registry, canonical-store, audit-log, object-index, lineage, blob-cas, work-queue, policy-identity
  ⚠ enhancing role vector unbound — capability runs degraded

=== Topology ===
flowchart LR
  ... planetar_ais & planetar_sat -->|envelopes| BUS[("stream: file")]
  BUS --> CS[("canonical-store: sqlite")] ;  BUS --> AUD[("audit-log: append-wal")]
  CS --> RES[resolution: spine] --> ONT[ontology: spine]
  ONT --> IDX[("object-index: sqlite")] ;  BLOB[("blob-cas: filesystem")] --- ONT
  ONT --> planetar-ui ;  ONT --> object-api

=== Health ===  (all ✅: stream/registry/canonical-store/audit-log/object-index/lineage/blob-cas/work-queue/policy-identity)

=== Contract guardrail ===
  non-durable engine bound to R3 stream → ✅ REJECTED: role requires durability; engine is not durable
  postgres bound to R1 canonical-store → ✅ ACCEPTED

=== Smoke (spine ports over the bound engines) ===
  ✅ registry.put + get — schema planetar:Vessel@1.0.0
  ✅ canonical-store.upsert + get — entity MV Demo (mmsi 316001234)
  ✅ object-index.index + search + blocking — 1 hit(s), 1 resolution candidate(s)
  ✅ stream.publish + subscribe (live) — received vessel.ais.position (44 bytes)
  ✅ blob-cas.put + get (content-addressed) — sha256 971f0b520fb6… (19 bytes)
  ✅ work-queue.enqueue + claim + complete — job 1 enqueued→claimed→completed
  ✅ audit-log.append + scan (hash-chained) — 1 audit record(s)
  ✅ lineage.record + propagateMarking — marking propagated to 2 downstream ref(s)
  ✅ policy-identity.authorize (PEP) — allow UNCLASS ✓, deny NOFORN ✓

9/9 checks passed.
```

## The conformance suite ([`conformance.ts`](./conformance.ts))

`npm run conformance` runs the shared, engine-agnostic suite ([`../spine/conformance.ts`](../spine/conformance.ts)) against every built adapter — **14/14 pass**, including a **`broker` zmesg-codec round-trip** (encode→decode preserves topic/id/source/correlation/ts/payload, verified against `zmesg.h` without a running broker). Same suite, every engine = a client can bind any of them and the spine behaves identically.

## What's a stand-in here (honest notes)

- The edge `stream` binds the **`file`** engine (durable WAL file, zero-service). The real **`broker`** adapter (TCP, BE-length / LE-zmesg framing) is now **written and codec-verified** in [`../adapters/broker/stream.ts`](../adapters/broker/stream.ts); a live end-to-end run needs the broker process (which this session does not own), so the boots use `file`.
- **Markings can't ride the current zmesg header** — `zmesg.h` v1 has no markings field (only a `flags` byte). The `file` engine preserves markings (JSON); the `broker` codec drops them. So governance markings need a zmesg v2 field (or must travel inside the canonical payload). This is the concrete answer to the Phase 0 "verify markings placement" item.
- Production engines (postgres multiplex, redis, opensearch, falkordb, minio, kafka, spanner, clickhouse, qdrant, pgvector) remain **sample code** in [`../40-ADAPTERS/`](../40-ADAPTERS/); the runnable repo stays zero-dependency. The zero-service engines (sqlite/file/fs/memory/broker-over-node:net) prove the mechanism; production engines drop in behind the same ports once a deploy provides the services + drivers.
- Governance decisions are made in-process (`MarkingPolicy` + the `internal` policy engine) and enforced on every role by the gate. Binding Keycloak + OPA behind the same ports is still open.
