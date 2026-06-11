# spine/ — the locked contracts (Phase 0)

This directory is **Phase 0 of [`../90-ROADMAP.md`](../90-ROADMAP.md)**: the authoritative TypeScript definitions that the design docs describe and the [`../40-ADAPTERS/`](../40-ADAPTERS/) sample code references. It resolves the contract-drift the adapter generation surfaced (types and ports were referenced but not pinned anywhere).

| File | What it locks |
|---|---|
| [`model.ts`](./model.ts) | The canonical data model — kernel, `CanonicalEntity`, `Observation`, `Link`, `Identifier`, `Source`, `Event`, `Discrepancy`, `SchemaType`, plus `FieldFilter` / `Page` / `Tx` / `HealthStatus` / `BlobHandle`. The single source of truth for **shape**. |
| [`ports.ts`](./ports.ts) | All **14 role ports** (`CanonicalStore` … `WorkQueue`) + the base `Adapter` lifecycle + `MarkingResolver`/`Principal` (governance) + `PortByRole` typed lookup. The single source of truth for **placement contracts**. |
| [`contracts.ts`](./contracts.ts) | `ROLE_CONTRACT` (what each role demands), `satisfies()` (the compile-time check), the binder skeleton (`registerAdapter` / `bindRole` / `BoundPlatform`), the R2-defaultable / R14-not asymmetry, and shared-resource multiplexing. |

## Invariants these encode

- **Spine code imports only `ports.ts` + `model.ts`.** Never an engine driver. (Adapters in `40-ADAPTERS/` import the ports and implement them.)
- **A binding is checkable.** `satisfies(role, adapter.capabilities)` is a pure function; the manifest compiler (Phase 1) calls it per role, so an under-provisioned client is a *compile error*, not a runtime incident.
- **Federated/external engines are first-class.** `AdapterCapabilities.external` lets R9 bind BigQuery/Snowflake query-in-place without claiming rebuildable-from-stream.
- **Governance is woven in, not bolted on.** Every `AdapterContext` carries a `MarkingResolver`; adapters are Policy Enforcement Points. The `Lineage.propagateMarking` method is the seam for the roadmap's clone-resistant propagating-security (Phase 3).

## Status

These are **interface + contract definitions** (no engine code yet) and are not wired to a build/test harness in this repo. Next (Phase 1): the manifest compiler that loops `bindRole` over a manifest's required roles, plus porting the already-built `SqliteCanonicalStore`/`BrokerStream`/`FsBlobCas` to register against `ADAPTER_REGISTRY` so the maritime edge manifest boots from a manifest.

> Authored during an autonomous continuation of the design work (reversible local scaffolding). If the direction shifts, these are throwaway-cheap.
