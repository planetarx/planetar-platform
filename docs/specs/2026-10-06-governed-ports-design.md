# Governed ports — no ungoverned read or write path

**Date:** 2026-10-06 · **Status:** draft for review · **Roadmap:** completes the open items of
Phase 3 ([`90-ROADMAP.md`](../../90-ROADMAP.md)) inside this repo; closes suspects 1, 2 and 7 of
[`91-HANDOFF.md`](../../91-HANDOFF.md) §6.

## 1. Goal

In the runnable core, code acting for a principal can read only what that principal is cleared
for, through **every** storage role, and can change state only through the action gate. The
property is proven by an adversarial suite that attacks each role as a low-clearance principal.

Buyer wording this answers: "ability to support multiple security classification levels" (US
Navy NIWC call) and "granular permissions … even columns from a central location" (EMSA tender);
see `planetar-grants/planetar-niwc-mda/FIT.md` and
`planetar-grants/planetar-brainstorm/09-platform-benchmark-emsa-bdw.md`.

### Not in this spec

- The live `planetar-ontology` service (no markings or principals there yet).
- Markings on the `zmesg` wire.
- Keycloak and OPA behind the policy ports.
- The production-engine samples under `40-ADAPTERS/` (the contract doc is updated; sample code is not).
- Removing a marking (declassification).
- Handoff suspects 3–6 (approval durability, `rmSync`, `stop()`, broker sockets): real, not governance.

## 2. Evidence: what leaks today

Baseline on 2026-10-06, before any change: `boot:edge` 9/9, `boot:enterprise` 13/13,
`conformance` 14/14, `governance` 8/8, `automation` 8/8. `typecheck` could not be run: no `tsc`
is installed on this machine.

A throwaway probe planted one restricted vessel (`OPS-RESTRICTED`) among public ones and read
through the raw ports as a principal holding only `UNCLASS`:

| Read | Result | Should be |
|---|---|---|
| `Session.getEntity(restricted)` (control) | hidden | hidden |
| `object-index.search(text, principal)` | returns the restricted id | nothing |
| `object-index.searchCandidates` | returns the restricted id | not callable by a principal |
| `object-index.aggregate` count | 3 (includes it) | 2 |
| `graph.neighbors(public, 2 hops)` | returns it, and the node behind it | neither |
| `graph.shortestPath` between two public nodes joined only through it | length 2 | no path |
| `vector.knn` | returns its id | nothing |
| `timeseries-geo.range(restricted)` | 1 point | none |
| `analytics-olap` count over the entity table | 3 | 2 |
| `stream.subscribe` | delivers an `OPS-RESTRICTED` envelope | withheld |
| Entity derived **after** its source was marked | visible (did not inherit) | hidden |
| After `propagate()` restricts an entity: `object-index.search` | still returns it | nothing |

Two further holes found by reading:

- `spine/flows.ts:142` writes an entity straight to the store, outside the action gate.
- `KineticExecutor.invoke` answers "not found" for a missing target and "missing clearance" for
  a restricted one, which tells a low principal that the restricted entity exists.

Root cause of all of them: enforcement lives in one helper class (`Session`, two methods), while
`BoundPlatform.role()` hands the raw adapter for any role to any caller.

## 3. Approaches

**A. Facade only.** Wrap every port at the platform boundary; filter and redact results there.
One implementation covers every engine. Unsound for anything that is not a list of rows: a count,
a top-k, or a path computed over restricted rows cannot be fixed after the fact.

**B. Enforcement inside every adapter.** Each adapter stores markings and filters in its own
query. Correct for aggregates and fast at scale, but every adapter, including every future
engine, must get it right, and one forgetful adapter is a hole.

**C. Facade as the only gate, in-engine enforcement where filtering afterwards is unsound
(chosen).** The facade is the single way to obtain a port and re-checks every returned row
against the canonical store, so an adapter bug can only hide rows, never reveal them. Counts and
other aggregates run only on adapters that declare in-engine enforcement; elsewhere the facade
refuses. Paths and top-k are computed by the facade over visible rows only.

## 4. Design

### 4.1 The rule

`visible(principal, markings)` is true when the principal holds **every** marking on the row.
A row with no markings is public. The rule is fixed in the spine for this version;
`MarkingPolicy` is its one implementation. Anything the facade cannot resolve fails closed: an id
that is not in the canonical store is treated as not visible.

**Invariant I1.** An entity's stored markings always include every marking applied at any of its
lineage ancestors. **Invariant I2.** Stored markings never shrink.

### 4.2 Access handles replace `role()`

```ts
class BoundPlatform {
  as(principal: Principal): GovernedPlatform   // governed ports: reads filtered, no data writes
  system(component: string): SystemPlatform    // raw ports for spine internals, ingest, seeding
  has(r: RoleId): boolean
  closeAll(): Promise<void>
}
```

- The adapters are held in a `#private` field. There is no public `role()`.
- `GovernedPlatform.role(r)` returns a port that exposes only the methods marked *governed* or
  *open* in §4.3. `Session` is deleted; `platform.as(p).role('canonical-store')` replaces it.
- `SystemPlatform.role(r)` returns the raw adapter, with three wrapped methods that uphold I1 and
  I2 for every in-process writer (§4.6). Each `system('…')` call names its component, and the
  suite checks the set of call sites in `spine/` against an allow-list.
- This is protection against accidental bypass and the seam a network API will sit behind. It is
  not a sandbox against hostile in-process code.

### 4.3 Every port method is classified

`governed` = callable by a principal, result filtered · `open` = callable, unfiltered ·
`system` = not on the governed port.

| Role | governed | open | system |
|---|---|---|---|
| canonical-store | `getEntity`, `listEntities`, `getLinks` | | `putObservation`, `upsertEntity`, `putLink`, `transaction`, `markingsOf` (new) |
| hot-cache | `get`, `set`, `del`, `incr`, `publish`, `subscribe` | | |
| stream | `subscribe` | | `publish`, `ack` |
| object-index | `search`, `aggregate` | | `index`, `remove`, `searchCandidates`, `setMarkings` (new) |
| graph | `neighbors`, `shortestPath` | | `upsertNode`, `upsertEdge`, `query` |
| blob-cas | | `get`, `presignRead` | `put` |
| vector | `knn` | | `upsert`, `remove` |
| timeseries-geo | `range`, `downsample`, `within` | | `append` |
| analytics-olap | `query` | | `registerExternal` |
| registry | | `loadAll`, `get`, `versions` | `put` |
| audit-log | `scan`, `export` | | `append` |
| lineage | `upstreamOf`, `downstreamOf` | | `record`, `propagateMarking`, `applyMarking` (new), `effectiveMarkings` (new) |
| policy-identity | | `authenticate`, `authorize`, `members` | |
| work-queue | | `claim`, `complete`, `fail` | `enqueue` |

The table is a typed constant, `GOVERNANCE_RULES`. The suite fails if any method found on a bound
adapter is missing from it, so a new port method cannot ship unclassified.

How each governed method filters:

- **canonical-store** — `getEntity`: row check, then field redaction. `listEntities`: same per
  row, refilling the page so a short page does not reveal how many rows were withheld;
  rejects a `filter` or `orderBy` on a field the principal cannot see. `getLinks`: drops a link
  when either endpoint is not visible.
- **object-index** — `search`: passes the principal to the adapter, then re-checks every hit;
  `facets` and `total` are returned only from an enforcing adapter. `aggregate`: enforcing
  adapter only, otherwise `GovernanceError`.
- **graph** — `neighbors` and `shortestPath` are computed by the facade as a breadth-first walk
  of one-hop expansions that never steps onto or through a node the principal cannot see.
- **vector** — `knn` over-fetches and drops ids that are not visible until `k` remain or the
  store is exhausted.
- **timeseries-geo** — `range`, `downsample`: empty unless the entity is visible. `within`:
  drops points of entities that are not visible.
- **analytics-olap** — enforcing adapter only; rejects a dimension, measure or `where` on a field
  the principal cannot see.
- **stream** — withholds envelopes whose `markings` the principal does not hold.
- **audit-log** — withholds records whose `markings` the principal does not hold.
- **lineage** — drops edges that touch an entity the principal cannot see or carry markings it
  does not hold.
- **hot-cache** — keys and channels are prefixed with the principal's sorted clearance set, so
  principals with different clearances never share an entry.

### 4.4 In-engine enforcement

New capability flag `AdapterCapabilities.enforcesMarkings`. An adapter that sets it must:

1. persist markings with every row it stores;
2. accept `principal` on its query object (`SearchQuery` has it; add it to `AggQuery` and
   `OlapQuery`) and, when present, select and aggregate only rows whose markings the principal
   holds, using the rule of §4.1 exactly;
3. implement `setMarkings(type, id, markings)`.

In this change: `sqlite` object-index and `sqlite` analytics-olap become enforcing. No other
adapter needs it, because the facade handles their roles row by row.

### 4.5 Writes go through the action gate

- `GovernedPlatform` has no write method on any data role.
- `KineticExecutor.createEntity(spec, principal, cause?)` is added: authorises the principal for
  `create:<type>` with the markings being applied, refuses if the entity exists, writes through
  the system handle, records the lineage edge from `cause` when given, audits, and publishes the
  event. The flow engine's `createEntity` step calls it as the automation user, with markings =
  the step's markings ∪ the triggering envelope's markings.
- `KineticExecutor.invoke` loads its target through the governed read as the invoking principal.
  A target the principal cannot see produces the same result as a missing one. The returned
  entity is redacted for that principal, and a failed precondition on a field the principal
  cannot see reports the field and operator only.

### 4.6 Propagation that holds over time

- **Lineage port.** `applyMarking(ref, markings)` persists a marking at a ref.
  `effectiveMarkings(ref)` returns markings applied at the ref or at any upstream ref.
  `propagateMarking` keeps its signature and now also persists via `applyMarking`.
- **`propagate(platform, ref, markings, actor)`** applies the marking, stamps every downstream
  entity, calls `setMarkings` on every bound enforcing projection, and writes one audit record.
  (Today the demo writes that audit record by hand.)
- **System-handle wrappers.** Three methods are wrapped; everything else on the system handle is
  the raw adapter.
  - `canonical-store.upsertEntity` stores `given ∪ existing ∪ effectiveMarkings(entity ref)` and
    restamps enforcing projections when the set grew.
  - `lineage.record` stamps the downstream entity, if it exists, with
    `effectiveMarkings(upstream)`.
  - `object-index.index` stores `doc.markings ∪ markingsOf(id)`, so a projector cannot index a
    copy with fewer markings than the canonical row.

  The first two hold I1 for both orders: edge first then entity, or entity first then edge. When
  no lineage role is bound there is nothing to inherit and the wrappers only enforce I2.

### 4.7 Field-level security

- The field map moves into the manifest: `governance.fls: { <type>: { <field>: <marking> } }`.
  `compile()` builds the policy from it. The default policy is no longer permissive.
- A new helper `indexDocFor(policy, entity)` builds an `IndexDoc` with the entity's markings and
  **without** protected fields. Shared projections must be built with it.

### 4.8 Read audit

One `read` record per governed call: actor, `role.method`, a query summary, rows returned, rows
withheld. The record's own markings are the union over returned **and** withheld rows, so a
principal cannot learn a withheld count from its own audit trail. Manifest setting
`governance.audit.reads`: `marked` (default: only calls that returned or withheld a marked row),
`all`, or `none`.

## 5. Interface changes

| Where | Change |
|---|---|
| `spine/contracts.ts` | `BoundPlatform`: remove `role()`; add `as()`, `system()`; private adapter map |
| `spine/ports.ts` | `AdapterCapabilities.enforcesMarkings`; `CanonicalStore.markingsOf`; `ObjectIndex.setMarkings`; `Lineage.applyMarking`, `effectiveMarkings`; `principal` on `AggQuery`, `OlapQuery`; `GovernedPortByRole` |
| `spine/governance.ts` | `GOVERNANCE_RULES`, `GovernedPlatform`, `SystemPlatform`, `GovernanceError`, `indexDocFor`; `propagate` gains projections + audit; `Session` removed |
| `spine/kinetic.ts` | `createEntity`; governed target load; redacted result |
| `spine/flows.ts` | `createEntity` step via kinetic; trigger markings inherited |
| `spine/compiler.ts` | policy from `governance.fls`; read-audit setting; default policy not permissive |
| `adapters/sqlite/canonical-store.ts` | `markingsOf` |
| `adapters/sqlite/object-index.ts` | markings column, principal filter in `search` and `aggregate`, `setMarkings`, `enforcesMarkings` |
| `adapters/sqlite/analytics-olap.ts` | principal filter over the entity table, `enforcesMarkings` |
| `adapters/fs/lineage.ts` | `applyMarking`, `effectiveMarkings` |
| `spine/conformance.ts`, `boot/*.ts` | move to `system()` / `as()` |
| `spine/governance-conformance.ts` (new), `boot/governance.ts` | the adversarial suite |

New signatures:

```ts
// canonical-store — ids absent from the store are omitted from the result
markingsOf(ids: EntityId[]): Promise<Record<EntityId, MarkingId[]>>
// object-index (and any other enforcing projection)
setMarkings(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void>
// lineage
applyMarking(ref: string, markings: MarkingId[]): Promise<void>
effectiveMarkings(ref: string): Promise<MarkingId[]>
// kinetic
createEntity(
  spec: { type: TypeName; id: EntityId; fields: Record<FieldName, Json>; markings?: MarkingId[] },
  principal: Principal, nowNs: bigint, cause?: { envelopeId: string; markings?: MarkingId[] },
): Promise<ActionResult>
```

`AdapterContext.marking` stays as it is; the zero-service adapters do not use it.

Nothing outside this repo imports it (checked 2026-10-06), so the `role()` removal breaks no
other repo.

## 6. Testing

`npm run governance` becomes the adversarial suite. It compiles one platform with every data
role bound, plants public, restricted and derived entities plus one protected field, and checks:

1. **No leak, per role.** Every row of the §2 table comes back clean for the low principal, and
   complete for the high principal.
2. **Inheritance.** Marking a source restricts existing derivations and ones created afterwards,
   in both write orders. After `propagate()`, search and count change for the low principal.
3. **Writes.** The governed port exposes no `system` method. A flow's `createEntity` appears in
   the audit log as an action, carries the trigger's markings, and has a lineage edge.
   `invoke` on a restricted target is indistinguishable from a missing one.
4. **Field oracle.** Filtering, sorting, faceting or aggregating on a protected field is
   rejected; a protected value is not findable by text search.
5. **Cache.** Two principals with different clearances do not see each other's entries.
6. **Audit.** Marked reads are recorded; a record with withheld rows is not visible to the
   principal it was withheld from.
7. **Completeness.** Every method on every bound adapter is classified; `system()` call sites
   match the allow-list.

Written first, so it fails against today's code for the reasons in §2. The five existing checks
must stay green. `typecheck` must pass under `tsc --strict`, which first needs TypeScript and
`@types/node` installed (git-ignored `node_modules`; the runtime stays dependency-free).

## 7. Known limitations of this version

- A protected field cannot be searched, filtered or aggregated by anyone, including cleared
  principals.
- A blob is readable by whoever holds its handle. Hiding the field that carries the handle is the
  only control.
- Work-queue payloads carry no markings. Approval prompts must not embed restricted values.
- Registry content (schemas, flows, action definitions) is readable by every principal.
- Aggregates are unavailable on an engine that does not enforce in-engine.
- The facade's graph walk and row re-checks cost one canonical lookup per batch of ids; fine for
  the zero-service tier, to be replaced by in-engine enforcement on production engines.
- No information-flow control beyond inheritance at creation: an action that copies a value from
  a restricted entity into a public one is not detected.

## 8. Decisions that need your sign-off

| # | Decision | Alternative |
|---|---|---|
| D1 | Remove the public `platform.role()`; callers choose `as(principal)` or `system(component)` | Keep `role()` and rely on convention (how hole 2 happened) |
| D2 | The visibility rule is fixed in the spine until the Keycloak/OPA work | Keep it pluggable now; in-engine filters could then disagree with the policy |
| D3 | Refuse aggregates on engines without in-engine enforcement | Approximate by filtering rows in the facade; wrong for large sets |
| D4 | Protected fields are excluded from shared projections | Per-field index visibility; much larger |
| D5 | Markings only grow; no declassification | Add an admin action for removal now |
| D6 | Read audit defaults to `marked` | `all` (heavy) or `none` |
| D7 | Unknown ids are hidden | Treat ids absent from the canonical store as public |

## 9. Done when

- `npm run governance` passes with every check in §6, and the §2 probe comes back clean.
- `boot:edge`, `boot:enterprise`, `conformance`, `automation` are green; `typecheck` is clean.
- `12-ADAPTER-CONTRACT.md`, the Phase 3 note in `90-ROADMAP.md`, `91-HANDOFF.md` §6 and the
  governance rows of `20-PARITY-MATRIX/` state what is now built, with backing paths.
