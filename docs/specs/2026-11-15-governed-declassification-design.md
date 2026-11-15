# Governed declassification (marking removal) — design

**Date:** 2026-11-15 · **Status:** implemented on `feat/governed-declassification` · **Closes:** the open design item in `40-ADAPTERS/governance.md` §4.4

## Why

The marking model in `spine/` is union-only. Markings can be applied at a lineage ref and inherited by everything derived from it, but nothing can remove one. A union-only system over-marks: derived data accumulates every upstream marking until analysts cannot use anything, or administrators stop marking. Foundry avoids this with a governed removal. A transform declares `stop_propagating` for an input, the change needs a protected branch and an approver holding the marking's removal permission, and it affects only *new* output transactions ([remove inherited markings](https://www.palantir.com/docs/foundry/building-pipelines/remove-inherited-markings/), [remove markings](https://www.palantir.com/docs/foundry/building-pipelines/remove-markings/)).

## Goals

- A marking can stop flowing along **one lineage edge**, and only through a two-person, audited request-and-approval.
- The removal is **forward-only**. Approval changes nothing already stored. A derived entity loses the marking only when it is next re-derived (written through `upsertEntity`).
- The same marking arriving by **another path** still propagates. A marking applied **directly** at the derived ref is never removed this way.
- No in-process writer gains a new way to shrink markings outside this path. I1 and I2 (`spine/system.ts`) still hold everywhere else.

## Non-goals

- Retroactive removal. Re-derivation is the trigger, as in Foundry.
- Removing a marking applied at a node (unmarking a source). That would be a different operation, with a different blast radius.
- Checking that data was actually sanitised. Foundry does not do this either; the approver attests to it.
- Fleet-wide policy engines (OPA/Keycloak). The PDP is the bound `policy-identity` adapter.

## Anti-goals

- A removal that can be self-approved, or approved by someone who cannot see the marking.
- A raw-port route (`lineage.record`, `canonical-store.removeMarkings`) that skips approval.
- A shortcut edge that lets the marking around the blocked edge. The audit-only closure edges that `propagateMarking` used to record as `field-derivation` were such a shortcut.

## Design

### Lineage records (R12, append-only)

`LineageEdge.kind` gains three values. None is a data-flow edge, so `upstreamOf` and `downstreamOf` never return them.

| kind | meaning |
|---|---|
| `unmark-request` | a principal asks that `markings` stop flowing along `upstream → downstream`. Carries `declass: { id, by, reason, ts }` |
| `unmark` | the approval: the same `id`, plus `approvedBy`. Only this record has any effect |
| `marking-closure` | the audit record of which refs a `propagateMarking` call reached. Before this change these were recorded as `field-derivation` edges, which counted as data flow |

`effectiveMarkings(ref)` becomes path-aware. Marking *M* reaches *ref* if some path from a ref where *M* is applied crosses no edge approved as blocked for *M*. Two new port methods support the spine:

- `releasedMarkings(ref)`: the markings approved as blocked on any edge into *ref* or into one of its ancestors.
- `declassifications(id?)`: the request and approval records.

### Canonical store (R1)

`removeMarkings(type, id, markings)`: one statement, fields untouched, true if the set shrank. It is the mirror of `addMarkings`. The system handle refuses it from every caller. Only the re-derivation path inside `SystemPlatform` uses the raw method.

### Spine API (`spine/declassify.ts`, system component `governance.declassify`)

- `requestDeclassification(platform, principal, { upstream, downstream, markings, reason })` → request id. Refused unless lineage is bound, `upstream → downstream` is an existing flow edge, the principal holds every marking, and a reason is given.
- `approveDeclassification(platform, approver, id)`. Refused unless the request exists and is not yet approved, the approver is not the requester, the approver holds every marking, and `policy-identity.authorize(approver, 'declassify', { type: 'marking', markings })` allows. The internal edge PDP requires a role `declassify:<marking>` for each marking.
- `pendingDeclassifications(platform, principal)`: open requests whose markings the principal holds.

Each request and approval is an R11 `admin` record, marked with the markings it concerns.

### Write-side invariants (`spine/system.ts`)

- **I1 (refined):** an entity's stored markings include every marking *effective* at its ref.
- **I2 (refined):** stored markings never shrink, except when an entity is re-derived through `upsertEntity` and a stored marking is released at its ref, is not effective there any more, and was not given by the writer. Then it is dropped, its projections are re-stamped, and the drop is audited.
- `#stampDown` stamps each downstream ref only with the markings effective there, so applying a marking upstream does not jump a blocked edge.
- `#record` refuses `unmark-request`, `unmark` and `marking-closure` edges, because only `governance.declassify` writes them.

### Review hardening (2026-11-15)

An independent review found five issues. Four are fixed, each with a suite check:

- A marking the writer set at the entity, which it would also have inherited, could be dropped by an upstream release. Every marking the writer gives is now recorded as applied at the ref.
- `pendingDeclassifications` showed requests to principals who could not see an end of the edge. It now applies the same rule as the audit records: released markings plus every marking at either end.
- `requestDeclassification` was an oracle for lineage edges. It now checks the edge through the requester's governed lineage port, refuses an invisible edge and a missing one with the same message, and requires the named markings to be carried at the upstream ref.
- `recordDeclassification` trusted its caller's component name. It now also requires an approval to match a stored, unapproved request on the same edge and markings, made by someone other than the approver.

The re-derivation drop also re-reads the stored markings before re-stamping projections.

### Known limitations (accepted)

- A writer that echoes back a row's old markings, including the released one, re-applies that marking directly at the ref. This fails closed (the row stays marked).
- `platform.system()` handles are a guard against mistakes, not a security boundary. In-process code can reach an adapter's raw methods through `Object.getPrototypeOf` of a wrapped port, or by importing the adapter. That was true before this change for every port. A hardened boundary needs out-of-process enforcement (OPA, an engine-side PEP).
- A marking added through the raw `addMarkings` and never applied at a lineage ref can be dropped on re-derivation if an upstream edge releases it. The spine stamps through `applyMarking`, so this only affects callers that bypass it.
- Lineage files written before this change record propagation closures as `field-derivation` edges, which count as data flow and can carry a marking around a block. The proof scripts rebuild `./.data` on every run; any longer-lived store would need a one-time rewrite of those records to `marking-closure`.
- Walks stop at 64 hops.

## Verification

- **Adapter conformance** (`npm run conformance`): `removeMarkings`; path-aware `effectiveMarkings` with a blocked edge, a second path and a direct marking; closure records are not flow edges.
- **Governance suite** (`npm run governance`):
  - a request alone changes nothing;
  - self-approval is refused, as is approval without clearance or without the role;
  - approval leaves existing rows marked;
  - re-derivation drops the marking and audits the drop;
  - a second path still carries the marking, and so does a direct marking;
  - a later propagation does not jump the blocked edge;
  - raw `record` and `removeMarkings` are refused.
