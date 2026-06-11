# 00 — Architecture Overview

This document defines the **planes** of the Planetar Platform, how the **custom spine** and **OSS breadth** layer together, and the lifecycles that tie them. It is the vocabulary every other document uses.

---

## 1. The eight planes

The platform is organized into eight horizontal **planes**. A plane is a contract, not a process — one plane may be served by several processes, and one process may touch several planes. Planes depend *downward* only.

```
┌─────────────────────────────────────────────────────────────────────┐
│  P8  SURFACES        shells, apps, OSDK, BI, dashboards, agents      │  ← what users/agents touch
├─────────────────────────────────────────────────────────────────────┤
│  P7  KINETIC         Action Types: validated, audited, reversible    │  ← the ONLY write path
│                      writes (humans + AI act only through here)      │
├─────────────────────────────────────────────────────────────────────┤
│  P6  SEMANTIC        Ontology: object types, link types, functions,  │  ← the contract everyone speaks
│                      interfaces, object sets, Object API / OSDK      │
├─────────────────────────────────────────────────────────────────────┤
│  P5  RESOLUTION      identity resolution, per-field provenance,      │  ← raw observations → entities
│                      conflict/discrepancy, golden master            │
├─────────────────────────────────────────────────────────────────────┤
│  P4  CANONICAL       canonical data model: kernel + canonical +      │  ← one logical model, N stores
│      STORE           extension types, materialized via STORAGE ROLES │
├─────────────────────────────────────────────────────────────────────┤
│  P3  STREAM/BUS      envelope + bus: ordered, durable, fan-out;      │  ← the nervous system
│                      every state change is an event                 │
├─────────────────────────────────────────────────────────────────────┤
│  P2  INGEST          connectors + detectors: external → envelopes    │  ← the edge
├─────────────────────────────────────────────────────────────────────┤
│  P1  GOVERNANCE      markings, lineage, policy, audit — CROSS-CUTS   │  ← defined once, propagates
│      (cross-cutting) every plane; not "below," but woven through    │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                                   ▲
         │  CONTROL plane (P0): deploy, config, secrets,     │
         │  fleet, per-client manifest → topology            │
```

- **P0 Control** and **P1 Governance** are cross-cutting; the others are a stack.
- The **manifest** (P0) is what turns this abstract stack into a concrete per-client deployment by binding storage roles to engines and choosing which OSS components fill each plane.

---

## 2. Spine vs. breadth, plane by plane

For each plane: what is **custom spine** (we own it, it's the moat) vs. **OSS breadth** (we wire it in behind an adapter).

| Plane | Custom spine | OSS breadth (behind adapters) |
|---|---|---|
| P2 Ingest | detector framework, envelope emit SDK | Airbyte/Meltano connectors, Singer taps, source-specific libs (AIS, SAR, etc.) |
| P3 Stream/Bus | `zmesg` envelope, `planetar-broker` (ns SHM/TCP/UDP), WAL | Kafka/Redpanda, NATS, Redis Streams (as alternate bus engines via the **stream** role) |
| P4 Canonical store | canonical data model, registry+codegen, write-projection logic | redis, sqlite, postgres, mysql, spanner, clickhouse, minio/s3 (via **storage roles**) |
| P5 Resolution | identity-resolution engine, provenance/conflict model | blocking/indexing via search role; embeddings via vector role |
| P6 Semantic | ontology service, Object API, OSDK codegen | falkordb/neo4j (graph role), opensearch (object-index role), Hasura/GraphQL gen |
| P7 Kinetic | Action Type executor, precondition/effect/audit | workflow engines (Temporal) for long-running orchestrations |
| P8 Surfaces | `planetar-ui` shell, doibio micro-frontends | Grafana/Superset (BI), Tableau connector, map libs (maplibre), notebook hosts |
| P1 Governance | marking model, lineage propagation rules, audit envelope | OpenLineage/Marquez (lineage store), Keycloak (identity), OPA (policy eval) |
| P0 Control | manifest schema + compiler, role binder | pm2 / Kubernetes / Nomad / Apollo-style delivery; Vault (secrets) |

**Invariant:** the spine compiles against **role interfaces**, never against a concrete engine. Swapping postgres→spanner for a client is a manifest edit, not a code change. This is enforced by [`12-ADAPTER-CONTRACT.md`](./12-ADAPTER-CONTRACT.md).

---

## 3. Design principles (load-bearing)

1. **One logical model, many physical stores.** The canonical data model is the single source of truth for *shape*. Storage roles are the single source of truth for *placement*. Code references roles; manifests bind engines. (Inherited from `ARCH-canonical-data-model.md`.)
2. **The bus is the spine of record.** Every state change is an envelope on P3 first; stores (P4) are *projections* of the event log. This makes stores rebuildable and swappable — a new engine for a role is just a new projection consumer.
3. **The kinetic layer is the only write path.** Humans and AI agents mutate state exclusively through registered Action Types (P7). This gives validation, audit, attribution, and reversibility for free, and is how AIP-style agent containment works.
4. **Governance is defined once and propagates.** A marking applied at ingest (P2) travels along lineage to every derived store, object, and surface. Security is not re-implemented per store; the adapter enforces the policy the governance plane hands it.
5. **Capabilities are compositions, not monoliths.** "Opportunity pipeline," "dark-vessel re-ID," "link-chart search" each decompose into the *same* small set of storage roles (see [`11`](./11-CAPABILITY-ROLE-MAP.md)). Parity = covering the role-compositions, not porting features one-by-one.
6. **Custom where it's the moat; OSS where it's solved.** We do not write a search engine or a SQL planner; we *do* own the envelope, bus, semantic contract, and resolution because those are the differentiators.
7. **Per-client topology is first-class.** "Each client a different architecture" is the product, not an exception. The manifest is a real, validated, versioned artifact that compiles to a running deployment.

---

## 4. Two end-to-end lifecycles

### 4.1 Ingest → entity (read path build-up)

```
external source
  └─P2─ connector/detector normalizes → zmesg envelope (with source marking)
      └─P3─ broker: WAL append → fan-out on topic
          └─P4─ canonical-store projector writes Observation (role: canonical-store)
          └─P1─ lineage records source→observation edge (role: lineage)
              └─P5─ resolver folds Observation into CanonicalEntity
                    (blocking via role: object-index; merge w/ per-field provenance)
                  └─P6─ ontology indexes entity + links (roles: object-index, graph)
                      └─P8─ surface subscribes (Object API WS) → live update
```

### 4.2 Decision → write (kinetic path)

```
user/agent on a surface (P8)
  └─P7─ invokes Action Type  e.g. ConfirmDarkVessel(entityId, justification)
      ├─ precondition check (reads via P6 ontology)
      ├─ governance gate (P1: marking + purpose check via OPA adapter)
      ├─ effect applied → new envelope on P3 (the write becomes an event)
      └─ audit envelope on P3 (immutable, role: audit-log)
          └─P4/P5/P6 reproject exactly as in 4.1 — writes and ingests share one path
```

The symmetry of 4.1 and 4.2 is deliberate: **a human decision and a sensor reading are both just envelopes on the bus.** Every store is downstream of the bus, so every store is swappable.

---

## 5. What the rest of the repo specifies

- The exact **storage roles** and their contracts → [`10-STORAGE-ROLES.md`](./10-STORAGE-ROLES.md)
- How a feature decomposes into roles → [`11-CAPABILITY-ROLE-MAP.md`](./11-CAPABILITY-ROLE-MAP.md)
- The **adapter interface** each engine implements → [`12-ADAPTER-CONTRACT.md`](./12-ADAPTER-CONTRACT.md)
- The **manifest** that binds it all per client → [`13-CLIENT-MANIFEST.md`](./13-CLIENT-MANIFEST.md)
- Feature-by-feature parity → `20-PARITY-MATRIX/`
- The four worked client topologies → `30-CLIENTS/`
- Engine adapter sample code → `40-ADAPTERS/`
