# Governed Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `planetar-platform`, code acting for a principal can read only what that principal is cleared for through every storage role, and can change state only through the action gate — proven by an adversarial suite.

**Architecture:** `BoundPlatform` stops handing out raw adapters. A caller takes `platform.as(principal)` (governed ports that re-check every returned row against the canonical store) or `platform.system(component)` (raw ports whose five write methods uphold the marking invariants). Counts run only on engines that filter in-engine; graph paths and nearest-neighbour results are computed by the gate over visible rows.

**Tech Stack:** TypeScript run directly by Node ≥ 22.18 (type stripping), `node:sqlite`, zero npm runtime dependencies. Tests are the repo's runnable check scripts (`npm run governance`, `conformance`, `automation`, `boot:edge`, `boot:enterprise`) plus `npm run typecheck`.

**Spec:** [`docs/specs/2026-10-06-governed-ports-design.md`](../specs/2026-10-06-governed-ports-design.md)

## Global Constraints

- Node ≥ 22.18 runs the `.ts` files directly: **erasable syntax only** (no `enum`, no parameter properties, no namespaces) and **explicit `.ts` extensions** on relative imports.
- **Zero npm runtime dependencies.** TypeScript and `@types/node` are installed with `--no-save` into the git-ignored `node_modules`; `package.json` does not change.
- `node:sqlite` needs `--experimental-sqlite`; the npm scripts already pass it.
- Anything persisted that may contain a `bigint` timestamp goes through `jstr` / `jparse` (`spine/json.ts`).
- **Never start, stop or connect to `planetar-broker`.** Every check uses the `file` / `sqlite` engines under `./.data` (git-ignored).
- Spine code imports only `spine/*.ts`; never an engine driver.
- The visibility rule is fixed (spec §4.1): a principal sees a row iff it holds **every** marking on it. A row with no markings is public. An id the canonical store does not know is hidden.
- Invariant I1: an entity's stored markings include every marking applied at a lineage ancestor. Invariant I2: stored markings never shrink.
- Work on branch `governed-ports`. Commit inside `planetar-platform` only. Do not commit `node_modules` or `.data`.

## Review Focus

The five conditions the spec implies that the task-by-task tests would otherwise miss. Each is pinned by a check added in **Task 5**, which owns them.

1. **A client that binds only some roles** (no lineage, index, graph, cache, queue). The gate and the write wrappers must work, not throw. → the suite runs a second time against a five-role manifest.
2. **Unmarked rows and a principal with no clearances.** An unmarked row is public; a listing where every row is withheld returns an empty final page and terminates. → `rule: an unmarked row is public…`
3. **Concurrent actions racing a propagation on one store.** Neither a write nor a marking may be lost, and nothing may crash. → `action gate: concurrent actions and a propagation…` (this found a crash that predates this work; Task 5 fixes it).
4. **`governance.audit.reads` set to `none`.** Only the default mode is exercised elsewhere. → `[minimal roles] governance.audit.reads = none writes no read records`
5. **A projection row for an id the canonical store does not know** (a graph node, a track). It is hidden from everyone rather than leaked or crashing. → `graph: a node the canonical store does not know…`, `timeseries-geo: a track for an id…`

## What review changed

Rehearsing this plan produced five changes that are not in the approved spec's text. Task 6 writes them into the spec. The last one is stricter than what the spec approved: the spec left the work queue open to principals with a note that payloads are unmarked.

| Found by | Problem | Fixed in | Pinned by |
|---|---|---|---|
| automated security review | A principal could group the SQLite OLAP engine by the raw `body` column and read protected fields, or query the unmarked `link` table | Task 1 (adapter principal mode), Task 2 (gate) | `analytics-olap: a principal cannot reach a storage column or another table` |
| automated security review | A caller-supplied vector filter went to the engine unchecked: an oracle for a protected field on engines that hold metadata | Task 2 | `vector: an engine filter that names a protected field is refused, whatever its shape` |
| follow-up check for the same pattern | The graph traversal filter had the same gap | Task 2 | `graph: a traversal filter on a protected field is refused` |
| follow-up check for the same pattern | An action that writes a protected field put the value in its audit detail and event payload, both readable by principals who can see the target | Task 3 | `action gate: writing a protected field does not reveal its value through the audit log or the event stream` |
| automated security review | Work-queue jobs carry no markings, yet `claim`, `complete` and `fail` were open to any principal: a claim could expose a restricted approval payload, and anyone could complete another's job | Task 1 (port type), Task 2 (rule table, gate) | `work-queue: a principal cannot claim, complete or fail jobs (they carry no markings)` |

A sixth fix, the transaction crash in Task 5, is a bug that predates this work.

## How the code steps work

Every code step is a unified diff, numbered **Patch 1** to **Patch 11**. They were produced by rehearsing this plan on a throwaway clone and apply in order on top of commit `51afe11` plus the spec. Extract and apply patch *N* exactly:

```bash
N=1   # the patch number named in the step
awk -v n="$N" '/^````diff$/ { c++; on = (c == n); next } /^````$/ { on = 0 } on' docs/plans/2026-10-06-governed-ports.md >| /tmp/governed-ports-$N.patch
git apply --check /tmp/governed-ports-$N.patch && git apply /tmp/governed-ports-$N.patch
```

Every "Expected" line below is output that was observed in the rehearsal, not a prediction. If `git apply --check` fails, stop: the tree is not where the plan expects it.

## File map

| File | Responsibility | Task |
|---|---|---|
| `spine/ports.ts` | port additions: `markingsOf`, `setMarkings`, `applyMarking`, `effectiveMarkings`, `principal` on aggregate queries, `enforcesMarkings`, `GovernedPortByRole` | 1 |
| `adapters/sqlite/canonical-store.ts` | `markingsOf`; queued transactions | 1, 5 |
| `adapters/sqlite/object-index.ts` | markings column, in-engine principal filter, `setMarkings` | 1 |
| `adapters/sqlite/analytics-olap.ts` | principal mode: `from` is a canonical type, names are logical fields read through bound JSON paths, rows filtered by markings | 1 |
| `adapters/fs/lineage.ts` | applied markings persisted and inherited | 1 |
| `spine/conformance.ts` | per-adapter contract checks | 1, 5 |
| `spine/governance.ts` (rewritten) | `MarkingPolicy`, `GOVERNANCE_RULES`, `GovernanceError`, `indexDocFor`, `propagate` | 2 |
| `spine/governed.ts` (new) | `GovernedPlatform`: the read gate, one filter per role | 2 |
| `spine/system.ts` (new) | `SystemPlatform`: raw ports + the five invariant-keeping wrappers | 2 |
| `spine/contracts.ts` | `BoundPlatform.as()` / `.system()`; `role()` removed in Task 4 | 2, 4 |
| `spine/compiler.ts` | policy and audit mode from the manifest's `governance` block | 2 |
| `spine/governance-conformance.ts` (new) | the adversarial suite | 2, 3, 4, 5 |
| `boot/governance.ts` (rewritten) | runs the suite against a full and a minimal client | 2, 5 |
| `spine/kinetic.ts` | governed target load, redacted result, `createEntity` | 3 |
| `spine/flows.ts` | `createEntity` step through the action gate | 3 |
| `boot/boot.ts`, `boot/automation.ts` | take the system handle | 4 |
| `*.md` (12 files) | what is now built, with backing paths | 6 |

---

### Task 0: Branch, tooling, baseline

**Files:**
- Create: none (commits the already-written `docs/specs/2026-10-06-governed-ports-design.md` and this plan)

**Interfaces:**
- Consumes: nothing
- Produces: branch `governed-ports`; a working `npm run typecheck`

- [ ] **Step 1: Confirm the starting tree**

Run: `cd ~/github/planetarx/planetar-platform && git status --short && git log --oneline | head -1`
Expected: only `?? docs/` is listed, and the head commit is `51afe11 Relicense to GPLv3 (single-license model; monetize via services)`.

- [ ] **Step 2: Branch**

Run: `git checkout -b governed-ports`

- [ ] **Step 3: Install the type checker (dev only, not saved)**

Run: `npm install --no-save --no-audit --no-fund typescript @types/node@22 && git status --short`
Expected: `added 4 packages`; `git status` still lists only `?? docs/` (`node_modules/` is git-ignored). The rehearsal used TypeScript 7.0.2.

- [ ] **Step 4: Record the baseline**

Run:
```bash
for s in boot:edge boot:enterprise conformance governance automation; do npm run -s "$s" 2>&1 | grep -E "[0-9]+/[0-9]+ .*(passed|conformant)"; done; npm run -s typecheck; echo "tsc exit=$?"
```
Expected:
```
9/9 checks passed.
13/13 checks passed.
14/14 adapters conformant.
8/8 governance checks passed.
8/8 automation checks passed.
tsc exit=0
```

- [ ] **Step 5: Commit the spec and this plan**

```bash
git add docs && git commit -m "docs: governed-ports design spec and implementation plan" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Adapter capabilities

Additive only: new port methods and what four adapters need to support the gate. Nothing that exists changes behaviour.

**Files:**
- Modify: `spine/ports.ts`, `spine/conformance.ts`
- Modify: `adapters/sqlite/canonical-store.ts`, `adapters/sqlite/object-index.ts`, `adapters/sqlite/analytics-olap.ts`, `adapters/fs/lineage.ts`

**Interfaces:**
- Consumes: nothing new
- Produces (all in `spine/ports.ts`):
  - `AdapterCapabilities.enforcesMarkings?: boolean`
  - `CanonicalStore.markingsOf(ids: EntityId[]): Promise<Record<EntityId, MarkingId[]>>` — ids not in the store are omitted; an entity without markings maps to `[]`
  - `ObjectIndex.setMarkings(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void>`
  - `Lineage.applyMarking(ref: string, markings: MarkingId[]): Promise<void>` and `Lineage.effectiveMarkings(ref: string): Promise<MarkingId[]>`
  - `LineageEdge.kind` gains `'marking'` (a record that markings were applied at `upstream`; never returned by `upstreamOf` / `downstreamOf`)
  - `principal?: Principal` on `AggQuery` and `OlapQuery`. On `OlapQuery` it changes how the query is read: `from` is a canonical type and every dimension, measure field and `where` field is a logical field of it. An enforcing engine must not resolve any of them as a storage column or another table.
  - `GovernedPortByRole` — per role, the `Pick<>` of methods a principal may call

- [ ] **Step 1: Write the failing checks**

Apply Patch 1. It adds three checks to `spine/conformance.ts`: `markingsOf` on the canonical store; principal filtering and `setMarkings` on any index that declares `enforcesMarkings`; applied-marking inheritance on lineage.

**Patch 1**

````diff
diff --git a/spine/conformance.ts b/spine/conformance.ts
index b6c1e28..38e75b9 100644
--- a/spine/conformance.ts
+++ b/spine/conformance.ts
@@ -3,7 +3,7 @@
 // This is what makes adapters swap-safe across clients (12-ADAPTER-CONTRACT §5).
 import { ADAPTER_REGISTRY, type RoleBinding } from './contracts.ts';
 import { consoleLogger, PERMISSIVE_MARKING, makeShared } from './compiler.ts';
-import type { RoleId, Adapter, AdapterContext, CanonicalStore, ObjectIndex, WorkQueue, Stream, BlobCas, AuditLog, Lineage, Registry, PolicyIdentity, Cache, VectorStore, GraphStore, TimeSeriesGeo } from './ports.ts';
+import type { RoleId, Adapter, AdapterContext, Principal, CanonicalStore, ObjectIndex, WorkQueue, Stream, BlobCas, AuditLog, Lineage, Registry, PolicyIdentity, Cache, VectorStore, GraphStore, TimeSeriesGeo } from './ports.ts';
 import type { Json } from './model.ts';
 
 export interface ConformanceReport { role: RoleId; engine: string; ok: boolean; checks: { name: string; ok: boolean; info: string }[]; }
@@ -40,6 +40,15 @@ const SUITES: Partial<Record<RoleId, (a: Adapter, t: T) => Promise<void>>> = {
       try { await s.transaction(async () => { await s.upsertEntity({ id: 'c2', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} }); throw new Error('boom'); }); } catch { /* expected */ }
       return 'rolled back';
     });
+    await t('markingsOf: known ids with their markings, unknown ids omitted', async () => {
+      await s.upsertEntity({ id: 'm1', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {}, markings: ['A', 'B'] });
+      await s.upsertEntity({ id: 'm2', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} });
+      const m = await s.markingsOf(['m1', 'm2', 'nope']);
+      if ((m.m1 ?? []).slice().sort().join() !== 'A,B') throw new Error(`m1 = ${JSON.stringify(m.m1)}`);
+      if (!Array.isArray(m.m2) || m.m2.length !== 0) throw new Error(`m2 = ${JSON.stringify(m.m2)}`);
+      if ('nope' in m) throw new Error('unknown id must be omitted');
+      return 'ok';
+    });
   },
   'object-index': async (a, t) => {
     const ix = a as ObjectIndex;
@@ -49,6 +58,19 @@ const SUITES: Partial<Record<RoleId, (a: Adapter, t: T) => Promise<void>>> = {
       if (!(await ix.searchCandidates('x:T', { mmsi: '123' }, 5)).includes('i1')) throw new Error('no candidate');
       return 'ok';
     });
+    if (a.capabilities.enforcesMarkings) await t('enforces markings: search + aggregate filter by principal; setMarkings restricts later', async () => {
+      const low: Principal = { id: 'low', roles: [], clearances: ['U'] };
+      const high: Principal = { id: 'high', roles: [], clearances: ['U', 'S'] };
+      const count = async (p?: Principal) => (await ix.aggregate({ type: 'e:T', groupBy: [], metrics: [{ fn: 'count' }], principal: p })).rows[0].metrics.count;
+      const ids = async (p?: Principal) => (await ix.search({ type: 'e:T', text: 'charlie', principal: p })).hits.map((h) => h.id).sort().join();
+      await ix.index('e:T', 'pub', { id: 'pub', type: 'e:T', text: 'charlie one', fields: {}, markings: ['U'] });
+      await ix.index('e:T', 'sec', { id: 'sec', type: 'e:T', text: 'charlie two', fields: {}, markings: ['U', 'S'] });
+      if (await ids(low) !== 'pub' || await ids(high) !== 'pub,sec') throw new Error(`search low=${await ids(low)} high=${await ids(high)}`);
+      if (await count(low) !== 1 || await count(high) !== 2 || await count() !== 2) throw new Error(`count low=${await count(low)} high=${await count(high)} none=${await count()}`);
+      await ix.setMarkings('e:T', 'pub', ['U', 'S']);
+      if (await ids(low) !== '' || await count(low) !== 0) throw new Error('setMarkings did not restrict the row');
+      return 'ok';
+    });
   },
   'work-queue': async (a, t) => {
     const q = a as WorkQueue;
@@ -80,6 +102,17 @@ const SUITES: Partial<Record<RoleId, (a: Adapter, t: T) => Promise<void>>> = {
   'lineage': async (a, t) => {
     const l = a as Lineage;
     await t('record + downstream + propagate', async () => { await l.record({ upstream: 'A', downstream: 'B', kind: 'transform' }); await l.record({ upstream: 'B', downstream: 'C', kind: 'transform' }); const aff = await l.propagateMarking('A', ['M']); if (!aff.includes('B') || !aff.includes('C')) throw new Error('closure wrong'); return `${aff.length}`; });
+    await t('effectiveMarkings: a marking applied at a ref is inherited downstream, in either order', async () => {
+      const eff = async (ref: string) => (await l.effectiveMarkings(ref)).slice().sort().join();
+      if (await eff('C') !== 'M') throw new Error(`C should inherit M from A (propagated above), got '${await eff('C')}'`);
+      await l.record({ upstream: 'C', downstream: 'D', kind: 'transform' });            // edge recorded AFTER the marking
+      if (await eff('D') !== 'M') throw new Error(`late derivation D got '${await eff('D')}'`);
+      await l.applyMarking('B', ['N']);
+      if (await eff('D') !== 'M,N' || await eff('A') !== 'M') throw new Error(`after N at B: D='${await eff('D')}' A='${await eff('A')}'`);
+      if (await eff('unrelated') !== '') throw new Error('unrelated ref must have no markings');
+      if ((await l.downstreamOf('A')).some((e) => e.kind === 'marking')) throw new Error('marking records must not appear as edges');
+      return 'ok';
+    });
   },
   'registry': async (a, t) => {
     const r = a as Registry;
````

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run -s conformance 2>&1 | grep -E "❌|conformant"`
Expected:
```
  ❌ canonical-store/sqlite — markingsOf: known ids with their markings, unknown ids omitted: s.markingsOf is not a function
  ❌ lineage/fs — effectiveMarkings: a marking applied at a ref is inherited downstream, in either order: l.effectiveMarkings is not a function
12/14 adapters conformant.
```
(The index check does not run yet: no adapter declares `enforcesMarkings`.)

- [ ] **Step 3: Implement**

Apply Patch 2. Note the OLAP adapter: with a principal it never interpolates a caller-supplied name into SQL and never selects a column; it reads `$.fields."<name>"` out of the entity body through a bound parameter. That closes a field-level-security bypass (grouping by the raw `body` column, or querying the unmarked `link` table) that an automated security review found in the first rehearsal of this plan.

**Patch 2**

````diff
diff --git a/adapters/fs/lineage.ts b/adapters/fs/lineage.ts
index 14d6e55..8d4d3f7 100644
--- a/adapters/fs/lineage.ts
+++ b/adapters/fs/lineage.ts
@@ -22,7 +22,7 @@ export class FsLineage implements Lineage {
   async upstreamOf(ref: string, maxHops = 8): Promise<LineageEdge[]> { return this.walk(ref, maxHops, 'up'); }
   async downstreamOf(ref: string, maxHops = 8): Promise<LineageEdge[]> { return this.walk(ref, maxHops, 'down'); }
   private walk(ref: string, maxHops: number, dir: 'up' | 'down'): LineageEdge[] {
-    const edges = this.all();
+    const edges = this.all().filter((e) => e.kind !== 'marking');
     const seen = new Set<string>([ref]);
     const out: LineageEdge[] = [];
     let frontier = [ref];
@@ -36,13 +36,22 @@ export class FsLineage implements Lineage {
     }
     return out;
   }
-  /** THE moat: union+stamp `markings` down the downstream closure of `ref`. Returns affected refs. */
+  /** THE moat: apply `markings` at `ref` and return its downstream closure. Stamping the store
+   *  rows is the spine's job (spine/system.ts); the propagation edges make the closure auditable. */
   async propagateMarking(ref: string, markings: string[]): Promise<string[]> {
-    const affected = (await this.downstreamOf(ref)).map((e) => e.downstream);
-    // a real impl writes the marking onto each downstream store row via its adapter PEP (Phase 3);
-    // here we record the propagation edges so the closure is auditable.
+    await this.applyMarking(ref, markings);
+    const affected = [...new Set((await this.downstreamOf(ref)).map((e) => e.downstream))];
     for (const d of affected) await this.record({ upstream: ref, downstream: d, kind: 'field-derivation', markings });
-    return [...new Set(affected)];
+    return affected;
+  }
+  async applyMarking(ref: string, markings: string[]): Promise<void> {
+    if (markings.length) await this.record({ upstream: ref, downstream: ref, kind: 'marking', markings });
+  }
+  async effectiveMarkings(ref: string): Promise<string[]> {
+    const at = new Set([ref, ...this.walk(ref, 64, 'up').map((e) => e.upstream)]);
+    const out = new Set<string>();
+    for (const e of this.all()) if (e.kind === 'marking' && at.has(e.upstream)) for (const m of e.markings ?? []) out.add(m);
+    return [...out];
   }
   async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 50 }; }
   async close(): Promise<void> {}
diff --git a/adapters/sqlite/analytics-olap.ts b/adapters/sqlite/analytics-olap.ts
index 3ac32d1..8c54679 100644
--- a/adapters/sqlite/analytics-olap.ts
+++ b/adapters/sqlite/analytics-olap.ts
@@ -1,27 +1,44 @@
 // adapters/sqlite/analytics-olap.ts — R9 columnar-ish analytics over node:sqlite GROUP BY.
 // Points at the same db the canonical-store writes, so reports run over the live entity table.
 // Real scale binds ClickHouse/DuckDB or federates BigQuery/Snowflake (40-ADAPTERS/timeseries-olap.md).
+//
+// Two modes, chosen by whether the query carries a principal:
+//   system    — `from` is a table and names are columns (operators and report builders).
+//   principal — `from` is a canonical TYPE and every name is a logical FIELD of it. No storage
+//               column or other table can be reached, and only rows whose every marking the
+//               principal holds are aggregated (docs/specs/2026-10-06-governed-ports-design.md §4.4).
 import { DatabaseSync } from 'node:sqlite';
 import { openDb } from './_db.ts';
-import type { AnalyticsOlap, AdapterContext, AdapterCapabilities, OlapQuery, OlapResult } from '../../spine/ports.ts';
+import type { AnalyticsOlap, AdapterContext, AdapterCapabilities, OlapQuery, OlapResult, Principal } from '../../spine/ports.ts';
 import type { Json, HealthStatus } from '../../spine/model.ts';
 import { registerAdapter } from '../../spine/contracts.ts';
 
 const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;   // identifiers must be plain (no injection)
+const FIELD = /^[A-Za-z0-9_:.-]+$/;         // a logical field name, e.g. 'planetar:status'
+const FNS = ['count', 'sum', 'avg', 'min', 'max'];
+const OPS: Record<string, string> = { eq: '=', ne: '<>', gt: '>', lt: '<', gte: '>=', lte: '<=' };
+// a canonical row is selectable when it carries no marking outside the principal's clearances
+const VISIBLE = `NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(body,'$.markings'),'[]')) m WHERE m.value NOT IN (SELECT value FROM json_each(?)))`;
 
 export class SqliteOlap implements AnalyticsOlap {
   private db!: DatabaseSync;
-  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 500 };
+  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 500, enforcesMarkings: true };
 
   async init(ctx: AdapterContext): Promise<void> {
     this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
   }
+
   async query(q: OlapQuery): Promise<OlapResult> {
+    return q.principal ? this.typedQuery(q, q.principal) : this.tableQuery(q);
+  }
+
+  /** system mode: plain GROUP BY over a table's own columns. */
+  private tableQuery(q: OlapQuery): OlapResult {
     const table = q.from;
     if (!SAFE.test(table)) throw new Error(`unsafe table '${table}'`);
     const dims = q.dimensions.filter((d) => SAFE.test(d));
     const measures = q.measures.map((m) => {
-      const fn = ['count', 'sum', 'avg', 'min', 'max'].includes(m.fn) ? m.fn : 'count';
+      const fn = FNS.includes(m.fn) ? m.fn : 'count';
       const col = m.field && SAFE.test(m.field) ? m.field : '*';
       const as = SAFE.test(m.as) ? m.as : 'm';
       return `${fn}(${col}) AS ${as}`;
@@ -33,6 +50,47 @@ export class SqliteOlap implements AnalyticsOlap {
     const rows = this.db.prepare(`SELECT ${sel} FROM ${table}${grp}${ord}${lim}`).all() as Record<string, Json>[];
     return { rows };
   }
+
+  /** principal mode: every name is a field read out of the entity body through a BOUND JSON
+   *  path, so nothing the caller sends becomes SQL text or selects a storage column. */
+  private typedQuery(q: OlapQuery, principal: Principal): OlapResult {
+    const path = (field: string): string => {
+      if (!FIELD.test(field)) throw new Error(`unsupported field name '${field}'`);
+      return `$.fields."${field}"`;
+    };
+    const params: (string | number)[] = [];
+    const out: { key: string; col: string }[] = [];
+    const sel: string[] = [];
+    q.dimensions.forEach((d, i) => { sel.push(`json_extract(body, ?) AS d${i}`); params.push(path(d)); out.push({ key: d, col: `d${i}` }); });
+    q.measures.forEach((m, i) => {
+      if (!SAFE.test(m.as)) throw new Error(`unsafe measure name '${m.as}'`);
+      const fn = FNS.includes(m.fn) ? m.fn : 'count';
+      if (m.field) { sel.push(`${fn}(json_extract(body, ?)) AS m${i}`); params.push(path(m.field)); } else sel.push(`count(*) AS m${i}`);
+      out.push({ key: m.as, col: `m${i}` });
+    });
+    if (!sel.length) throw new Error('a query needs at least one dimension or measure');
+
+    let sql = `SELECT ${sel.join(', ')} FROM entity WHERE type = ? AND ${VISIBLE}`;
+    params.push(q.from, JSON.stringify(principal.clearances));
+    for (const w of q.where ?? []) {
+      const op = OPS[w.op];
+      if (!op) throw new Error(`unsupported filter op '${w.op}'`);
+      if (typeof w.value !== 'string' && typeof w.value !== 'number') throw new Error(`unsupported filter value for '${w.field}'`);
+      sql += ` AND json_extract(body, ?) ${op} ?`; params.push(path(w.field), w.value);
+    }
+    if (q.dimensions.length) sql += ` GROUP BY ${q.dimensions.map((_, i) => `d${i}`).join(', ')}`;
+    if (q.orderBy?.length) {
+      sql += ' ORDER BY ' + q.orderBy.map((o) => {
+        const hit = out.find((c) => c.key === o.key);
+        if (!hit) throw new Error(`cannot order by '${o.key}': not a dimension or measure of this query`);
+        return `${hit.col} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`;
+      }).join(', ');
+    }
+    if (q.limit) sql += ` LIMIT ${Number(q.limit)}`;
+    const rows = this.db.prepare(sql).all(...params) as Record<string, Json>[];
+    return { rows: rows.map((r) => Object.fromEntries(out.map((c) => [c.key, r[c.col]]))) };
+  }
+
   async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 500 }; }
   async close(): Promise<void> { this.db.close(); }
 }
diff --git a/adapters/sqlite/canonical-store.ts b/adapters/sqlite/canonical-store.ts
index 45ffd0a..814317c 100644
--- a/adapters/sqlite/canonical-store.ts
+++ b/adapters/sqlite/canonical-store.ts
@@ -4,7 +4,7 @@ import { mkdirSync } from 'node:fs';
 import { dirname } from 'node:path';
 import type { CanonicalStore } from '../../spine/ports.ts';
 import type { AdapterContext, AdapterCapabilities } from '../../spine/ports.ts';
-import type { CanonicalEntity, Observation, Link, EntityId, TypeName, Page, EntityQuery, Tx, HealthStatus } from '../../spine/model.ts';
+import type { CanonicalEntity, Observation, Link, EntityId, TypeName, Page, EntityQuery, Tx, HealthStatus, MarkingId } from '../../spine/model.ts';
 import { jstr, jparse } from '../../spine/json.ts';
 import { registerAdapter } from '../../spine/contracts.ts';
 
@@ -51,6 +51,15 @@ export class SqliteCanonicalStore implements CanonicalStore {
       : this.db.prepare('SELECT body FROM link WHERE from_id=?').all(id) as { body: string }[];
     return rows.map((r) => jparse<Link>(r.body));
   }
+  async markingsOf(ids: EntityId[]): Promise<Record<EntityId, MarkingId[]>> {
+    const out: Record<EntityId, MarkingId[]> = {};
+    if (!ids.length) return out;
+    const rows = this.db.prepare("SELECT id, json_extract(body,'$.markings') AS m FROM entity WHERE id IN (SELECT value FROM json_each(?))")
+      .all(JSON.stringify(ids)) as { id: string; m: string | null }[];
+    // the key is (type,id): if one id exists under two types, the union is the safe answer
+    for (const r of rows) out[r.id] = [...new Set([...(out[r.id] ?? []), ...(JSON.parse(r.m ?? '[]') as MarkingId[])])];
+    return out;
+  }
   async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
     this.db.exec('BEGIN');
     try { const r = await fn({ id: 'sqlite-tx' }); this.db.exec('COMMIT'); return r; }
diff --git a/adapters/sqlite/object-index.ts b/adapters/sqlite/object-index.ts
index 046a1ec..c9ac57d 100644
--- a/adapters/sqlite/object-index.ts
+++ b/adapters/sqlite/object-index.ts
@@ -2,39 +2,51 @@
 import { DatabaseSync } from 'node:sqlite';
 import { openDb } from './_db.ts';
 import type { ObjectIndex, AdapterContext, AdapterCapabilities, IndexDoc, SearchQuery, SearchResult, AggQuery, AggResult } from '../../spine/ports.ts';
-import type { TypeName, EntityId, FieldName, Json, HealthStatus } from '../../spine/model.ts';
+import type { TypeName, EntityId, FieldName, Json, HealthStatus, MarkingId } from '../../spine/model.ts';
 import { jstr } from '../../spine/json.ts';
 import { registerAdapter } from '../../spine/contracts.ts';
 
-const DDL = `CREATE TABLE IF NOT EXISTS idx (type TEXT, id TEXT, text TEXT, fields TEXT, PRIMARY KEY(type,id));`;
+const DDL = `CREATE TABLE IF NOT EXISTS idx (type TEXT, id TEXT, text TEXT, fields TEXT, markings TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(type,id));`;
+// a row is selectable when it carries no marking outside the principal's clearances (bound as a JSON array)
+const VISIBLE = `NOT EXISTS (SELECT 1 FROM json_each(idx.markings) m WHERE m.value NOT IN (SELECT value FROM json_each(?)))`;
 
 export class SqliteObjectIndex implements ObjectIndex {
   private db!: DatabaseSync;
-  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 50 };
+  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 50, enforcesMarkings: true };
 
   async init(ctx: AdapterContext): Promise<void> {
     this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
     this.db.exec(DDL);
+    // an index file created before markings were stored: add the column in place
+    const cols = this.db.prepare('PRAGMA table_info(idx)').all() as { name: string }[];
+    if (!cols.some((c) => c.name === 'markings')) this.db.exec(`ALTER TABLE idx ADD COLUMN markings TEXT NOT NULL DEFAULT '[]'`);
   }
   async index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
     const text = (doc.text ?? '') + ' ' + Object.values(doc.fields).map(String).join(' ');
-    this.db.prepare('INSERT OR REPLACE INTO idx(type,id,text,fields) VALUES(?,?,?,?)').run(type, id, text.toLowerCase(), jstr(doc.fields));
+    this.db.prepare('INSERT OR REPLACE INTO idx(type,id,text,fields,markings) VALUES(?,?,?,?,?)')
+      .run(type, id, text.toLowerCase(), jstr(doc.fields), JSON.stringify(doc.markings ?? []));
   }
   async remove(type: TypeName, id: EntityId): Promise<void> {
     this.db.prepare('DELETE FROM idx WHERE type=? AND id=?').run(type, id);
   }
+  async setMarkings(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void> {
+    this.db.prepare('UPDATE idx SET markings=? WHERE type=? AND id=?').run(JSON.stringify(markings), type, id);
+  }
   async search(q: SearchQuery): Promise<SearchResult> {
     const where: string[] = [];
     const params: unknown[] = [];
     if (q.type) { where.push('type=?'); params.push(q.type); }
     if (q.text) { where.push('text LIKE ?'); params.push(`%${q.text.toLowerCase()}%`); }
+    if (q.principal) { where.push(VISIBLE); params.push(JSON.stringify(q.principal.clearances)); }
     const sql = `SELECT type,id FROM idx${where.length ? ' WHERE ' + where.join(' AND ') : ''} LIMIT ?`;
     params.push(q.limit ?? 25);
     const rows = this.db.prepare(sql).all(...(params as never[])) as { type: string; id: string }[];
     return { hits: rows.map((r) => ({ id: r.id, type: r.type, score: 1 })) };
   }
   async aggregate(q: AggQuery): Promise<AggResult> {
-    const rows = this.db.prepare('SELECT count(*) c FROM idx WHERE type=?').all(q.type) as { c: number }[];
+    const rows = (q.principal
+      ? this.db.prepare(`SELECT count(*) c FROM idx WHERE type=? AND ${VISIBLE}`).all(q.type, JSON.stringify(q.principal.clearances))
+      : this.db.prepare('SELECT count(*) c FROM idx WHERE type=?').all(q.type)) as { c: number }[];
     return { rows: [{ key: {} as Record<FieldName, Json>, metrics: { count: rows[0]?.c ?? 0 } }] };
   }
   async searchCandidates(type: TypeName, blockingKeys: Record<FieldName, Json>, limit: number): Promise<EntityId[]> {
diff --git a/spine/ports.ts b/spine/ports.ts
index ca35d6a..1e82fb4 100644
--- a/spine/ports.ts
+++ b/spine/ports.ts
@@ -51,6 +51,12 @@ export interface AdapterCapabilities {
   external?: boolean;
   /** Temporal-style engines that own job execution; flips compiler claim/complete expectations. */
   ownsExecution?: boolean;
+  /** The engine persists markings per row and, when a query carries `principal`, selects and
+   *  aggregates only rows whose every marking that principal holds — and resolves every name in
+   *  that query as a logical field of a canonical type, never as a storage column or another
+   *  table. Aggregates are allowed for principals only on engines that set this
+   *  (docs/specs/2026-10-06-governed-ports-design.md §4.4). */
+  enforcesMarkings?: boolean;
 }
 
 export interface ResolvedBinding {
@@ -90,6 +96,9 @@ export interface CanonicalStore extends Adapter {
   getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null>;
   listEntities(type: TypeName, q: EntityQuery): Promise<Page<CanonicalEntity>>;
   getLinks(type: TypeName, id: EntityId, linkType?: TypeName): Promise<Link[]>;
+  /** Stored markings by entity id — the authority every governed read is checked against.
+   *  Ids the store does not hold are omitted; an entity with no markings maps to []. */
+  markingsOf(ids: EntityId[]): Promise<Record<EntityId, MarkingId[]>>;
 
   transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
 }
@@ -170,6 +179,7 @@ export interface AggQuery {
   groupBy: FieldName[];
   metrics: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: FieldName }[];
   filter?: { field: FieldName; op: string; value: Json }[];
+  principal?: Principal;              // applies marking filter (engines with enforcesMarkings)
 }
 
 export interface AggResult {
@@ -179,6 +189,8 @@ export interface AggResult {
 export interface ObjectIndex extends Adapter {
   index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void>;
   remove(type: TypeName, id: EntityId): Promise<void>;
+  /** Replace the markings stored with an indexed row (no-op if the row is not indexed). */
+  setMarkings(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void>;
   search(q: SearchQuery): Promise<SearchResult>;
   aggregate(q: AggQuery): Promise<AggResult>;
   /** the resolver's BLOCKING step (R5/P5 → R4): candidate match ids to avoid O(n^2). */
@@ -266,6 +278,9 @@ export interface OlapQuery {
   having?: { measure: string; op: string; value: number }[];
   orderBy?: { key: string; dir: 'asc' | 'desc' }[];
   limit?: number;
+  /** When set, `from` MUST be read as a canonical type and every dimension, measure field and
+   *  `where` field as a logical field of it; rows are filtered by this principal's clearances. */
+  principal?: Principal;
 }
 
 export interface OlapResult { rows: Record<string, Json>[]; }
@@ -313,7 +328,9 @@ export interface AuditLog extends Adapter {
 export interface LineageEdge {
   upstream: string;     // source / dataset / observation / field ref
   downstream: string;   // derived dataset / object / field ref
-  kind: 'source-observation' | 'observation-entity' | 'transform' | 'field-derivation';
+  /** 'marking' is a record that `markings` were applied AT `upstream` (upstream === downstream);
+   *  it is never returned by upstreamOf/downstreamOf. */
+  kind: 'source-observation' | 'observation-entity' | 'transform' | 'field-derivation' | 'marking';
   markings?: MarkingId[];
 }
 
@@ -321,8 +338,12 @@ export interface Lineage extends Adapter {
   record(edge: LineageEdge): Promise<void>;
   upstreamOf(ref: string, maxHops?: number): Promise<LineageEdge[]>;
   downstreamOf(ref: string, maxHops?: number): Promise<LineageEdge[]>;
-  /** THE moat: union+stamp markings down the downstream closure of `ref`. */
+  /** THE moat: apply `markings` at `ref` (persisted) and return the downstream closure of `ref`. */
   propagateMarking(ref: string, markings: MarkingId[]): Promise<string[]>;
+  /** Persist that `markings` apply at `ref`, so refs derived from it later inherit them. */
+  applyMarking(ref: string, markings: MarkingId[]): Promise<void>;
+  /** Markings applied at `ref` or at any ref upstream of it. */
+  effectiveMarkings(ref: string): Promise<MarkingId[]>;
 }
 
 // ---------------------------------------------------------------------------
@@ -378,3 +399,27 @@ export interface PortByRole {
   'policy-identity': PolicyIdentity;
   'work-queue': WorkQueue;
 }
+
+// ---------------------------------------------------------------------------
+// What a principal gets: only the methods classified 'governed' or 'open' in
+// spine/governance.ts GOVERNANCE_RULES. Built by spine/governed.ts.
+// ---------------------------------------------------------------------------
+
+export interface GovernedPortByRole {
+  'canonical-store': Pick<CanonicalStore, 'getEntity' | 'listEntities' | 'getLinks'>;
+  'hot-cache': Pick<Cache, 'get' | 'set' | 'del' | 'incr' | 'publish' | 'subscribe'>;
+  'stream': Pick<Stream, 'subscribe'>;
+  'object-index': Pick<ObjectIndex, 'search' | 'aggregate'>;
+  'graph': Pick<GraphStore, 'neighbors' | 'shortestPath'>;
+  'blob-cas': Pick<BlobCas, 'get' | 'presignRead'>;
+  'vector': Pick<VectorStore, 'knn'>;
+  'timeseries-geo': Pick<TimeSeriesGeo, 'range' | 'downsample' | 'within'>;
+  'analytics-olap': Pick<AnalyticsOlap, 'query'>;
+  'registry': Pick<Registry, 'loadAll' | 'get' | 'versions'>;
+  'audit-log': Pick<AuditLog, 'scan' | 'export'>;
+  'lineage': Pick<Lineage, 'upstreamOf' | 'downstreamOf'>;
+  'policy-identity': Pick<PolicyIdentity, 'authenticate' | 'authorize' | 'members'>;
+  /** Not available to principals in this version: jobs carry no markings, so a claim could
+   *  hand a restricted payload to anyone, and anyone could complete another's job. */
+  'work-queue': Pick<WorkQueue, never>;
+}
````

- [ ] **Step 4: Run everything**

Run:
```bash
npm run -s conformance 2>&1 | grep -E "❌|object-index|lineage|conformant"
for s in boot:edge boot:enterprise governance automation; do npm run -s "$s" 2>&1 | grep -E "[0-9]+/[0-9]+ .*passed"; done; npm run -s typecheck; echo "tsc exit=$?"
```
Expected:
```
  ✅ object-index/sqlite — 5 checks
  ✅ lineage/fs — 5 checks
14/14 adapters conformant.
9/9 checks passed.
13/13 checks passed.
8/8 governance checks passed.
8/8 automation checks passed.
tsc exit=0
```

- [ ] **Step 5: Commit**

```bash
git add spine adapters && git commit -m "governed ports: adapter capabilities (markingsOf, in-engine marking filter, applied markings)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The gate

The read gate, the system handle with its invariant-keeping wrappers, and the adversarial suite that proves them. `BoundPlatform.role()` survives this task as a deprecated alias so the other callers keep working; Task 4 removes it.

**Files:**
- Create: `spine/governed.ts`, `spine/system.ts`, `spine/governance-conformance.ts`
- Rewrite: `spine/governance.ts`, `boot/governance.ts`
- Modify: `spine/contracts.ts`, `spine/compiler.ts`

**Interfaces:**
- Consumes: everything Task 1 produced
- Produces:
  - `spine/contracts.ts`: `interface GovernanceConfig { policy: MarkingPolicy; auditReads: 'marked' | 'all' | 'none'; nowNs: () => bigint }`; `BoundPlatform.as(principal: Principal): GovernedPlatform`; `BoundPlatform.system(component: string): SystemPlatform`; `BoundPlatform.policy: MarkingPolicy` (getter); `BoundPlatform.nowNs(): bigint`; constructor `new BoundPlatform(bound, gov?: Partial<GovernanceConfig>)`
  - `spine/governance.ts`: `class GovernanceError extends Error`; `class MarkingPolicy` with `visible`, `redactFields`, `fieldMarking(type, field): MarkingId | undefined`, `protectsField(type | undefined, field): boolean`, `canUseField(principal, type | undefined, field): boolean`, `publicFields(type, fields)`; `type Rule = 'governed' | 'open' | 'system'`; `GOVERNANCE_RULES`; `ruleFor(role, method)`; `union(...sets)`; `entityRef(type, id)`; `parseRef(ref)`; `indexDocFor(policy, entity): IndexDoc`; `propagate(platform, ref, markings, actor = 'system'): Promise<string[]>`. **`Session` is removed.**
  - `spine/governed.ts`: `class GovernedPlatform` with `principal`, `has(r)`, `role<R>(r): GovernedPortByRole[R]`
  - `spine/system.ts`: `class SystemPlatform` with `component`, `has(r)`, `role<R>(r): PortByRole[R]`, `applyMarking(ref, markings): Promise<string[]>` (entity refs whose markings grew)
  - `spine/compiler.ts`: `ClientManifest.governance.fls?: FlsMap` and `.audit?: { reads?: 'marked' | 'all' | 'none' }`; `compile(manifest, opts)` takes `opts.policy?: MarkingPolicy` (replacing `opts.marking`) and `opts.nowNs`
  - `spine/governance-conformance.ts`: `governanceSuite(platform: BoundPlatform): Promise<Check[]>`, `SUITE`, `LOW`, `HIGH`

- [ ] **Step 1: Write the failing suite**

Apply Patch 3. It creates the suite and replaces `boot/governance.ts` with a runner that binds every data role.

**Patch 3**

````diff
diff --git a/boot/governance.ts b/boot/governance.ts
index 6bd5db9..39e3b5b 100644
--- a/boot/governance.ts
+++ b/boot/governance.ts
@@ -1,121 +1,49 @@
-// boot/governance.ts — Phase 3 proof: propagating security.
-// Security defined ONCE at a source propagates along lineage to derived entities, and two
-// principals get different governed views of the SAME store (row-level filter + FLS redaction).
+// boot/governance.ts — Phase 3 proof: no ungoverned read or write path.
+// Compiles one client with every data role bound and runs the adversarial suite
+// (spine/governance-conformance.ts) against it.
 //   run:  node --experimental-sqlite boot/governance.ts   (npm run governance)
 import { rmSync } from 'node:fs';
-import { randomUUID } from 'node:crypto';
 import { compile, type ClientManifest } from '../spine/compiler.ts';
-import { MarkingPolicy, Session, propagate, entityRef } from '../spine/governance.ts';
+import { governanceSuite, SUITE } from '../spine/governance-conformance.ts';
 import '../adapters/index.ts';
-import type { CanonicalStore, Lineage, AuditLog, Principal } from '../spine/ports.ts';
-import type { CanonicalEntity } from '../spine/model.ts';
-
-const nowNs = () => BigInt(Date.now()) * 1_000_000n;
-const results: { name: string; ok: boolean; info: string }[] = [];
-async function check(name: string, fn: () => Promise<string>) {
-  try { results.push({ name, ok: true, info: await fn() }); } catch (e) { results.push({ name, ok: false, info: (e as Error).message }); }
-}
 
+const D = './.data/gov';
 const MANIFEST: ClientManifest = {
   schema_version: '1.0',
-  client: { id: 'gov-demo', name: 'Propagating-Security Demo', tier: 'standard' },
-  capabilities: ['kinetic-writes', 'identity-resolution', 'propagating-security', 'audit', 'search'],
+  client: { id: 'gov-demo', name: 'Governed-Ports Proof', tier: 'standard' },
+  capabilities: ['kinetic-writes', 'identity-resolution', 'propagating-security', 'audit', 'search', 'link-analysis', 'geotemporal', 'reporting-olap', 'automation-flow', 'omnichannel-routing'],
   roles: {
-    'canonical-store': { engine: 'sqlite', config: { path: './.data/gov/canonical.db' } },
-    'object-index': { engine: 'sqlite', config: { path: './.data/gov/index.db' } },
-    'registry': { engine: 'git-fs', config: { path: './.data/gov/registry' } },
-    'audit-log': { engine: 'append-wal', config: { path: './.data/gov/audit.log' } },
-    'stream': { engine: 'file', config: { path: './.data/gov/stream.wal' } },
-    'lineage': { engine: 'fs', config: { path: './.data/gov/lineage.jsonl' } },
+    'canonical-store': { engine: 'sqlite', config: { path: `${D}/canonical.db` } },
+    'object-index': { engine: 'sqlite', config: { path: `${D}/index.db` } },
+    'graph': { engine: 'sqlite', config: { path: `${D}/graph.db` } },
+    'vector': { engine: 'file', config: { path: `${D}/vectors.json` } },
+    'timeseries-geo': { engine: 'sqlite', config: { path: `${D}/tracks.db` } },
+    'analytics-olap': { engine: 'sqlite', config: { path: `${D}/canonical.db` } },   // reports over the live entity table
+    'hot-cache': { engine: 'in-process', config: {} },
+    'work-queue': { engine: 'sqlite', config: { path: `${D}/work.db` } },
+    'registry': { engine: 'git-fs', config: { path: `${D}/registry` } },
+    'audit-log': { engine: 'append-wal', config: { path: `${D}/audit.log` } },
+    'stream': { engine: 'file', config: { path: `${D}/stream.wal` } },
+    'lineage': { engine: 'fs', config: { path: `${D}/lineage.jsonl` } },
     'policy-identity': { engine: 'internal', config: { clearances: ['UNCLASS'] } },
   },
-  governance: { markings: [{ id: 'UNCLASS', default: true }, { id: 'OPS-RESTRICTED' }], propagate: 'lineage' },
+  governance: {
+    markings: [{ id: SUITE.PUBLIC, default: true }, { id: SUITE.RESTRICTED }],
+    propagate: 'lineage',
+    fls: { [SUITE.type]: { [SUITE.owner]: SUITE.RESTRICTED } },
+  },
 };
 
-// FLS: the 'owner' field of a Vessel requires OPS-RESTRICTED clearance to be seen.
-const POLICY = new MarkingPolicy({ 'planetar:Vessel': { 'planetar:owner': 'OPS-RESTRICTED' } });
-
-const LOW: Principal = { id: 'analyst-low', roles: ['operator'], clearances: ['UNCLASS'] };
-const HIGH: Principal = { id: 'analyst-high', roles: ['operator'], clearances: ['UNCLASS', 'OPS-RESTRICTED'] };
-
-function vessel(id: string, name: string, extra: Record<string, string> = {}): CanonicalEntity {
-  return { id, type: 'planetar:Vessel', ts: nowNs(), source: 'src:ais@1.0.0', schemaVersion: 0x010000,
-    fields: { 'planetar:name': name, ...extra }, provenance: {}, markings: ['UNCLASS'] };
-}
-
 async function main() {
-  rmSync('./.data/gov', { recursive: true, force: true });
-  console.log('\n=== Phase 3: propagating security ===');
+  rmSync(D, { recursive: true, force: true });
+  console.log('\n=== Phase 3: governed ports (adversarial suite) ===');
   const { platform } = await compile(MANIFEST);
-  const store: CanonicalStore = platform.role('canonical-store');
-  const lineage: Lineage = platform.role('lineage');
-  const audit: AuditLog = platform.role('audit-log');
-
-  const A = randomUUID(), B = randomUUID();
-  await store.upsertEntity(vessel(A, 'MV Alpha', { 'planetar:owner': 'Acme Shipping Ltd' }));   // UNCLASS, owner is FLS-restricted
-  await store.upsertEntity(vessel(B, 'MV Bravo'));                                               // UNCLASS for now
-
-  // B derives from a classified feed (lineage): src:classified-feed -> obs-B -> Vessel/B
-  await lineage.record({ upstream: 'src:classified-feed', downstream: 'obs-B', kind: 'source-observation' });
-  await lineage.record({ upstream: 'obs-B', downstream: entityRef('planetar:Vessel', B), kind: 'observation-entity' });
-
-  const low = new Session(platform, LOW, POLICY);
-  const high = new Session(platform, HIGH, POLICY);
-
-  await check('FLS: low principal sees Alpha but owner is redacted', async () => {
-    const e = await low.getEntity('planetar:Vessel', A);
-    if (!e) throw new Error('Alpha should be visible (UNCLASS)');
-    if (e.fields['planetar:owner'] !== undefined) throw new Error('owner must be redacted for low clearance');
-    return `name=${e.fields['planetar:name']}, owner=<redacted>`;
-  });
-  await check('FLS: high principal sees Alpha owner', async () => {
-    const e = await high.getEntity('planetar:Vessel', A);
-    if (e?.fields['planetar:owner'] !== 'Acme Shipping Ltd') throw new Error('owner should be visible');
-    return `owner=${e.fields['planetar:owner']}`;
-  });
-  await check('before propagation: low principal CAN see Bravo', async () => {
-    const e = await low.getEntity('planetar:Vessel', B);
-    if (!e) throw new Error('Bravo is UNCLASS, should be visible');
-    return 'visible';
-  });
-
-  // Define the restriction ONCE, at the source. It propagates along lineage to Bravo.
-  const stamped = await propagate(platform, 'src:classified-feed', ['OPS-RESTRICTED']);
-  await audit.append({ ts: nowNs(), actor: 'system', action: 'admin', resource: 'src:classified-feed', detail: { propagated: 'OPS-RESTRICTED', to: stamped }, markings: ['OPS-RESTRICTED'] });
-
-  await check('propagation: OPS-RESTRICTED flowed from source to Bravo', async () => {
-    if (!stamped.includes(entityRef('planetar:Vessel', B))) throw new Error('Bravo was not re-stamped');
-    const raw = await store.getEntity('planetar:Vessel', B);
-    if (!raw?.markings?.includes('OPS-RESTRICTED')) throw new Error('marking not persisted');
-    return `stamped ${stamped.length} entity(ies): ${stamped.join(', ')}`;
-  });
-  await check('after propagation: low principal can NO LONGER see Bravo (restricted view)', async () => {
-    const e = await low.getEntity('planetar:Vessel', B);
-    if (e !== null) throw new Error('Bravo must be filtered out for low clearance');
-    return 'filtered ✓';
-  });
-  await check('after propagation: high principal STILL sees Bravo', async () => {
-    const e = await high.getEntity('planetar:Vessel', B);
-    if (!e) throw new Error('high clearance should still see Bravo');
-    return 'visible ✓';
-  });
-  await check('list reflects governance: low sees fewer rows than high', async () => {
-    const lo = await low.listEntities('planetar:Vessel', {});
-    const hi = await high.listEntities('planetar:Vessel', {});
-    if (lo.length !== 1 || hi.length !== 2) throw new Error(`expected low=1 high=2, got low=${lo.length} high=${hi.length}`);
-    if (lo[0].fields['planetar:owner'] !== undefined) throw new Error('owner should be redacted in low list');
-    return `low sees ${lo.length} (owner redacted), high sees ${hi.length}`;
-  });
-  await check('audit captured the propagation as an immutable record', async () => {
-    let n = 0; for await (const _ of audit.scan({ actor: 'system' })) n++;
-    if (!n) throw new Error('no audit record'); return `${n} record(s)`;
-  });
-
+  const results = await governanceSuite(platform);
   console.log('\n=== Results ===');
   for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.info}`);
   const passed = results.filter((r) => r.ok).length;
   console.log(`\n${passed}/${results.length} governance checks passed.`);
   await platform.closeAll();
-  if (passed !== results.length) process.exit(1);
+  process.exit(passed === results.length ? 0 : 1);
 }
-main().catch((e) => { console.error('GOVERNANCE DEMO FAILED:', e); process.exit(1); });
+main().catch((e) => { console.error('GOVERNANCE SUITE FAILED:', e); process.exit(1); });
diff --git a/spine/governance-conformance.ts b/spine/governance-conformance.ts
new file mode 100644
index 0000000..436649c
--- /dev/null
+++ b/spine/governance-conformance.ts
@@ -0,0 +1,360 @@
+// spine/governance-conformance.ts — the adversarial governance suite.
+// Plants public, restricted and derived data through the system handle, then attacks every
+// governed port as a low-clearance principal. A client passes when LOW can never observe the
+// restricted rows — not their ids, counts, neighbours, paths, tracks, envelopes or audit trail —
+// while HIGH observes all of it. Engine-agnostic: it runs against whatever the manifest bound.
+// Design: docs/specs/2026-10-06-governed-ports-design.md §6.
+import type { BoundPlatform } from './contracts.ts';
+import type { Principal, AuditRecord, Envelope } from './ports.ts';
+import type { CanonicalEntity, MarkingId } from './model.ts';
+import { GovernanceError, entityRef, indexDocFor, propagate } from './governance.ts';
+
+export interface Check { name: string; ok: boolean; info: string }
+
+/** The fixture vocabulary. The client manifest must protect SUITE.owner with SUITE.RESTRICTED
+ *  (governance.fls) or the first check fails. */
+export const SUITE = {
+  type: 'gov:Vessel', name: 'gov:name', owner: 'gov:owner',
+  PUBLIC: 'UNCLASS', RESTRICTED: 'OPS-RESTRICTED',
+  source: 'src:gov-classified', topic: 'gov.test',
+} as const;
+
+export const LOW: Principal = { id: 'gov-low', roles: ['operator'], clearances: [SUITE.PUBLIC] };
+export const HIGH: Principal = { id: 'gov-high', roles: ['operator'], clearances: [SUITE.PUBLIC, SUITE.RESTRICTED] };
+
+// ids sort as P1 < R < P2 so a withheld row sits between two visible ones (exercises page refill)
+const P1 = 'gov-1-pub', R = 'gov-2-sec', P2 = 'gov-3-pub', D = 'gov-4-derived', L = 'gov-5-late', E = 'gov-6-early';
+
+const nowNs = () => BigInt(Date.now()) * 1_000_000n;
+const sorted = (xs: string[]) => xs.slice().sort().join(',');
+
+function vessel(id: string, name: string, markings: MarkingId[], extra: Record<string, string> = {}): CanonicalEntity {
+  return { id, type: SUITE.type, ts: nowNs(), source: 'src:gov@1.0.0', schemaVersion: 0x010000, fields: { [SUITE.name]: name, ...extra }, provenance: {}, markings };
+}
+
+async function refused(fn: () => Promise<unknown>): Promise<boolean> {
+  try { await fn(); return false; } catch (e) { if (e instanceof GovernanceError) return true; throw e; }
+}
+
+async function first<T>(it: AsyncIterator<T>, ms = 500): Promise<T | undefined> {
+  const r = await Promise.race([it.next(), new Promise<IteratorResult<T>>((res) => setTimeout(() => res({ value: undefined, done: true }), ms))]);
+  return r.done ? undefined : r.value;
+}
+
+export async function governanceSuite(platform: BoundPlatform): Promise<Check[]> {
+  const checks: Check[] = [];
+  const t = async (name: string, fn: () => Promise<string>) => {
+    try { checks.push({ name, ok: true, info: await fn() }); } catch (e) { checks.push({ name, ok: false, info: (e as Error).message }); }
+  };
+  const sys = platform.system('governance-suite');
+  const low = platform.as(LOW), high = platform.as(HIGH);
+  const policy = platform.policy;
+  const store = sys.role('canonical-store');
+  const seed = async (e: CanonicalEntity) => {
+    await store.upsertEntity(e);
+    if (sys.has('object-index')) await sys.role('object-index').index(e.type, e.id, indexDocFor(policy, e));
+    if (sys.has('graph')) await sys.role('graph').upsertNode({ id: e.id, type: e.type, markings: e.markings });
+  };
+
+  await t('fixture: the manifest protects gov:owner with OPS-RESTRICTED', async () => {
+    if (policy.fieldMarking(SUITE.type, SUITE.owner) !== SUITE.RESTRICTED) throw new Error(`add governance.fls { "${SUITE.type}": { "${SUITE.owner}": "${SUITE.RESTRICTED}" } } to the manifest`);
+    return 'ok';
+  });
+
+  await seed(vessel(P1, 'MV Public', [SUITE.PUBLIC], { [SUITE.owner]: 'Acme Shipping' }));
+  await seed(vessel(R, 'MV Secretname', [SUITE.PUBLIC, SUITE.RESTRICTED]));
+  await seed(vessel(P2, 'MV Quay', [SUITE.PUBLIC]));
+
+  // ---------------------------------------------------------------- canonical-store
+  const lowStore = low.role('canonical-store'), highStore = high.role('canonical-store');
+  await t('canonical-store: a restricted row is hidden from LOW and visible to HIGH', async () => {
+    if (await lowStore.getEntity(SUITE.type, R) !== null) throw new Error('LOW read the restricted row');
+    if (!await highStore.getEntity(SUITE.type, R)) throw new Error('HIGH could not read it');
+    if (!await lowStore.getEntity(SUITE.type, P1)) throw new Error('LOW could not read a public row');
+    return 'ok';
+  });
+  await t('canonical-store: a protected field is redacted for LOW and present for HIGH', async () => {
+    const lo = await lowStore.getEntity(SUITE.type, P1), hi = await highStore.getEntity(SUITE.type, P1);
+    if (lo?.fields[SUITE.owner] !== undefined) throw new Error('owner reached LOW');
+    if (hi?.fields[SUITE.owner] !== 'Acme Shipping') throw new Error('owner missing for HIGH');
+    return `LOW sees name=${lo?.fields[SUITE.name]}, owner redacted`;
+  });
+  await t('canonical-store: lists hide restricted rows and refill pages around them', async () => {
+    const pages: string[][] = []; let cursor: string | undefined;
+    do {
+      const page = await lowStore.listEntities(SUITE.type, { limit: 1, cursor });
+      if (page.cursor && page.items.length !== 1) throw new Error(`short page (${page.items.length}) with more to come reveals a withheld row`);
+      if (page.total !== undefined) throw new Error('total must not be reported');
+      pages.push(page.items.map((e) => e.id)); cursor = page.cursor;
+    } while (cursor);
+    const ids = pages.flat();
+    if (sorted(ids) !== sorted([P1, P2])) throw new Error(`LOW listed ${ids.join(',')}`);
+    const hi = (await highStore.listEntities(SUITE.type, {})).items.map((e) => e.id);
+    if (sorted(hi) !== sorted([P1, R, P2])) throw new Error(`HIGH listed ${hi.join(',')}`);
+    return `LOW pages: ${pages.map((p) => `[${p.join(',')}]`).join(' ')}`;
+  });
+  await t('canonical-store: a link to a hidden entity is dropped', async () => {
+    const link = (id: string, to: string) => ({ id, type: 'gov:Link', ts: nowNs(), source: 'src:gov@1.0.0', schemaVersion: 0x010000, linkType: 'gov:met', from: P1, to });
+    await store.putLink(link('gov-link-1', R)); await store.putLink(link('gov-link-2', P2));
+    const lo = (await lowStore.getLinks(SUITE.type, P1)).map((l) => l.to), hi = (await highStore.getLinks(SUITE.type, P1)).map((l) => l.to);
+    if (sorted(lo) !== P2 || sorted(hi) !== sorted([R, P2])) throw new Error(`LOW=${lo.join(',')} HIGH=${hi.join(',')}`);
+    return 'ok';
+  });
+  await t('canonical-store: filtering or sorting on a protected field is refused for LOW only', async () => {
+    const q = { filter: [{ field: SUITE.owner, op: 'eq' as const, value: 'Acme Shipping' }] };
+    if (!await refused(() => lowStore.listEntities(SUITE.type, q))) throw new Error('LOW filtered on a field it cannot see');
+    if (!await refused(() => lowStore.listEntities(SUITE.type, { orderBy: [{ field: SUITE.owner, dir: 'asc' }] }))) throw new Error('LOW sorted on a field it cannot see');
+    await highStore.listEntities(SUITE.type, q);
+    return 'ok';
+  });
+
+  // ---------------------------------------------------------------- object-index
+  if (platform.has('object-index')) {
+    const lowIx = low.role('object-index'), highIx = high.role('object-index');
+    await t('object-index: search never returns a restricted id to LOW', async () => {
+      const lo = (await lowIx.search({ type: SUITE.type, text: 'secretname' })).hits.map((h) => h.id);
+      const hi = (await highIx.search({ type: SUITE.type, text: 'secretname' })).hits.map((h) => h.id);
+      if (lo.length || sorted(hi) !== R) throw new Error(`LOW=${lo.join(',')} HIGH=${hi.join(',')}`);
+      return 'ok';
+    });
+    await t('object-index: counts exclude restricted rows for LOW', async () => {
+      const count = async (p: typeof lowIx) => (await p.aggregate({ type: SUITE.type, groupBy: [], metrics: [{ fn: 'count' }] })).rows[0].metrics.count;
+      if (await count(lowIx) !== 2 || await count(highIx) !== 3) throw new Error(`LOW=${await count(lowIx)} HIGH=${await count(highIx)}`);
+      return 'LOW 2, HIGH 3';
+    });
+    await t('object-index: a protected value is not findable, and filtering on it is refused', async () => {
+      for (const ix of [lowIx, highIx]) {
+        if ((await ix.search({ type: SUITE.type, text: 'acme' })).hits.length) throw new Error('found an entity by its protected owner');
+        if (!await refused(() => ix.search({ type: SUITE.type, filter: [{ field: SUITE.owner, op: 'eq', value: 'Acme Shipping' }] }))) throw new Error('filter on a protected field was accepted');
+      }
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- graph
+  if (platform.has('graph')) {
+    const g = sys.role('graph');
+    await g.upsertEdge({ from: P1, to: R, linkType: 'gov:met' });
+    await g.upsertEdge({ from: R, to: P2, linkType: 'gov:met' });
+    await t('graph: LOW cannot step onto or through a restricted node', async () => {
+      const lo = await low.role('graph').neighbors(P1, { maxHops: 2, direction: 'out' });
+      const hi = await high.role('graph').neighbors(P1, { maxHops: 2, direction: 'out' });
+      if (sorted(lo.nodes.map((n) => n.id)) !== P1 || lo.edges.length) throw new Error(`LOW nodes=${lo.nodes.map((n) => n.id).join(',')} edges=${lo.edges.length}`);
+      if (sorted(hi.nodes.map((n) => n.id)) !== sorted([P1, R, P2])) throw new Error(`HIGH nodes=${hi.nodes.map((n) => n.id).join(',')}`);
+      return 'ok';
+    });
+    await t('graph: a path that exists only through a restricted node does not exist for LOW', async () => {
+      const lo = await low.role('graph').shortestPath(P1, P2, { maxHops: 5 });
+      const hi = await high.role('graph').shortestPath(P1, P2, { maxHops: 5 });
+      if (lo !== null || hi?.length !== 2) throw new Error(`LOW=${lo?.length ?? null} HIGH=${hi?.length ?? null}`);
+      return 'LOW no path, HIGH length 2';
+    });
+    await t('graph: a traversal filter on a protected field is refused', async () => {
+      const filter = [{ field: SUITE.owner, op: 'eq', value: 'Acme Shipping' }];
+      for (const p of [low, high]) {
+        if (!await refused(() => p.role('graph').neighbors(P1, { maxHops: 1, filter }))) throw new Error('neighbors accepted the filter');
+        if (!await refused(() => p.role('graph').shortestPath(P1, P2, { maxHops: 3, filter }))) throw new Error('shortestPath accepted the filter');
+      }
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- vector
+  if (platform.has('vector')) {
+    const v = sys.role('vector');
+    await v.upsert(R, new Float32Array([1, 0, 0]), {});
+    await v.upsert(P1, new Float32Array([0.9, 0.1, 0]), {});
+    await v.upsert('gov-not-an-entity', new Float32Array([0.95, 0.05, 0]), {});
+    await t('vector: nearest-neighbour results skip restricted and unknown ids', async () => {
+      const q = new Float32Array([1, 0, 0]);
+      const lo = (await low.role('vector').knn(q, 1)).map((r) => r.id), hi = (await high.role('vector').knn(q, 1)).map((r) => r.id);
+      if (sorted(lo) !== P1 || sorted(hi) !== R) throw new Error(`LOW=${lo.join(',')} HIGH=${hi.join(',')}`);
+      return 'ok';
+    });
+    await t('vector: an engine filter that names a protected field is refused, whatever its shape', async () => {
+      const q = new Float32Array([1, 0, 0]);
+      for (const p of [low, high]) {
+        if (!await refused(() => p.role('vector').knn(q, 1, { [SUITE.owner]: 'Acme Shipping' }))) throw new Error('accepted the field as a key');
+        if (!await refused(() => p.role('vector').knn(q, 1, { must: [{ key: SUITE.owner, match: 'Acme Shipping' }] }))) throw new Error('accepted the field as a nested value');
+      }
+      await low.role('vector').knn(q, 1, { kind: 'vessel-photo' });       // an ordinary filter still works
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- timeseries-geo
+  if (platform.has('timeseries-geo')) {
+    const ts = sys.role('timeseries-geo'); const now = nowNs();
+    const w = { fromNs: now - 1_000_000_000n, toNs: now + 1_000_000_000n }, here = { lat: 48.4, lon: -123.4, radiusKm: 10 };
+    await ts.append({ entityId: R, ts: now, lat: 48.4, lon: -123.4 });
+    await ts.append({ entityId: P1, ts: now, lat: 48.41, lon: -123.41 });
+    await t('timeseries-geo: tracks of a restricted entity are withheld from LOW', async () => {
+      const lts = low.role('timeseries-geo'), hts = high.role('timeseries-geo');
+      if ((await lts.range(R, w)).length || (await lts.downsample(R, w, 60)).length) throw new Error('LOW read the restricted track');
+      if (sorted((await lts.within(here, w)).map((p) => p.entityId)) !== P1) throw new Error('LOW area query leaked');
+      if ((await hts.range(R, w)).length !== 1 || (await hts.within(here, w)).length !== 2) throw new Error('HIGH is missing points');
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- analytics-olap
+  if (platform.has('analytics-olap')) {
+    // for a principal, `from` is a canonical type and every name is a logical field of it
+    const rowsOf = async (p: typeof low, from: string, dimensions: string[]) => (await p.role('analytics-olap').query({ from, dimensions, measures: [{ fn: 'count', as: 'n' }] })).rows;
+    await t('analytics-olap: aggregates exclude restricted rows for LOW', async () => {
+      const lo = Number((await rowsOf(low, SUITE.type, []))[0].n), hi = Number((await rowsOf(high, SUITE.type, []))[0].n);
+      if (lo !== 2 || hi !== 3) throw new Error(`LOW=${lo} HIGH=${hi}`);
+      return `LOW ${lo}, HIGH ${hi}`;
+    });
+    await t('analytics-olap: a principal groups by fields it may read; a protected field is refused for LOW only', async () => {
+      const names = (await rowsOf(low, SUITE.type, [SUITE.name])).map((r) => String(r[SUITE.name]));
+      if (sorted(names) !== sorted(['MV Public', 'MV Quay'])) throw new Error(`LOW grouped names: ${names.join(',')}`);
+      if (!await refused(() => rowsOf(low, SUITE.type, [SUITE.owner]))) throw new Error('LOW grouped by a field it cannot read');
+      const owners = (await rowsOf(high, SUITE.type, [SUITE.owner])).map((r) => r[SUITE.owner]);
+      if (!owners.includes('Acme Shipping')) throw new Error(`HIGH could not group by owner: ${JSON.stringify(owners)}`);
+      return 'ok';
+    });
+    await t('analytics-olap: a principal cannot reach a storage column or another table', async () => {
+      const leaked = (rows: unknown) => /Acme Shipping|Secretname|gov-2-sec/.test(JSON.stringify(rows));
+      if (leaked(await rowsOf(low, SUITE.type, ['body']))) throw new Error('grouping by the raw body column exposed a protected or restricted value');
+      for (const table of ['entity', 'link', 'observation']) {
+        const rows = await rowsOf(low, table, []);
+        if (Number(rows[0]?.n ?? 0) !== 0 || leaked(rows)) throw new Error(`LOW read ${JSON.stringify(rows)} from table '${table}'`);
+      }
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- stream
+  if (platform.has('stream')) {
+    await t('stream: a restricted envelope is not delivered to LOW', async () => {
+      const lo = low.role('stream').subscribe([`${SUITE.topic}.**`], 'latest')[Symbol.asyncIterator]();
+      const hi = high.role('stream').subscribe([`${SUITE.topic}.**`], 'latest')[Symbol.asyncIterator]();
+      const env = (n: number, markings: MarkingId[]): Envelope => ({ id: `00000000-0000-7000-8000-00000000000${n}`, topic: `${SUITE.topic}.x`, source: 'src:gov@1.0.0', schema: 'gov:T', createdNs: nowNs(), markings, payload: new Uint8Array([n]) });
+      await sys.role('stream').publish(env(1, [SUITE.RESTRICTED]));
+      await sys.role('stream').publish(env(2, [SUITE.PUBLIC]));
+      const l1 = await first(lo), h1 = await first(hi);
+      if (l1?.payload[0] !== 2 || h1?.payload[0] !== 1) throw new Error(`LOW first=${l1?.payload[0]} HIGH first=${h1?.payload[0]}`);
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- audit-log
+  const auditOf = async (p: typeof low, actor: string) => { const out: AuditRecord[] = []; for await (const r of p.role('audit-log').scan({ actor })) out.push(r); return out; };
+  if (platform.has('audit-log')) {
+    await t('audit-log: a restricted record is withheld from LOW', async () => {
+      await sys.role('audit-log').append({ ts: nowNs(), actor: 'gov-suite', action: 'admin', resource: 'gov-a', markings: [SUITE.RESTRICTED] });
+      await sys.role('audit-log').append({ ts: nowNs(), actor: 'gov-suite', action: 'admin', resource: 'gov-b', markings: [SUITE.PUBLIC] });
+      const lo = (await auditOf(low, 'gov-suite')).length, hi = (await auditOf(high, 'gov-suite')).length;
+      if (lo !== 1 || hi !== 2) throw new Error(`LOW=${lo} HIGH=${hi}`);
+      let exported = 0; for await (const _ of low.role('audit-log').export({ fromNs: 0n, toNs: nowNs() }, 'json')) exported++;
+      for await (const line of low.role('audit-log').export({ fromNs: 0n, toNs: nowNs() }, 'json')) if (line.includes('gov-a')) throw new Error('export leaked the restricted record');
+      return `LOW scans 1 of 2; export ${exported} line(s)`;
+    });
+    await t('audit: a marked read is recorded, and a read that withheld rows is hidden from that reader', async () => {
+      await highStore.getEntity(SUITE.type, R);
+      await lowStore.getEntity(SUITE.type, R);
+      const all: AuditRecord[] = []; for await (const r of sys.role('audit-log').scan({})) all.push(r);
+      const reads = (who: Principal) => all.filter((r) => r.actor === who.id && r.action === 'read' && r.resource === 'canonical-store.getEntity');
+      if (!reads(HIGH).length) throw new Error('the HIGH read of a marked row was not audited');
+      const withheld = reads(LOW).filter((r) => (r.detail as { withheld?: number } | undefined)?.withheld);
+      if (!withheld.length) throw new Error('the withheld LOW read was not audited');
+      if ((await auditOf(low, LOW.id)).some((r) => (r.detail as { withheld?: number } | undefined)?.withheld)) throw new Error('LOW can see that rows were withheld from it');
+      return `${reads(HIGH).length} HIGH read(s), ${withheld.length} withheld LOW read(s) hidden from LOW`;
+    });
+  }
+
+  // ---------------------------------------------------------------- work-queue
+  if (platform.has('work-queue')) {
+    await t('work-queue: a principal cannot claim, complete or fail jobs (they carry no markings)', async () => {
+      const id = await sys.role('work-queue').enqueue({ kind: 'gov-approval', payload: { targetId: R, note: 'restricted matter' } });
+      for (const p of [low, high]) {
+        const port = p.role('work-queue') as unknown as Record<string, unknown>;
+        for (const m of ['claim', 'complete', 'fail', 'enqueue']) if (port[m] !== undefined) throw new Error(`work-queue.${m} is exposed to principals`);
+      }
+      if (!(await sys.role('work-queue').claim('gov-suite', 10)).some((j) => j.id === id)) throw new Error('the system handle could not claim the job');
+      await sys.role('work-queue').complete(id);
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- hot-cache
+  if (platform.has('hot-cache')) {
+    await t('hot-cache: principals with different clearances never share an entry', async () => {
+      await low.role('hot-cache').set('gov-k', 'low');
+      if (await high.role('hot-cache').get('gov-k') !== null) throw new Error('HIGH read LOW\'s entry');
+      await high.role('hot-cache').set('gov-k', 'high');
+      if (await low.role('hot-cache').get('gov-k') !== 'low') throw new Error('LOW read HIGH\'s entry');
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- inheritance (needs lineage)
+  if (platform.has('lineage')) {
+    const lineage = sys.role('lineage');
+    const lowSees = async (id: string) => (await lowStore.getEntity(SUITE.type, id)) !== null;
+    const lowFinds = async (text: string) => platform.has('object-index') ? (await low.role('object-index').search({ type: SUITE.type, text })).hits.length : 0;
+    await seed(vessel(D, 'MV Derived', [SUITE.PUBLIC]));
+    await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-1', kind: 'source-observation' });
+    await lineage.record({ upstream: 'gov-obs-1', downstream: entityRef(SUITE.type, D), kind: 'observation-entity' });
+
+    await t('inheritance: marking a source restricts what was already derived from it, in every projection', async () => {
+      if (!await lowSees(D) || await lowFinds('derived') !== 1) throw new Error('precondition: D should be public before the source is marked');
+      const stamped = await propagate(platform, SUITE.source, [SUITE.RESTRICTED], 'gov-admin');
+      if (!stamped.includes(entityRef(SUITE.type, D))) throw new Error(`propagate stamped ${stamped.join(',') || 'nothing'}`);
+      if (await lowSees(D)) throw new Error('LOW still reads D');
+      if (await lowFinds('derived')) throw new Error('LOW still finds D by search');
+      if (!await highStore.getEntity(SUITE.type, D)) throw new Error('HIGH lost D');
+      if (platform.has('object-index')) {
+        const c = (await low.role('object-index').aggregate({ type: SUITE.type, groupBy: [], metrics: [{ fn: 'count' }] })).rows[0].metrics.count;
+        if (c !== 2) throw new Error(`LOW count is ${c}, expected 2`);
+      }
+      return `stamped ${stamped.length}`;
+    });
+    await t('inheritance: an entity linked to the marked source afterwards inherits (entity first, then edge)', async () => {
+      await seed(vessel(L, 'MV Late', [SUITE.PUBLIC]));
+      await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-2', kind: 'source-observation' });
+      await lineage.record({ upstream: 'gov-obs-2', downstream: entityRef(SUITE.type, L), kind: 'observation-entity' });
+      if (await lowSees(L) || await lowFinds('late')) throw new Error('LOW reaches the late derivation');
+      return 'ok';
+    });
+    await t('inheritance: an entity written after its edge inherits (edge first, then entity)', async () => {
+      await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-3', kind: 'source-observation' });
+      await lineage.record({ upstream: 'gov-obs-3', downstream: entityRef(SUITE.type, E), kind: 'observation-entity' });
+      await seed(vessel(E, 'MV Early', [SUITE.PUBLIC]));
+      if (await lowSees(E) || await lowFinds('early')) throw new Error('LOW reaches the early-edge derivation');
+      return 'ok';
+    });
+    await t('invariant: markings never shrink, in the store or in a projection', async () => {
+      await seed(vessel(D, 'MV Derived', [SUITE.PUBLIC]));        // a writer "forgets" the restriction
+      if (await lowSees(D) || await lowFinds('derived')) throw new Error('re-writing D with fewer markings exposed it');
+      return 'ok';
+    });
+    await t('lineage: LOW cannot see the edges of a restricted chain', async () => {
+      const lo = await low.role('lineage').downstreamOf(SUITE.source), hi = await high.role('lineage').downstreamOf(SUITE.source);
+      if (lo.length || !hi.length) throw new Error(`LOW=${lo.length} HIGH=${hi.length}`);
+      return `HIGH sees ${hi.length} edge(s)`;
+    });
+    if (platform.has('audit-log')) await t('propagation is audited once, by the actor who ordered it', async () => {
+      const recs = (await auditOf(high, 'gov-admin')).filter((r) => r.resource === SUITE.source && r.action === 'admin');
+      if (recs.length !== 1) throw new Error(`${recs.length} record(s)`);
+      if ((await auditOf(low, 'gov-admin')).length) throw new Error('LOW can see the propagation record');
+      return 'ok';
+    });
+  }
+
+  // ---------------------------------------------------------------- structure
+  await t('structure: a governed port carries no system method', async () => {
+    const { GOVERNANCE_RULES } = await import('./governance.ts');
+    let n = 0;
+    for (const [role, rules] of Object.entries(GOVERNANCE_RULES) as [keyof typeof GOVERNANCE_RULES, Record<string, string>][]) {
+      if (!platform.has(role)) continue;
+      const port = low.role(role) as Record<string, unknown>;
+      for (const m of Object.keys(port)) if (port[m] !== undefined && rules[m] !== 'governed' && rules[m] !== 'open') throw new Error(`${role}.${m} is exposed but classified '${rules[m]}'`);
+      n++;
+    }
+    return `${n} role(s)`;
+  });
+
+  return checks;
+}
````

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run -s governance 2>&1 | grep -E "SyntaxError|passed"`
Expected: `SyntaxError: The requested module './governance.ts' does not provide an export named 'GovernanceError'` — the gate does not exist yet.

- [ ] **Step 3: Implement the gate**

Apply Patch 4. It also adds one suite check found while writing the wrappers (a lineage chain recorded bottom-up).

**Patch 4**

````diff
diff --git a/spine/compiler.ts b/spine/compiler.ts
index 36911e4..bd80884 100644
--- a/spine/compiler.ts
+++ b/spine/compiler.ts
@@ -8,6 +8,7 @@ import type { RoleId, EngineName, Adapter, AdapterContext, Logger, MarkingResolv
 import type { TypeName, FieldName, Json } from './model.ts';
 import { requiredRoles, type CapabilityKey } from './capabilities.ts';
 import { bindRole, BoundPlatform, ManifestError, DEFAULTABLE_ROLES, type SharedResources, type RoleBinding } from './contracts.ts';
+import { MarkingPolicy, type FlsMap } from './governance.ts';
 
 export interface ClientManifest {
   schema_version: string;
@@ -16,7 +17,13 @@ export interface ClientManifest {
   roles: Partial<Record<RoleId, { engine: EngineName; config?: Record<string, Json> }>>;
   ingest?: { kind: string; name: string; [k: string]: Json | undefined }[];
   surfaces?: { kind: string; name?: string; [k: string]: Json | undefined }[];
-  governance?: { markings?: { id: string; default?: boolean }[]; propagate?: string; audit?: Json };
+  governance?: {
+    markings?: { id: string; default?: boolean }[];
+    propagate?: string;
+    /** field-level security: type → field → marking needed to see it */
+    fls?: FlsMap;
+    audit?: { reads?: 'marked' | 'all' | 'none' };
+  };
   deploy?: { target: string; [k: string]: Json };
 }
 
@@ -38,7 +45,8 @@ export function consoleLogger(prefix = 'planetar'): Logger {
   };
 }
 
-/** Edge default: allow-all visibility, no FLS redaction. Real governance comes in Phase 3 (R13). */
+/** Allow-all resolver for the per-adapter conformance harness only. A compiled platform never
+ *  uses it: compile() builds a MarkingPolicy from the manifest's governance block. */
 export const PERMISSIVE_MARKING: MarkingResolver = {
   visible: (_p: Principal, _m: MarkingId[]) => true,
   redactFields: (_p: Principal, _t: TypeName, f: Record<FieldName, Json>) => f,
@@ -53,10 +61,11 @@ export function makeShared(): SharedResources {
 
 export async function compile(
   manifest: ClientManifest,
-  opts: { logger?: Logger; marking?: MarkingResolver; shared?: SharedResources } = {},
+  opts: { logger?: Logger; policy?: MarkingPolicy; shared?: SharedResources; nowNs?: () => bigint } = {},
 ): Promise<CompileResult> {
   const logger = opts.logger ?? consoleLogger(manifest.client.id);
-  const marking = opts.marking ?? PERMISSIVE_MARKING;
+  const policy = opts.policy ?? new MarkingPolicy(manifest.governance?.fls ?? {});
+  const marking: MarkingResolver = policy;
   const shared = opts.shared ?? makeShared();
   const warnings: string[] = [];
 
@@ -95,7 +104,7 @@ export async function compile(
   }
 
   return {
-    platform: new BoundPlatform(bound),
+    platform: new BoundPlatform(bound, { policy, auditReads: manifest.governance?.audit?.reads, nowNs: opts.nowNs }),
     required: [...required],
     bound: bindings.map((b) => b.role),
     warnings,
diff --git a/spine/contracts.ts b/spine/contracts.ts
index 776c221..d17f252 100644
--- a/spine/contracts.ts
+++ b/spine/contracts.ts
@@ -3,7 +3,10 @@
 // binder skeleton. Phase 0/1 of 90-ROADMAP.md. An engine may bind a role only if
 // its declared AdapterCapabilities SATISFY the role contract here.
 
-import type { RoleId, AdapterCapabilities, Adapter, PortByRole, AdapterContext, EngineName, ResolvedBinding, Logger, MarkingResolver } from './ports.ts';
+import type { RoleId, AdapterCapabilities, Adapter, PortByRole, AdapterContext, EngineName, ResolvedBinding, Logger, MarkingResolver, Principal } from './ports.ts';
+import { MarkingPolicy } from './governance.ts';
+import { GovernedPlatform } from './governed.ts';
+import { SystemPlatform } from './system.ts';
 
 // ---------------------------------------------------------------------------
 // What each role requires. The compiler rejects an engine that can't meet it.
@@ -110,17 +113,37 @@ export async function bindRole(
   return adapter;
 }
 
-/** What the spine receives: ports by role, engine-agnostic. */
+/** How the platform governs access (compiled from the manifest's `governance` block). */
+export interface GovernanceConfig {
+  policy: MarkingPolicy;
+  /** which governed reads are audited: only those touching marked rows, all, or none */
+  auditReads: 'marked' | 'all' | 'none';
+  nowNs: () => bigint;
+}
+
+/** What the spine receives. The adapters are private: a caller takes either the governed view
+ *  of a principal, or the system handle (docs/specs/2026-10-06-governed-ports-design.md §4.2). */
 export class BoundPlatform {
-  private readonly bound: Partial<Record<RoleId, Adapter>>;
-  constructor(bound: Partial<Record<RoleId, Adapter>>) { this.bound = bound; }
-  role<R extends RoleId>(r: R): PortByRole[R] {
-    const a = this.bound[r];
-    if (!a) throw new ManifestError(`role ${r} is not bound in this client`);
-    return a as PortByRole[R];
+  #bound: Partial<Record<RoleId, Adapter>>;
+  #gov: GovernanceConfig;
+  constructor(bound: Partial<Record<RoleId, Adapter>>, gov: Partial<GovernanceConfig> = {}) {
+    this.#bound = bound;
+    this.#gov = {
+      policy: gov.policy ?? new MarkingPolicy(),
+      auditReads: gov.auditReads ?? 'marked',
+      nowNs: gov.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n),
+    };
   }
-  has(r: RoleId): boolean { return !!this.bound[r]; }
-  async closeAll(): Promise<void> { await Promise.all(Object.values(this.bound).map((a) => a!.close())); }
+  /** Governed ports for one principal: reads are filtered and redacted; there are no data writes. */
+  as(principal: Principal): GovernedPlatform { return new GovernedPlatform(this.#bound, principal, this.#gov); }
+  /** Raw ports for spine internals, ingest and seeding. `component` names the caller. */
+  system(component: string): SystemPlatform { return new SystemPlatform(this.#bound, component); }
+  /** @deprecated use as(principal) or system(component); removed once every caller has moved. */
+  role<R extends RoleId>(r: R): PortByRole[R] { return this.system('legacy').role(r); }
+  get policy(): MarkingPolicy { return this.#gov.policy; }
+  nowNs(): bigint { return this.#gov.nowNs(); }
+  has(r: RoleId): boolean { return !!this.#bound[r]; }
+  async closeAll(): Promise<void> { await Promise.all(Object.values(this.#bound).map((a) => a!.close())); }
 }
 
 export type { Logger, MarkingResolver };
diff --git a/spine/governance-conformance.ts b/spine/governance-conformance.ts
index 436649c..4ced2a9 100644
--- a/spine/governance-conformance.ts
+++ b/spine/governance-conformance.ts
@@ -23,7 +23,7 @@ export const LOW: Principal = { id: 'gov-low', roles: ['operator'], clearances:
 export const HIGH: Principal = { id: 'gov-high', roles: ['operator'], clearances: [SUITE.PUBLIC, SUITE.RESTRICTED] };
 
 // ids sort as P1 < R < P2 so a withheld row sits between two visible ones (exercises page refill)
-const P1 = 'gov-1-pub', R = 'gov-2-sec', P2 = 'gov-3-pub', D = 'gov-4-derived', L = 'gov-5-late', E = 'gov-6-early';
+const P1 = 'gov-1-pub', R = 'gov-2-sec', P2 = 'gov-3-pub', D = 'gov-4-derived', L = 'gov-5-late', E = 'gov-6-early', B = 'gov-7-bottomup';
 
 const nowNs = () => BigInt(Date.now()) * 1_000_000n;
 const sorted = (xs: string[]) => xs.slice().sort().join(',');
@@ -325,6 +325,14 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
       if (await lowSees(E) || await lowFinds('early')) throw new Error('LOW reaches the early-edge derivation');
       return 'ok';
     });
+    await t('inheritance: a chain recorded bottom-up still restricts the entity at its end', async () => {
+      await seed(vessel(B, 'MV Bottomup', [SUITE.PUBLIC]));
+      await lineage.record({ upstream: 'gov-obs-4', downstream: entityRef(SUITE.type, B), kind: 'observation-entity' });
+      if (!await lowSees(B)) throw new Error('precondition: B is public until its chain reaches the marked source');
+      await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-4', kind: 'source-observation' });
+      if (await lowSees(B) || await lowFinds('bottomup')) throw new Error('LOW reaches B');
+      return 'ok';
+    });
     await t('invariant: markings never shrink, in the store or in a projection', async () => {
       await seed(vessel(D, 'MV Derived', [SUITE.PUBLIC]));        // a writer "forgets" the restriction
       if (await lowSees(D) || await lowFinds('derived')) throw new Error('re-writing D with fewer markings exposed it');
diff --git a/spine/governance.ts b/spine/governance.ts
index 5b8a419..ecf322c 100644
--- a/spine/governance.ts
+++ b/spine/governance.ts
@@ -1,22 +1,22 @@
 // spine/governance.ts — Phase 3: propagating security (the hardest-to-clone moat).
-// Three pieces: (1) MarkingPolicy = a real PEP MarkingResolver (no-read-up + FLS redaction);
-// (2) Session = governed reads that filter rows + redact fields per principal;
-// (3) propagate = stamp a marking down the lineage closure so "defined once at source" flows
-// to every derived entity. In-process here; the production swap is Keycloak (authn) + OPA
-// (policy) behind the same MarkingResolver/PolicyIdentity ports — no spine change.
+// This file holds the POLICY (who may see what), the RULE TABLE (how every port method is
+// classified) and propagate(). The read gate is spine/governed.ts; the write-side invariants
+// are spine/system.ts. Design: docs/specs/2026-10-06-governed-ports-design.md.
 import type { BoundPlatform } from './contracts.ts';
-import type { MarkingResolver, Principal, CanonicalStore } from './ports.ts';
-import type { CanonicalEntity, TypeName, EntityId, FieldName, Json, MarkingId, EntityQuery } from './model.ts';
+import type { MarkingResolver, Principal, RoleId, PortByRole, Adapter, IndexDoc } from './ports.ts';
+import type { CanonicalEntity, TypeName, EntityId, FieldName, Json, MarkingId } from './model.ts';
 
 /** Field-level security map: type → field → marking required to SEE that field. */
 export type FlsMap = Record<TypeName, Record<FieldName, MarkingId>>;
 
-/** A concrete MarkingResolver: no-read-up visibility + per-field FLS redaction. */
+/** Thrown when a governed call would be an oracle, needs in-engine enforcement, or names an unbound role. */
+export class GovernanceError extends Error {}
+
+/** The one visibility rule (spec §4.1): a principal sees a row iff it holds EVERY marking on it. */
 export class MarkingPolicy implements MarkingResolver {
   private fls: FlsMap;
   constructor(fls: FlsMap = {}) { this.fls = fls; }
 
-  /** principal may see data iff it holds EVERY marking on it (mandatory access control). */
   visible(principal: Principal, markings: MarkingId[]): boolean {
     return (markings ?? []).every((m) => principal.clearances.includes(m));
   }
@@ -29,60 +29,100 @@ export class MarkingPolicy implements MarkingResolver {
     for (const [field, need] of Object.entries(rules)) if (!principal.clearances.includes(need)) delete out[field];
     return out;
   }
-}
 
-/** A per-principal governed view of the platform. Reads go through the PEP; writes still go via P7. */
-export class Session {
-  private platform: BoundPlatform;
-  private principal: Principal;
-  private policy: MarkingResolver;
-  constructor(platform: BoundPlatform, principal: Principal, policy: MarkingResolver) {
-    this.platform = platform; this.principal = principal; this.policy = policy;
+  /** the marking needed to see `field` of `type`, if the field is protected. */
+  fieldMarking(type: TypeName, field: FieldName): MarkingId | undefined { return this.fls[type]?.[field]; }
+
+  /** the types whose rules apply: the named type, or every type when it is unknown or has no rules
+   *  of its own (a query may name a table rather than a type). */
+  private typesFor(type: TypeName | undefined): TypeName[] {
+    return type !== undefined && this.fls[type] ? [type] : Object.keys(this.fls);
   }
-  private store(): CanonicalStore { return this.platform.role('canonical-store'); }
-
-  /** row-level filter + field-level redaction on a single read. */
-  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
-    const e = await this.store().getEntity(type, id);
-    if (!e) return null;
-    if (!this.policy.visible(this.principal, e.markings ?? [])) return null;           // restricted view
-    return { ...e, fields: this.policy.redactFields(this.principal, type, e.fields) }; // FLS
+
+  /** is `field` protected on `type` — or, when the type is unknown, on any type? */
+  protectsField(type: TypeName | undefined, field: FieldName): boolean {
+    return this.typesFor(type).some((t) => this.fls[t][field] !== undefined);
+  }
+
+  /** may the principal filter, sort or aggregate on `field`? If not, the result would be an
+   *  oracle for a value it cannot read. */
+  canUseField(principal: Principal, type: TypeName | undefined, field: FieldName): boolean {
+    return this.typesFor(type).every((t) => this.fls[t][field] === undefined || principal.clearances.includes(this.fls[t][field]));
   }
-  /** same enforcement applied to a list. */
-  async listEntities(type: TypeName, q: EntityQuery): Promise<CanonicalEntity[]> {
-    const page = await this.store().listEntities(type, q);
-    return page.items
-      .filter((e) => this.policy.visible(this.principal, e.markings ?? []))
-      .map((e) => ({ ...e, fields: this.policy.redactFields(this.principal, type, e.fields) }));
+
+  /** every protected field removed, whoever asks — what a SHARED projection may hold. */
+  publicFields(type: TypeName, fields: Record<FieldName, Json>): Record<FieldName, Json> {
+    const rules = this.fls[type];
+    if (!rules) return fields;
+    const out: Record<FieldName, Json> = { ...fields };
+    for (const field of Object.keys(rules)) delete out[field];
+    return out;
   }
 }
 
+// ---------------------------------------------------------------------------
+// The rule table (spec §4.3). EVERY port method is classified:
+//   governed — callable by a principal, result filtered by spine/governed.ts
+//   open     — callable by a principal, unfiltered
+//   system   — not on the governed port; reachable only through platform.system()
+// `satisfies` makes an unclassified or misspelled method a compile error.
+// ---------------------------------------------------------------------------
+
+export type Rule = 'governed' | 'open' | 'system';
+type PortMethod<R extends RoleId> = Exclude<keyof PortByRole[R], keyof Adapter> & string;
+
+export const GOVERNANCE_RULES = {
+  'canonical-store': { getEntity: 'governed', listEntities: 'governed', getLinks: 'governed', putObservation: 'system', upsertEntity: 'system', putLink: 'system', transaction: 'system', markingsOf: 'system' },
+  'hot-cache': { get: 'governed', set: 'governed', del: 'governed', incr: 'governed', publish: 'governed', subscribe: 'governed' },
+  'stream': { subscribe: 'governed', publish: 'system', ack: 'system' },
+  'object-index': { search: 'governed', aggregate: 'governed', index: 'system', remove: 'system', searchCandidates: 'system', setMarkings: 'system' },
+  'graph': { neighbors: 'governed', shortestPath: 'governed', upsertNode: 'system', upsertEdge: 'system', query: 'system' },
+  'blob-cas': { get: 'open', presignRead: 'open', put: 'system' },
+  'vector': { knn: 'governed', upsert: 'system', remove: 'system' },
+  'timeseries-geo': { range: 'governed', downsample: 'governed', within: 'governed', append: 'system' },
+  'analytics-olap': { query: 'governed', registerExternal: 'system' },
+  'registry': { loadAll: 'open', get: 'open', versions: 'open', put: 'system' },
+  'audit-log': { scan: 'governed', export: 'governed', append: 'system' },
+  'lineage': { upstreamOf: 'governed', downstreamOf: 'governed', record: 'system', propagateMarking: 'system', applyMarking: 'system', effectiveMarkings: 'system' },
+  'policy-identity': { authenticate: 'open', authorize: 'open', members: 'open' },
+  'work-queue': { claim: 'system', complete: 'system', fail: 'system', enqueue: 'system' },   // jobs carry no markings yet
+} satisfies { [R in RoleId]: Record<PortMethod<R>, Rule> };
+
+export function ruleFor(role: RoleId, method: string): Rule | undefined {
+  return (GOVERNANCE_RULES[role] as Record<string, Rule>)[method];
+}
+
+// ---------------------------------------------------------------------------
+// Helpers shared by the gate, the system handle and callers
+// ---------------------------------------------------------------------------
+
+export function union(...sets: (MarkingId[] | undefined)[]): MarkingId[] {
+  return [...new Set(sets.flatMap((s) => s ?? []))];
+}
+
 /** Lineage ref convention: `${type}/${id}` for entities, plain id for sources/observations. */
 export function entityRef(type: TypeName, id: EntityId): string { return `${type}/${id}`; }
-function parseRef(ref: string): { type: TypeName; id: EntityId } | null {
+export function parseRef(ref: string): { type: TypeName; id: EntityId } | null {
   const i = ref.indexOf('/'); return i === -1 ? null : { type: ref.slice(0, i), id: ref.slice(i + 1) };
 }
 
+/** The index document for an entity: its markings, and NO protected field (spec §4.7). Build
+ *  every shared projection row with this so a protected value is never searchable. */
+export function indexDocFor(policy: MarkingPolicy, e: CanonicalEntity): IndexDoc {
+  const fields = policy.publicFields(e.type, e.fields);
+  return { id: e.id, type: e.type, text: Object.values(fields).map(String).join(' '), fields, markings: e.markings ?? [] };
+}
+
 /**
- * THE moat: apply `markings` at `ref` and propagate along the lineage closure, stamping every
- * downstream CANONICAL ENTITY's `markings` (union). Returns the entity refs actually re-stamped.
+ * THE moat: apply `markings` at `ref`, once. They are persisted at the ref (so later derivations
+ * inherit), stamped on every downstream entity and on its projections, and the act is audited.
+ * Returns the entity refs that were actually re-stamped.
  */
-export async function propagate(platform: BoundPlatform, ref: string, markings: MarkingId[]): Promise<string[]> {
-  const lineage = platform.role('lineage');
-  const store: CanonicalStore = platform.role('canonical-store');
-  const closure = await lineage.propagateMarking(ref, markings);   // records propagation edges + returns downstream refs
-  const stamped: string[] = [];
-  for (const r of closure) {
-    const parsed = parseRef(r);
-    if (!parsed) continue;                                          // skip non-entity refs (sources/observations)
-    const e = await store.getEntity(parsed.type, parsed.id);
-    if (!e) continue;
-    const next = [...new Set([...(e.markings ?? []), ...markings])];
-    if (next.length !== (e.markings ?? []).length) {
-      e.markings = next;
-      await store.upsertEntity(e);                                 // re-project with the inherited marking
-      stamped.push(r);
-    }
+export async function propagate(platform: BoundPlatform, ref: string, markings: MarkingId[], actor = 'system'): Promise<string[]> {
+  const sys = platform.system('governance.propagate');
+  const stamped = await sys.applyMarking(ref, markings);
+  if (sys.has('audit-log')) {
+    await sys.role('audit-log').append({ ts: platform.nowNs(), actor, action: 'admin', resource: ref, detail: { propagated: markings, to: stamped }, markings });
   }
   return stamped;
 }
diff --git a/spine/governed.ts b/spine/governed.ts
new file mode 100644
index 0000000..27e8eee
--- /dev/null
+++ b/spine/governed.ts
@@ -0,0 +1,363 @@
+// spine/governed.ts — the read gate. platform.as(principal) returns a GovernedPlatform whose
+// ports expose only the methods classified 'governed' or 'open' in GOVERNANCE_RULES, and every
+// governed result is filtered against the canonical store's markings (the authority) before it
+// leaves. An adapter bug can therefore hide rows, never reveal them. Anything the gate cannot
+// resolve fails closed. Design: docs/specs/2026-10-06-governed-ports-design.md §4.3.
+import type {
+  RoleId, Adapter, PortByRole, GovernedPortByRole, Principal, CanonicalStore, AuditLog, AuditRecord, Lineage,
+  LineageEdge, GraphNode, GraphEdge, TraversalSpec, ScoredId, Envelope,
+} from './ports.ts';
+import type { CanonicalEntity, EntityId, TypeName, FieldName, Json, MarkingId, TimeWindow } from './model.ts';
+import type { GovernanceConfig } from './contracts.ts';
+import { GovernanceError, parseRef } from './governance.ts';
+import { jstr } from './json.ts';
+
+type Bound = Partial<Record<RoleId, Adapter>>;
+
+/** the result of checking a batch of entity ids against the canonical store */
+interface Screen { ok: Set<EntityId>; hidden: Set<EntityId>; markings: MarkingId[] }
+
+/** an object exposing only `keys` of `a`, bound to it */
+function pick<T extends object, K extends keyof T>(a: T, keys: K[]): Pick<T, K> {
+  const out = {} as Pick<T, K>;
+  for (const k of keys) {
+    const v = a[k];
+    out[k] = (typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(a) : v) as T[K];
+  }
+  return out;
+}
+
+export class GovernedPlatform {
+  #bound: Bound;
+  #gov: GovernanceConfig;
+  readonly principal: Principal;
+  constructor(bound: Bound, principal: Principal, gov: GovernanceConfig) { this.#bound = bound; this.principal = principal; this.#gov = gov; }
+
+  has(r: RoleId): boolean { return !!this.#bound[r]; }
+
+  role<R extends RoleId>(r: R): GovernedPortByRole[R] {
+    const ports: { [K in RoleId]: () => GovernedPortByRole[K] } = {
+      'canonical-store': () => this.#canonical(),
+      'hot-cache': () => this.#cache(),
+      'stream': () => this.#stream(),
+      'object-index': () => this.#index(),
+      'graph': () => this.#graph(),
+      'blob-cas': () => pick(this.#raw('blob-cas'), ['get', 'presignRead']),
+      'vector': () => this.#vector(),
+      'timeseries-geo': () => this.#tracks(),
+      'analytics-olap': () => this.#olap(),
+      'registry': () => pick(this.#raw('registry'), ['loadAll', 'get', 'versions']),
+      'audit-log': () => this.#auditLog(),
+      'lineage': () => this.#lineage(),
+      'policy-identity': () => pick(this.#raw('policy-identity'), ['authenticate', 'authorize', 'members']),
+      'work-queue': () => ({}),   // system-only until jobs carry markings (GOVERNANCE_RULES)
+    };
+    return ports[r]();
+  }
+
+  // ------------------------------------------------------------------ shared machinery
+
+  #raw<R extends RoleId>(r: R): PortByRole[R] {
+    const a = this.#bound[r];
+    if (!a) throw new GovernanceError(`role ${r} is not bound in this client`);
+    return a as PortByRole[R];
+  }
+
+  /** Split entity ids into those the principal may see and those it may not. An id the
+   *  canonical store does not know is hidden: the gate fails closed. */
+  async #screen(ids: EntityId[]): Promise<Screen> {
+    const uniq = [...new Set(ids)];
+    const store = this.#bound['canonical-store'] as CanonicalStore | undefined;
+    const known = store && uniq.length ? await store.markingsOf(uniq) : {};
+    const ok = new Set<EntityId>(), hidden = new Set<EntityId>(), all = new Set<MarkingId>();
+    for (const id of uniq) {
+      const marks = known[id];
+      if (marks === undefined) { hidden.add(id); continue; }
+      for (const m of marks) all.add(m);
+      if (this.#gov.policy.visible(this.principal, marks)) ok.add(id); else hidden.add(id);
+    }
+    return { ok, hidden, markings: [...all] };
+  }
+
+  /** One read record per governed call. Its own markings cover returned AND withheld rows, so a
+   *  principal cannot learn a withheld count from its own audit trail (spec §4.8). */
+  async #audit(method: string, detail: Record<string, Json>, returned: number, withheld: number, markings: MarkingId[]): Promise<void> {
+    const log = this.#bound['audit-log'] as AuditLog | undefined;
+    const mode = this.#gov.auditReads;
+    if (!log || mode === 'none') return;
+    if (mode === 'marked' && withheld === 0 && markings.length === 0) return;
+    await log.append({ ts: this.#gov.nowNs(), actor: this.principal.id, action: 'read', resource: method, detail: { ...detail, returned, withheld }, markings });
+  }
+
+  /** refuse to filter, sort or aggregate on a field the principal cannot read (it would be an oracle) */
+  #needField(type: TypeName | undefined, field: FieldName): void {
+    if (!this.#gov.policy.canUseField(this.principal, type, field)) throw new GovernanceError(`field '${field}' is protected: this principal cannot filter, sort or aggregate on it`);
+  }
+
+  /** A shared projection never holds a protected field (indexDocFor), so nobody may name one in
+   *  a query against it: an engine that did hold the field would turn the filter into an oracle.
+   *  `filter` may be an engine-specific JSON shape, so every key and every string in it is checked. */
+  #noProtectedField(what: string, filter: Json | undefined): void {
+    const policy = this.#gov.policy;
+    const walk = (v: Json | undefined): void => {
+      if (typeof v === 'string') {
+        if (policy.protectsField(undefined, v)) throw new GovernanceError(`${what}: field '${v}' is protected and is not held in shared projections`);
+      } else if (Array.isArray(v)) v.forEach(walk);
+      else if (v !== null && typeof v === 'object') for (const [k, inner] of Object.entries(v)) { walk(k); walk(inner); }
+    };
+    walk(filter);
+  }
+
+  // ------------------------------------------------------------------ R1 canonical-store
+
+  #canonical(): GovernedPortByRole['canonical-store'] {
+    const store = this.#raw('canonical-store'), policy = this.#gov.policy, p = this.principal;
+    const view = (e: CanonicalEntity): CanonicalEntity => ({ ...e, fields: policy.redactFields(p, e.type, e.fields) });
+    return {
+      getEntity: async (type, id) => {
+        const e = await store.getEntity(type, id);
+        const ok = e !== null && policy.visible(p, e.markings ?? []);
+        await this.#audit('canonical-store.getEntity', { type, id }, ok ? 1 : 0, e !== null && !ok ? 1 : 0, e?.markings ?? []);
+        return ok ? view(e) : null;
+      },
+      listEntities: async (type, q) => {
+        for (const f of q.filter ?? []) this.#needField(type, f.field);
+        for (const o of q.orderBy ?? []) this.#needField(type, o.field);
+        const limit = q.limit ?? 50;
+        const items: CanonicalEntity[] = []; const marks = new Set<MarkingId>(); let withheld = 0;
+        let cursor = q.cursor;
+        // refill: ask for exactly what is still missing, so a withheld row never shortens a page
+        for (;;) {
+          const page = await store.listEntities(type, { ...q, cursor, limit: limit - items.length });
+          for (const e of page.items) {
+            for (const m of e.markings ?? []) marks.add(m);
+            if (policy.visible(p, e.markings ?? [])) items.push(view(e)); else withheld++;
+          }
+          cursor = page.cursor;
+          if (!cursor || items.length >= limit) break;
+        }
+        await this.#audit('canonical-store.listEntities', { type }, items.length, withheld, [...marks]);
+        return { items, cursor };
+      },
+      getLinks: async (type, id, linkType) => {
+        const links = await store.getLinks(type, id, linkType);
+        const s = await this.#screen([id, ...links.flatMap((l) => [l.from, l.to])]);
+        const out = s.ok.has(id) ? links.filter((l) => s.ok.has(l.from) && s.ok.has(l.to)) : [];
+        await this.#audit('canonical-store.getLinks', { type, id }, out.length, links.length - out.length, s.markings);
+        return out;
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R4 object-index
+
+  #index(): GovernedPortByRole['object-index'] {
+    const ix = this.#raw('object-index'), policy = this.#gov.policy, p = this.principal;
+    const enforcing = ix.capabilities.enforcesMarkings === true;
+    // protected fields are never in a shared index (indexDocFor), so nobody may query on them
+    const notIndexed = (type: TypeName | undefined, field: FieldName) => {
+      if (policy.protectsField(type, field)) throw new GovernanceError(`field '${field}' is protected and is not indexed`);
+    };
+    return {
+      search: async (q) => {
+        for (const f of q.filter ?? []) notIndexed(q.type, f.field);
+        for (const f of q.facets ?? []) notIndexed(q.type, f);
+        for (const o of q.sort ?? []) notIndexed(q.type, o.field);
+        const res = await ix.search({ ...q, principal: p });
+        const s = await this.#screen(res.hits.map((h) => h.id));          // backstop, whatever the engine claims
+        const hits = res.hits.filter((h) => s.ok.has(h.id));
+        await this.#audit('object-index.search', { type: q.type ?? null, text: q.text ?? null }, hits.length, res.hits.length - hits.length, s.markings);
+        return enforcing ? { hits, cursor: res.cursor, facets: res.facets, total: res.total } : { hits, cursor: res.cursor };
+      },
+      aggregate: async (q) => {
+        if (!enforcing) throw new GovernanceError('object-index.aggregate needs an engine that enforces markings');
+        for (const f of q.groupBy) notIndexed(q.type, f);
+        for (const m of q.metrics) if (m.field) notIndexed(q.type, m.field);
+        for (const f of q.filter ?? []) notIndexed(q.type, f.field);
+        return ix.aggregate({ ...q, principal: p });
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R5 graph
+
+  /** Breadth-first walk of one-hop expansions that never steps onto or through a node the
+   *  principal cannot see. Stops early once `target` is reached. */
+  async #walk(start: EntityId, spec: TraversalSpec, hops: number, target?: EntityId) {
+    const g = this.#raw('graph');
+    const nodes = new Map<EntityId, GraphNode>(), edges = new Map<string, GraphEdge>(), prev = new Map<EntityId, EntityId>();
+    const dist = new Map<EntityId, number>(), hidden = new Set<EntityId>(), marks = new Set<MarkingId>();
+    const note = (s: Screen) => { for (const h of s.hidden) hidden.add(h); for (const m of s.markings) marks.add(m); };
+    const first = await this.#screen([start]); note(first);
+    let frontier: EntityId[] = first.ok.has(start) ? [start] : [];
+    if (frontier.length) dist.set(start, 0);
+    for (let h = 0; h < hops && frontier.length && !(target !== undefined && dist.has(target)); h++) {
+      const next: EntityId[] = [];
+      for (const id of frontier) {
+        const sub = await g.neighbors(id, { ...spec, maxHops: 1 });
+        const s = await this.#screen(sub.nodes.map((n) => n.id)); note(s);
+        for (const n of sub.nodes) {
+          if (!s.ok.has(n.id)) continue;
+          nodes.set(n.id, n);
+          if (!dist.has(n.id)) { dist.set(n.id, h + 1); prev.set(n.id, id); next.push(n.id); }
+        }
+        for (const e of sub.edges) if (s.ok.has(e.from) && s.ok.has(e.to)) edges.set(`${e.from}|${e.to}|${e.linkType}`, e);
+      }
+      frontier = next;
+    }
+    return { nodes, edges, prev, dist, hidden, marks };
+  }
+
+  #graph(): GovernedPortByRole['graph'] {
+    return {
+      neighbors: async (id, spec) => {
+        this.#noProtectedField('graph.neighbors', (spec.filter ?? []).map((f) => f.field));
+        const w = await this.#walk(id, spec, spec.maxHops ?? 2);
+        await this.#audit('graph.neighbors', { id }, w.nodes.size, w.hidden.size, [...w.marks]);
+        return { nodes: [...w.nodes.values()], edges: [...w.edges.values()] };
+      },
+      shortestPath: async (a, b, spec) => {
+        this.#noProtectedField('graph.shortestPath', (spec.filter ?? []).map((f) => f.field));
+        const w = await this.#walk(a, spec, spec.maxHops ?? 6, b);
+        const length = w.dist.get(b);
+        await this.#audit('graph.shortestPath', { from: a, to: b }, length === undefined ? 0 : 1, w.hidden.size, [...w.marks]);
+        if (length === undefined) return null;
+        const path: EntityId[] = [b];
+        while (path[0] !== a) path.unshift(w.prev.get(path[0])!);
+        return { nodes: path, edges: [], length };
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R7 vector
+
+  #vector(): GovernedPortByRole['vector'] {
+    const v = this.#raw('vector');
+    return {
+      knn: async (vec, k, filter) => {
+        this.#noProtectedField('vector.knn', filter);
+        let out: ScoredId[] = []; let hidden = 0; let marks: MarkingId[] = [];
+        // over-fetch, drop what is not visible, widen until k remain or the store is exhausted
+        for (let want = k * 4, round = 0; round < 4; want *= 4, round++) {
+          const got = await v.knn(vec, want, filter);
+          const s = await this.#screen(got.map((r) => r.id));
+          out = got.filter((r) => s.ok.has(r.id)).slice(0, k); hidden = s.hidden.size; marks = s.markings;
+          if (out.length >= k || got.length < want) break;
+        }
+        await this.#audit('vector.knn', { k }, out.length, hidden, marks);
+        return out;
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R8 timeseries-geo
+
+  #tracks(): GovernedPortByRole['timeseries-geo'] {
+    const ts = this.#raw('timeseries-geo');
+    const one = async <T>(method: string, entityId: EntityId, read: () => Promise<T[]>): Promise<T[]> => {
+      const s = await this.#screen([entityId]);
+      const pts = s.ok.has(entityId) ? await read() : [];
+      await this.#audit(`timeseries-geo.${method}`, { entityId }, pts.length, s.hidden.size, s.markings);
+      return pts;
+    };
+    return {
+      range: (entityId, w) => one('range', entityId, () => ts.range(entityId, w)),
+      downsample: (entityId, w, bucketSec) => one('downsample', entityId, () => ts.downsample(entityId, w, bucketSec)),
+      within: async (geo, w) => {
+        const pts = await ts.within(geo, w);
+        const s = await this.#screen(pts.map((pt) => pt.entityId));
+        const out = pts.filter((pt) => s.ok.has(pt.entityId));
+        await this.#audit('timeseries-geo.within', {}, out.length, pts.length - out.length, s.markings);
+        return out;
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R9 analytics-olap
+
+  #olap(): GovernedPortByRole['analytics-olap'] {
+    const olap = this.#raw('analytics-olap'), p = this.principal;
+    return {
+      query: async (q) => {
+        if (!olap.capabilities.enforcesMarkings) throw new GovernanceError('analytics-olap.query needs an engine that enforces markings');
+        // For a principal `from` is a canonical type and every name a logical field of it. An
+        // enforcing engine resolves them that way and can reach no storage column or other
+        // table; a federated table reference has no such guarantee, so it is refused here.
+        if (q.from.includes('://')) throw new GovernanceError('federated tables are not available to principals');
+        for (const d of q.dimensions) this.#needField(q.from, d);
+        for (const m of q.measures) if (m.field) this.#needField(q.from, m.field);
+        for (const w of q.where ?? []) this.#needField(q.from, w.field);
+        return olap.query({ ...q, principal: p });
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R3 stream
+
+  #stream(): GovernedPortByRole['stream'] {
+    const stream = this.#raw('stream'), policy = this.#gov.policy, p = this.principal;
+    return {
+      subscribe: (topics, from) => {
+        const src = stream.subscribe(topics, from);      // subscribe now, filter as envelopes arrive
+        return { async *[Symbol.asyncIterator](): AsyncGenerator<Envelope> { for await (const env of src) if (policy.visible(p, env.markings ?? [])) yield env; } };
+      },
+    };
+  }
+
+  // ------------------------------------------------------------------ R11 audit-log
+
+  #auditLog(): GovernedPortByRole['audit-log'] {
+    const log = this.#raw('audit-log'), policy = this.#gov.policy, p = this.principal;
+    const scan = (filter: { actor?: string; resource?: string; window?: TimeWindow }) => ({
+      async *[Symbol.asyncIterator](): AsyncGenerator<AuditRecord> { for await (const rec of log.scan(filter)) if (policy.visible(p, rec.markings ?? [])) yield rec; },
+    });
+    return {
+      scan,
+      // formatted from the governed scan: the engine's own export cannot be filtered after the fact
+      export: (window, format) => ({
+        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
+          for await (const rec of scan({ window })) yield format === 'json' ? jstr(rec) : `${format.toUpperCase()}|${rec.actor}|${rec.action}|${rec.resource}`;
+        },
+      }),
+    };
+  }
+
+  // ------------------------------------------------------------------ R12 lineage
+
+  #lineage(): GovernedPortByRole['lineage'] {
+    const lineage = this.#raw('lineage'), policy = this.#gov.policy, p = this.principal;
+    const filter = async (method: string, edges: LineageEdge[]): Promise<LineageEdge[]> => {
+      const refs = [...new Set(edges.flatMap((e) => [e.upstream, e.downstream]))];
+      const s = await this.#screen(refs.flatMap((r) => parseRef(r)?.id ?? []));
+      const marks = new Set(s.markings), ok = new Map<string, boolean>();
+      for (const r of refs) {
+        const ent = parseRef(r), eff = await (lineage as Lineage).effectiveMarkings(r);
+        for (const m of eff) marks.add(m);
+        ok.set(r, (!ent || s.ok.has(ent.id)) && policy.visible(p, eff));
+      }
+      const out = edges.filter((e) => ok.get(e.upstream) && ok.get(e.downstream) && policy.visible(p, e.markings ?? []));
+      await this.#audit(`lineage.${method}`, {}, out.length, edges.length - out.length, [...marks]);
+      return out;
+    };
+    return {
+      upstreamOf: async (ref, maxHops) => filter('upstreamOf', await lineage.upstreamOf(ref, maxHops)),
+      downstreamOf: async (ref, maxHops) => filter('downstreamOf', await lineage.downstreamOf(ref, maxHops)),
+    };
+  }
+
+  // ------------------------------------------------------------------ R2 hot-cache
+
+  #cache(): GovernedPortByRole['hot-cache'] {
+    const c = this.#raw('hot-cache');
+    // principals share an entry only if they hold exactly the same clearances
+    const ns = `c[${[...this.principal.clearances].sort().join(',')}]:`;
+    return {
+      get: (k) => c.get(ns + k),
+      set: (k, v, ttlSec) => c.set(ns + k, v, ttlSec),
+      del: (k) => c.del(ns + k),
+      incr: (k, by) => c.incr(ns + k, by),
+      publish: c.publish ? (channel, msg) => c.publish!(ns + channel, msg) : undefined,
+      subscribe: c.subscribe ? (channel) => c.subscribe!(ns + channel) : undefined,
+    };
+  }
+}
diff --git a/spine/system.ts b/spine/system.ts
new file mode 100644
index 0000000..67003a8
--- /dev/null
+++ b/spine/system.ts
@@ -0,0 +1,123 @@
+// spine/system.ts — the raw-port handle for spine internals, ingest and seeding.
+// Everything here is the adapter itself, except five methods that are wrapped so that NO
+// in-process writer can break the marking invariants (spec §4.1, §4.6):
+//   I1  an entity's stored markings include every marking applied at a lineage ancestor
+//   I2  stored markings never shrink
+// Lineage is the record of what must flow down; entity rows and projections are the result.
+import type { RoleId, Adapter, PortByRole, CanonicalStore, Lineage, ObjectIndex, LineageEdge, IndexDoc } from './ports.ts';
+import type { CanonicalEntity, MarkingId, TypeName, EntityId, Tx } from './model.ts';
+import { GovernanceError, entityRef, parseRef, union } from './governance.ts';
+
+type Bound = Partial<Record<RoleId, Adapter>>;
+
+/** A view of `target` with some methods replaced; every other method stays bound to the adapter. */
+function wrap<T extends object>(target: T, overrides: Record<string, unknown>): T {
+  return new Proxy(target, {
+    get(t, prop) {
+      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
+      const v: unknown = Reflect.get(t, prop, t);
+      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
+    },
+  });
+}
+
+export class SystemPlatform {
+  #bound: Bound;
+  /** who is holding the raw ports — every call site names itself (the suite checks the list). */
+  readonly component: string;
+  constructor(bound: Bound, component: string) { this.#bound = bound; this.component = component; }
+
+  has(r: RoleId): boolean { return !!this.#bound[r]; }
+
+  role<R extends RoleId>(r: R): PortByRole[R] {
+    const a = this.#bound[r];
+    if (!a) throw new GovernanceError(`role ${r} is not bound in this client`);
+    if (r === 'canonical-store') return wrap(a, {
+      upsertEntity: (e: CanonicalEntity, tx?: Tx) => this.#upsertEntity(e, tx),
+    }) as PortByRole[R];
+    if (r === 'lineage') return wrap(a, {
+      record: (edge: LineageEdge) => this.#record(edge),
+      applyMarking: async (ref: string, markings: MarkingId[]) => { await this.applyMarking(ref, markings); },
+      propagateMarking: async (ref: string, markings: MarkingId[]) => {
+        const affected = await (a as Lineage).propagateMarking(ref, markings);   // persists at ref + records the closure
+        await this.#stampDown(ref, markings);
+        return affected;
+      },
+    }) as PortByRole[R];
+    if (r === 'object-index') return wrap(a, {
+      index: (type: TypeName, id: EntityId, doc: IndexDoc) => this.#index(type, id, doc),
+    }) as PortByRole[R];
+    return a as PortByRole[R];
+  }
+
+  /** Apply `markings` at `ref`: persist them there, then stamp `ref` (if it is an entity) and
+   *  every entity downstream of it. Returns the entity refs whose markings grew. */
+  async applyMarking(ref: string, markings: MarkingId[]): Promise<string[]> {
+    const lineage = this.#bound['lineage'] as Lineage | undefined;
+    if (lineage) await lineage.applyMarking(ref, markings);
+    return this.#stampDown(ref, markings);
+  }
+
+  async #stampDown(ref: string, markings: MarkingId[]): Promise<string[]> {
+    const lineage = this.#bound['lineage'] as Lineage | undefined;
+    const refs = [ref, ...(lineage ? (await lineage.downstreamOf(ref, 64)).map((e) => e.downstream) : [])];
+    const stamped: string[] = [];
+    for (const r of new Set(refs)) {
+      const ent = parseRef(r);
+      if (ent && await this.#stamp(ent.type, ent.id, markings)) stamped.push(r);
+    }
+    return stamped;
+  }
+
+  /** union `markings` into an existing entity and its projections; true if the set grew. */
+  async #stamp(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<boolean> {
+    const store = this.#bound['canonical-store'] as CanonicalStore | undefined;
+    const e = store ? await store.getEntity(type, id) : null;
+    if (!store || !e) return false;
+    const next = union(e.markings, markings);
+    if (next.length === (e.markings ?? []).length) return false;
+    await store.upsertEntity({ ...e, markings: next });
+    await this.#restamp(type, id, next);
+    return true;
+  }
+
+  /** push an entity's markings to every projection that keeps its own copy for in-engine filtering. */
+  async #restamp(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void> {
+    const ix = this.#bound['object-index'] as ObjectIndex | undefined;
+    if (ix?.capabilities.enforcesMarkings) await ix.setMarkings(type, id, markings);
+  }
+
+  /** I1 + I2 on every entity write: stored = given ∪ what it already had ∪ what its lineage demands. */
+  async #upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
+    const store = this.#bound['canonical-store'] as CanonicalStore;
+    const lineage = this.#bound['lineage'] as Lineage | undefined;
+    const ref = entityRef(e.type, e.id);
+    const existing = await store.getEntity(e.type, e.id);
+    const inherited = lineage ? await lineage.effectiveMarkings(ref) : [];
+    const markings = union(e.markings, existing?.markings, inherited);
+    await store.upsertEntity(markings.length ? { ...e, markings } : e, tx);
+    const fresh = markings.filter((m) => !(existing?.markings ?? []).includes(m));
+    if (!fresh.length) return;
+    await this.#restamp(e.type, e.id, markings);
+    // markings set directly on this entity must reach what is, or will be, derived from it
+    const direct = fresh.filter((m) => !inherited.includes(m));
+    if (lineage && direct.length) await this.applyMarking(ref, direct);
+  }
+
+  /** I1 when an edge arrives after the entities below it: everything downstream catches up at
+   *  once, whether the new edge points at an entity or at a ref further up its chain. */
+  async #record(edge: LineageEdge): Promise<void> {
+    const lineage = this.#bound['lineage'] as Lineage;
+    await lineage.record(edge);
+    const inherited = await lineage.effectiveMarkings(edge.downstream);
+    if (inherited.length) await this.#stampDown(edge.downstream, inherited);
+  }
+
+  /** I2 for projections: an index row never carries fewer markings than its canonical row. */
+  async #index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
+    const ix = this.#bound['object-index'] as ObjectIndex;
+    const store = this.#bound['canonical-store'] as CanonicalStore | undefined;
+    const canon = store ? (await store.markingsOf([id]))[id] : undefined;
+    await ix.index(type, id, { ...doc, markings: union(doc.markings, canon) });
+  }
+}
````

- [ ] **Step 4: Run everything**

Run:
```bash
npm run -s governance 2>&1 | grep -E "❌|passed"
for s in boot:edge boot:enterprise conformance automation; do npm run -s "$s" 2>&1 | grep -E "[0-9]+/[0-9]+ .*(passed|conformant)"; done; npm run -s typecheck; echo "tsc exit=$?"
```
Expected:
```
31/31 governance checks passed.
9/9 checks passed.
13/13 checks passed.
14/14 adapters conformant.
8/8 automation checks passed.
tsc exit=0
```

- [ ] **Step 5: Commit**

```bash
git add spine boot && git commit -m "governed ports: the gate — platform.as()/system(), governed ports, write-side marking invariants" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Prove the suite discriminates (after the commit, so the restore is safe)**

Each command breaks one mechanism, runs the suite, and restores the file. Run them one at a time.

```bash
show() { npm run -s governance 2>&1 | grep -E "❌|passed" | sed 's/ — .*//'; }
# 1. visibility always true
sed -i 's|    return (markings ?? \[\]).every((m) => principal.clearances.includes(m));|    return true;|' spine/governance.ts; show; git checkout -q -- spine/governance.ts
# 2. the system handle returns raw adapters
sed -i "s|if (r === 'canonical-store') return wrap|if (r === 'x1') return wrap|; s|if (r === 'lineage') return wrap|if (r === 'x2') return wrap|; s|if (r === 'object-index') return wrap|if (r === 'x3') return wrap|" spine/system.ts; show; git checkout -q -- spine/system.ts
# 3. the index engine ignores the principal
sed -i "s|    if (q.principal) { where.push(VISIBLE); params.push(JSON.stringify(q.principal.clearances)); }||; s|    const rows = (q.principal|    const rows = (false|" adapters/sqlite/object-index.ts; show; git checkout -q -- adapters/sqlite/object-index.ts
# 4. the graph gate lets the engine traverse several hops
sed -i "s|const sub = await g.neighbors(id, { ...spec, maxHops: 1 });|const sub = await g.neighbors(id, { ...spec, maxHops: 5 });|" spine/governed.ts; show; git checkout -q -- spine/governed.ts
git status --short   # must print nothing
```
Expected: mutation 1 → `14/31` (canonical, graph, vector, tracks, stream, audit, inheritance and lineage checks fail; search, counts and reports still hold because the engines filter independently). Mutation 2 → `27/31` (the three late-inheritance checks and "markings never shrink" fail). Mutation 3 → `29/31` (the count check and the propagation check fail; search still holds through the gate's re-check). Mutation 4 → `29/31` (both graph traversal checks fail).

---

### Task 3: The action gate

**Files:**
- Modify: `spine/kinetic.ts`, `spine/flows.ts`, `spine/governance-conformance.ts`

**Interfaces:**
- Consumes: `BoundPlatform.as()`, `.system()`, `.policy`; `MarkingPolicy.canUseField`, `.redactFields`; `union`, `entityRef`
- Produces (in `spine/kinetic.ts`):
  - `interface CreateSpec { type: TypeName; id: EntityId; fields: Record<FieldName, Json>; markings?: MarkingId[] }`
  - `interface Cause { envelopeId: string; markings?: MarkingId[] }`
  - `KineticExecutor.createEntity(spec: CreateSpec, principal: Principal, nowNs: bigint, cause?: Cause): Promise<ActionResult>` — refuses an existing id; the creator must hold `spec.markings ∪ cause.markings`
  - `KineticExecutor.invoke` — unchanged signature; a target the principal cannot see returns the same result as a missing one; `ActionResult.entity` is redacted for the invoking principal; when the action writes a protected field, its audit record and event carry that field's marking as well as the target's
  - `spine/governance-conformance.ts`: `AUTO` (the principal flows run as in the suite)

- [ ] **Step 1: Write the failing checks**

Apply Patch 5.

**Patch 5**

````diff
diff --git a/spine/governance-conformance.ts b/spine/governance-conformance.ts
index 4ced2a9..2773d90 100644
--- a/spine/governance-conformance.ts
+++ b/spine/governance-conformance.ts
@@ -8,6 +8,8 @@ import type { BoundPlatform } from './contracts.ts';
 import type { Principal, AuditRecord, Envelope } from './ports.ts';
 import type { CanonicalEntity, MarkingId } from './model.ts';
 import { GovernanceError, entityRef, indexDocFor, propagate } from './governance.ts';
+import { KineticExecutor } from './kinetic.ts';
+import { FlowEngine, type FlowRun } from './flows.ts';
 
 export interface Check { name: string; ok: boolean; info: string }
 
@@ -21,6 +23,8 @@ export const SUITE = {
 
 export const LOW: Principal = { id: 'gov-low', roles: ['operator'], clearances: [SUITE.PUBLIC] };
 export const HIGH: Principal = { id: 'gov-high', roles: ['operator'], clearances: [SUITE.PUBLIC, SUITE.RESTRICTED] };
+/** the principal flows run as in the suite: cleared for everything it will be asked to create */
+export const AUTO: Principal = { id: 'gov-automation', roles: ['automation'], clearances: [SUITE.PUBLIC, SUITE.RESTRICTED] };
 
 // ids sort as P1 < R < P2 so a withheld row sits between two visible ones (exercises page refill)
 const P1 = 'gov-1-pub', R = 'gov-2-sec', P2 = 'gov-3-pub', D = 'gov-4-derived', L = 'gov-5-late', E = 'gov-6-early', B = 'gov-7-bottomup';
@@ -351,6 +355,79 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
     });
   }
 
+  // ---------------------------------------------------------------- writes: the action gate
+  if (platform.has('registry') && platform.has('stream') && platform.has('policy-identity') && platform.has('audit-log')) {
+    const kinetic = new KineticExecutor(platform);
+    await kinetic.register({ name: 'gov:Rename', targetType: SUITE.type, params: { name: 'string' }, effects: { set: { [SUITE.name]: { param: 'name' } } } });
+    await kinetic.register({ name: 'gov:SetOwner', targetType: SUITE.type, params: { owner: 'string' }, effects: { set: { [SUITE.owner]: { param: 'owner' } } } });
+    await kinetic.register({ name: 'gov:IfOwnedBy', targetType: SUITE.type, preconditions: [{ field: SUITE.owner, op: 'eq', value: 'Somebody Else' }], effects: { set: { 'gov:checked': true } } });
+    const writes = async (resource: string) => { const out: AuditRecord[] = []; for await (const r of sys.role('audit-log').scan({ resource })) if (r.action === 'write') out.push(r); return out; };
+
+    await t('action gate: a restricted target is indistinguishable from a missing one', async () => {
+      const onRestricted = await kinetic.invoke('gov:Rename', { targetId: R, params: { name: 'pwned' } }, LOW, nowNs());
+      const onMissing = await kinetic.invoke('gov:Rename', { targetId: 'gov-missing', params: { name: 'pwned' } }, LOW, nowNs());
+      if (onRestricted.ok || onMissing.ok) throw new Error('an invoke succeeded');
+      if (onRestricted.reason?.replace(R, 'X') !== onMissing.reason?.replace('gov-missing', 'X')) throw new Error(`"${onRestricted.reason}" vs "${onMissing.reason}"`);
+      if ((await highStore.getEntity(SUITE.type, R))?.fields[SUITE.name] !== 'MV Secretname') throw new Error('the restricted entity was changed');
+      return onMissing.reason ?? 'ok';
+    });
+    await t('action gate: the returned entity is redacted for the caller', async () => {
+      const lo = await kinetic.invoke('gov:Rename', { targetId: P1, params: { name: 'MV Public' } }, LOW, nowNs());
+      const hi = await kinetic.invoke('gov:Rename', { targetId: P1, params: { name: 'MV Public' } }, HIGH, nowNs());
+      if (!lo.ok || !hi.ok) throw new Error(`LOW: ${lo.reason} HIGH: ${hi.reason}`);
+      if (lo.entity?.fields[SUITE.owner] !== undefined || hi.entity?.fields[SUITE.owner] !== 'Acme Shipping') throw new Error('redaction wrong');
+      return 'ok';
+    });
+    await t('action gate: a failed precondition on a protected field does not echo its value to LOW', async () => {
+      const lo = await kinetic.invoke('gov:IfOwnedBy', { targetId: P1 }, LOW, nowNs());
+      const hi = await kinetic.invoke('gov:IfOwnedBy', { targetId: P1 }, HIGH, nowNs());
+      if (lo.ok || hi.ok) throw new Error('precondition should fail');
+      if (lo.reason?.includes('Somebody') || !hi.reason?.includes('Somebody')) throw new Error(`LOW: ${lo.reason} | HIGH: ${hi.reason}`);
+      return lo.reason ?? 'ok';
+    });
+    await t('action gate: writing a protected field does not reveal its value through the audit log or the event stream', async () => {
+      const events = low.role('stream').subscribe(['action.**'], 'latest')[Symbol.asyncIterator]();
+      const r = await kinetic.invoke('gov:SetOwner', { targetId: P2, params: { owner: 'Hidden Holdings' } }, HIGH, nowNs());
+      if (!r.ok) throw new Error(`invoke failed: ${r.reason}`);
+      const seen: string[] = [];
+      for await (const rec of low.role('audit-log').scan({ resource: entityRef(SUITE.type, P2) })) seen.push(JSON.stringify(rec.detail ?? null));
+      const env = await first(events, 200);
+      if (env) seen.push(new TextDecoder().decode(env.payload));
+      if (seen.some((x) => x.includes('Hidden Holdings'))) throw new Error('LOW read the protected value it cannot see on the entity');
+      if ((await highStore.getEntity(SUITE.type, P2))?.fields[SUITE.owner] !== 'Hidden Holdings') throw new Error('the write did not happen');
+      return 'ok';
+    });
+    await t('action gate: createEntity checks the creator, inherits its cause, audits and records lineage', async () => {
+      const spec = { type: SUITE.type, id: 'gov-8-created', fields: { [SUITE.name]: 'MV Created' } };
+      const denied = await kinetic.createEntity({ ...spec, markings: [SUITE.RESTRICTED] }, LOW, nowNs());
+      if (denied.ok) throw new Error('LOW created an entity with a marking it does not hold');
+      const made = await kinetic.createEntity(spec, HIGH, nowNs(), { envelopeId: 'gov-env-1', markings: [SUITE.RESTRICTED] });
+      if (!made.ok) throw new Error(`HIGH create failed: ${made.reason}`);
+      if (await lowStore.getEntity(SUITE.type, spec.id)) throw new Error('the entity did not inherit its cause\'s marking');
+      if ((await writes(entityRef(SUITE.type, spec.id))).filter((r) => r.actor === HIGH.id).length !== 1) throw new Error('create was not audited once as the creator');
+      if (platform.has('lineage') && !(await sys.role('lineage').upstreamOf(entityRef(SUITE.type, spec.id))).some((e) => e.upstream === 'gov-env-1')) throw new Error('no lineage edge from the cause');
+      if ((await kinetic.createEntity(spec, HIGH, nowNs())).ok) throw new Error('create overwrote an existing entity');
+      return 'ok';
+    });
+    if (platform.has('work-queue')) await t('flows: createEntity goes through the action gate and inherits the trigger\'s markings', async () => {
+      const engine = new FlowEngine(platform, kinetic, AUTO, nowNs);
+      await engine.register({ id: 'gov-open-case', trigger: { kind: 'stream', topics: ['gov.flow.case'] },
+        steps: [{ kind: 'createEntity', type: 'gov:Case', idFrom: 'payload.caseId', fields: { 'gov:subject': { from: 'payload.subject' } } }] });
+      const runs: FlowRun[] = [];
+      void engine.start((r) => runs.push(r));
+      const trigger = (id: string, body: object): Envelope => ({ id, topic: 'gov.flow.case', source: 'src:gov@1.0.0', schema: 'gov:T', createdNs: nowNs(), markings: [SUITE.RESTRICTED], payload: new TextEncoder().encode(JSON.stringify(body)) });
+      await sys.role('stream').publish(trigger('gov-env-2', { caseId: 'gov-9-case', subject: 'restricted matter' }));
+      for (let i = 0; i < 50 && !runs.length; i++) await new Promise((res) => setTimeout(res, 20));
+      engine.stop();
+      if (runs[0]?.status !== 'completed') throw new Error(`run: ${runs[0]?.status ?? 'none'} ${runs[0]?.detail ?? ''}`);
+      if (await low.role('canonical-store').getEntity('gov:Case', 'gov-9-case')) throw new Error('LOW reads a case opened from a restricted envelope');
+      if (!await high.role('canonical-store').getEntity('gov:Case', 'gov-9-case')) throw new Error('HIGH cannot read the case');
+      const w = await writes(entityRef('gov:Case', 'gov-9-case'));
+      if (w.length !== 1 || w[0].actor !== AUTO.id || (w[0].detail as { action?: string }).action !== 'create') throw new Error(`audit: ${JSON.stringify(w.map((r) => [r.actor, r.detail]))}`);
+      return 'ok';
+    });
+  }
+
   // ---------------------------------------------------------------- structure
   await t('structure: a governed port carries no system method', async () => {
     const { GOVERNANCE_RULES } = await import('./governance.ts');
````

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run -s governance 2>&1 | grep -E "❌|passed" | cut -c1-170`
Expected:
```
  ❌ action gate: a restricted target is indistinguishable from a missing one — "missing clearance for OPS-RESTRICTED" vs "target gov:Vessel/gov-missing not found"
  ❌ action gate: the returned entity is redacted for the caller — redaction wrong
  ❌ action gate: a failed precondition on a protected field does not echo its value to LOW — LOW: precondition failed: gov:owner eq "Somebody Else" | HIGH: precondi
  ❌ action gate: writing a protected field does not reveal its value through the audit log or the event stream — LOW read the protected value it cannot see on the entity
  ❌ action gate: createEntity checks the creator, inherits its cause, audits and records lineage — kinetic.createEntity is not a function
  ❌ flows: createEntity goes through the action gate and inherits the trigger's markings — LOW reads a case opened from a restricted envelope
31/37 governance checks passed.
```

- [ ] **Step 3: Implement**

Apply Patch 6.

**Patch 6**

````diff
diff --git a/spine/flows.ts b/spine/flows.ts
index d6274bf..8d37afe 100644
--- a/spine/flows.ts
+++ b/spine/flows.ts
@@ -6,7 +6,8 @@
 import type { BoundPlatform } from './contracts.ts';
 import type { Principal, Envelope, TopicPattern, JobId } from './ports.ts';
 import type { TypeName, FieldName, Json, FilterOp } from './model.ts';
-import { KineticExecutor, matchOp } from './kinetic.ts';
+import { KineticExecutor, matchOp, type Cause } from './kinetic.ts';
+import type { SystemPlatform } from './system.ts';
 
 // ---------------------------------------------------------------------------
 // Flow definitions (pure data — registrable, versionable, packageable)
@@ -76,10 +77,11 @@ interface PendingApproval {
   context: Record<string, Json>;
   runId: string;
   role: string;
+  cause: Cause;                      // the triggering envelope: steps after the gate still inherit from it
 }
 
 export class FlowEngine {
-  private platform: BoundPlatform;
+  private sys: SystemPlatform;
   private kinetic: KineticExecutor;
   private flows: FlowDef[] = [];
   private pending = new Map<JobId, PendingApproval>();
@@ -90,13 +92,13 @@ export class FlowEngine {
   private stopped = false;
 
   constructor(platform: BoundPlatform, kinetic: KineticExecutor, automationUser: Principal, nowNs: () => bigint) {
-    this.platform = platform; this.kinetic = kinetic; this.automationUser = automationUser; this.nowNs = nowNs;
+    this.sys = platform.system('flows'); this.kinetic = kinetic; this.automationUser = automationUser; this.nowNs = nowNs;
   }
 
   /** Register a flow (also persisted to the R10 registry — flows are data like schemas). */
   async register(flow: FlowDef): Promise<void> {
     this.flows.push(flow);
-    await this.platform.role('registry').put({
+    await this.sys.role('registry').put({
       id: `flow-${flow.id}`, type: 'core:FlowDefinition', ts: 0n, source: 'platform',
       schemaVersion: 0x010000, name: `flow:${flow.id}`, semver: '1.0.0',
       jsonSchema: flow as unknown as Json,
@@ -106,7 +108,7 @@ export class FlowEngine {
   /** Consume the stream and trigger matching flows. Returns the runs it executed (resolves on stop()). */
   async start(onRun?: (run: FlowRun) => void): Promise<void> {
     const topics = [...new Set(this.flows.flatMap((f) => f.trigger.topics))];
-    const sub = this.platform.role('stream').subscribe(topics, 'latest');
+    const sub = this.sys.role('stream').subscribe(topics, 'latest');
     for await (const env of sub) {
       if (this.stopped) break;
       for (const flow of this.flows) {
@@ -124,10 +126,10 @@ export class FlowEngine {
     try { payload = JSON.parse(new TextDecoder().decode(env.payload)) as Json; } catch { payload = null; }
     const context: Record<string, Json> = { topic: env.topic, source: env.source, payload };
     const runId = `${flow.id}#${++this.runSeq}`;
-    return this.runSteps(flow, 0, context, runId);
+    return this.runSteps(flow, 0, context, runId, { envelopeId: env.id, markings: env.markings });
   }
 
-  private async runSteps(flow: FlowDef, from: number, context: Record<string, Json>, runId: string): Promise<FlowRun> {
+  private async runSteps(flow: FlowDef, from: number, context: Record<string, Json>, runId: string, cause: Cause): Promise<FlowRun> {
     for (let i = from; i < flow.steps.length; i++) {
       const step = flow.steps[i];
       if (step.kind === 'condition') {
@@ -138,9 +140,9 @@ export class FlowEngine {
         const id = (step.idFrom ? String(pluck(context, step.idFrom)) : `${flow.id}-${runId}`);
         const fields: Record<FieldName, Json> = {};
         for (const [k, b] of Object.entries(step.fields)) fields[k] = resolve(context, b);
-        const store = this.platform.role('canonical-store');
-        await store.upsertEntity({ id, type: step.type, ts: this.nowNs(), source: `flow:${flow.id}`, schemaVersion: 0x010000, fields, provenance: {}, markings: step.markings });
-        await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: `flow:${flow.id}`, action: 'write', resource: `${step.type}/${id}`, detail: { runId } });
+        // through the action gate, as the automation user; the entity inherits the trigger's markings
+        const r = await this.kinetic.createEntity({ type: step.type, id, fields, markings: step.markings }, this.automationUser, this.nowNs(), cause);
+        if (!r.ok) return { runId, flowId: flow.id, status: 'failed', detail: `createEntity ${step.type}: ${r.reason}`, context };
         if (step.saveAs) context[step.saveAs] = { id, type: step.type };
       } else if (step.kind === 'action') {
         const targetId = String(pluck(context, step.targetIdFrom) ?? '');
@@ -153,11 +155,11 @@ export class FlowEngine {
         const targetId = String(pluck(context, step.onApprove.targetIdFrom) ?? '');
         const params: Record<string, Json> = {};
         for (const [k, b] of Object.entries(step.onApprove.params ?? {})) params[k] = resolve(context, b);
-        const jobId = await this.platform.role('work-queue').enqueue({
+        const jobId = await this.sys.role('work-queue').enqueue({
           kind: 'approval', payload: { flowId: flow.id, runId, prompt: step.prompt, role: step.role, action: step.onApprove.action, targetId, params },
         });
-        this.pending.set(jobId, { jobId, flow, stepIndex: i, context, runId, role: step.role });
-        await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: `flow:${flow.id}`, action: 'write', resource: `approval/${jobId}`, detail: { runId, prompt: step.prompt, role: step.role } });
+        this.pending.set(jobId, { jobId, flow, stepIndex: i, context, runId, role: step.role, cause });
+        await this.sys.role('audit-log').append({ ts: this.nowNs(), actor: `flow:${flow.id}`, action: 'write', resource: `approval/${jobId}`, detail: { runId, prompt: step.prompt, role: step.role } });
         return { runId, flowId: flow.id, status: 'awaiting-approval', detail: jobId, context };
       }
     }
@@ -169,13 +171,13 @@ export class FlowEngine {
     const p = this.pending.get(jobId);
     if (!p) return { runId: 'unknown', flowId: 'unknown', status: 'failed', detail: `no pending approval ${jobId}`, context: {} };
     if (!principal.roles.includes(p.role)) {
-      await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: principal.id, action: 'admin', resource: `approval/${jobId}`, detail: { denied: `requires role ${p.role}` } });
+      await this.sys.role('audit-log').append({ ts: this.nowNs(), actor: principal.id, action: 'admin', resource: `approval/${jobId}`, detail: { denied: `requires role ${p.role}` } });
       return { runId: p.runId, flowId: p.flow.id, status: 'failed', detail: `principal lacks role '${p.role}'`, context: p.context };
     }
     this.pending.delete(jobId);
     if (!approved) {
-      await this.platform.role('work-queue').complete(jobId, { approved: false, by: principal.id });
-      await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: principal.id, action: 'write', resource: `approval/${jobId}`, detail: { approved: false } });
+      await this.sys.role('work-queue').complete(jobId, { approved: false, by: principal.id });
+      await this.sys.role('audit-log').append({ ts: this.nowNs(), actor: principal.id, action: 'write', resource: `approval/${jobId}`, detail: { approved: false } });
       return { runId: p.runId, flowId: p.flow.id, status: 'completed', detail: 'rejected', context: p.context };
     }
     const step = p.flow.steps[p.stepIndex];
@@ -184,10 +186,10 @@ export class FlowEngine {
     const params: Record<string, Json> = {};
     for (const [k, b] of Object.entries(step.onApprove.params ?? {})) params[k] = resolve(p.context, b);
     const r = await this.kinetic.invoke(step.onApprove.action, { targetId, params }, principal, this.nowNs());
-    await this.platform.role('work-queue').complete(jobId, { approved: true, by: principal.id, actionOk: r.ok });
+    await this.sys.role('work-queue').complete(jobId, { approved: true, by: principal.id, actionOk: r.ok });
     if (!r.ok) return { runId: p.runId, flowId: p.flow.id, status: 'failed', detail: `approved action failed: ${r.reason}`, context: p.context };
     // continue any steps after the approval gate
-    return this.runSteps(p.flow, p.stepIndex + 1, p.context, p.runId);
+    return this.runSteps(p.flow, p.stepIndex + 1, p.context, p.runId, p.cause);
   }
 
   pendingApprovals(): PendingApproval[] { return [...this.pending.values()]; }
diff --git a/spine/kinetic.ts b/spine/kinetic.ts
index 8c8f5b7..c0f5972 100644
--- a/spine/kinetic.ts
+++ b/spine/kinetic.ts
@@ -5,6 +5,8 @@
 import type { BoundPlatform } from './contracts.ts';
 import type { Principal } from './ports.ts';
 import type { TypeName, EntityId, FieldName, Json, MarkingId, FilterOp, CanonicalEntity } from './model.ts';
+import type { SystemPlatform } from './system.ts';
+import { entityRef, union } from './governance.ts';
 
 export interface ActionTypeDef {
   name: TypeName;                                   // 'planetar:ConfirmDarkVessel'
@@ -26,9 +28,25 @@ export interface ActionInvocation {
 export interface ActionResult {
   ok: boolean;
   reason?: string;
+  /** the entity after the write, redacted for the principal who invoked it */
   entity?: CanonicalEntity;
 }
 
+/** A new entity to create through the gate. */
+export interface CreateSpec {
+  type: TypeName;
+  id: EntityId;
+  fields: Record<FieldName, Json>;
+  markings?: MarkingId[];
+}
+
+/** What caused a create (the triggering envelope): its markings are inherited and it becomes
+ *  the new entity's lineage parent. */
+export interface Cause {
+  envelopeId: string;
+  markings?: MarkingId[];
+}
+
 export function matchOp(actual: Json | undefined, op: FilterOp, expected: Json): boolean {
   switch (op) {
     case 'eq': return actual === expected;
@@ -46,14 +64,20 @@ export function matchOp(actual: Json | undefined, op: FilterOp, expected: Json):
 
 export class KineticExecutor {
   private platform: BoundPlatform;
+  private sys: SystemPlatform;
   private defs = new Map<TypeName, ActionTypeDef>();
   private seq = 0;
-  constructor(platform: BoundPlatform) { this.platform = platform; }
+  constructor(platform: BoundPlatform) { this.platform = platform; this.sys = platform.system('kinetic'); }
+
+  private nextEventId(): string { return `00000000-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`; }
+  private redacted(e: CanonicalEntity, principal: Principal): CanonicalEntity {
+    return { ...e, fields: this.platform.policy.redactFields(principal, e.type, e.fields) };
+  }
 
   /** Register an Action Type (also persisted to the R10 registry for provenance/discovery). */
   async register(def: ActionTypeDef): Promise<void> {
     this.defs.set(def.name, def);
-    await this.platform.role('registry').put({
+    await this.sys.role('registry').put({
       id: `action-${def.name.replace(/[:/]/g, '_')}`, type: 'core:ActionType',
       ts: 0n, source: 'platform', schemaVersion: 0x010000,
       name: def.name, semver: '1.0.0', jsonSchema: def as unknown as Json,
@@ -74,12 +98,16 @@ export class KineticExecutor {
       if (typeof v !== t) return { ok: false, reason: `param '${p}' must be ${t}` };
     }
 
-    const store = this.platform.role('canonical-store');
+    // A target the principal cannot see is reported exactly like a missing one: the gate must
+    // not confirm that a restricted entity exists.
+    const notFound: ActionResult = { ok: false, reason: `target ${def.targetType}/${inv.targetId} not found` };
+    if (!await this.platform.as(principal).role('canonical-store').getEntity(def.targetType, inv.targetId)) return notFound;
+    const store = this.sys.role('canonical-store');
     const target = await store.getEntity(def.targetType, inv.targetId);
-    if (!target) return { ok: false, reason: `target ${def.targetType}/${inv.targetId} not found` };
+    if (!target) return notFound;
 
     // governance gate: principal must hold the action's markings AND the target's markings
-    const policy = this.platform.role('policy-identity');
+    const policy = this.sys.role('policy-identity');
     const need = [...new Set([...(def.requiresMarking ?? []), ...(target.markings ?? [])])];
     const decision = await policy.authorize(principal, `action:${actionName}`, { type: def.targetType, id: inv.targetId, markings: need });
     if (!decision.allow) return { ok: false, reason: decision.reason ?? 'denied' };
@@ -87,7 +115,9 @@ export class KineticExecutor {
     // preconditions against current state
     for (const pre of def.preconditions ?? []) {
       if (!matchOp(target.fields[pre.field], pre.op, pre.value)) {
-        return { ok: false, reason: `precondition failed: ${pre.field} ${pre.op} ${JSON.stringify(pre.value)}` };
+        // on a field the principal cannot read, say which check failed but not against what
+        const readable = this.platform.policy.canUseField(principal, def.targetType, pre.field);
+        return { ok: false, reason: `precondition failed: ${pre.field} ${pre.op}${readable ? ` ${JSON.stringify(pre.value)}` : ''}` };
       }
     }
 
@@ -102,18 +132,55 @@ export class KineticExecutor {
       return target;
     });
 
-    // audit + event on the bus (a human decision is just an envelope, like a sensor reading)
-    await this.platform.role('audit-log').append({
+    // audit + event on the bus (a human decision is just an envelope, like a sensor reading).
+    // Both carry the invocation params, so when the action writes a protected field they take
+    // that field's marking too: otherwise the value would be readable in the target's audit
+    // trail and events by a principal who cannot read it on the entity.
+    const written = Object.keys(def.effects.set).flatMap((f) => this.platform.policy.fieldMarking(def.targetType, f) ?? []);
+    const recordMarkings = union(updated.markings, written);
+    await this.sys.role('audit-log').append({
       ts: nowNs, actor: principal.id, action: 'write',
       resource: `${def.targetType}/${inv.targetId}`,
-      detail: { action: actionName, params: inv.params ?? {} }, markings: target.markings,
+      detail: { action: actionName, params: inv.params ?? {} }, markings: recordMarkings,
     });
-    await this.platform.role('stream').publish({
-      id: `00000000-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`,
+    await this.sys.role('stream').publish({
+      id: this.nextEventId(),
       topic: `action.${actionName.replace(/:/g, '.')}`, source: `principal:${principal.id}`,
-      schema: 'core:Event', createdNs: nowNs, markings: target.markings,
+      schema: 'core:Event', createdNs: nowNs, markings: recordMarkings,
       payload: new TextEncoder().encode(JSON.stringify({ action: actionName, target: inv.targetId, params: inv.params ?? {} })),
     });
-    return { ok: true, entity: updated };
+    return { ok: true, entity: this.redacted(updated, principal) };
+  }
+
+  /**
+   * The governed CREATE path (flows and agents use this; nothing writes entities directly).
+   * The creator must hold every marking the new entity will carry: its own plus its cause's.
+   * Never overwrites: an existing id is refused.
+   */
+  async createEntity(spec: CreateSpec, principal: Principal, nowNs: bigint, cause?: Cause): Promise<ActionResult> {
+    const markings = union(spec.markings, cause?.markings);
+    const decision = await this.sys.role('policy-identity').authorize(principal, `create:${spec.type}`, { type: spec.type, id: spec.id, markings });
+    if (!decision.allow) return { ok: false, reason: decision.reason ?? 'denied' };
+
+    const store = this.sys.role('canonical-store');
+    if (await store.getEntity(spec.type, spec.id)) return { ok: false, reason: `${spec.type}/${spec.id} already exists` };
+    await store.upsertEntity({
+      id: spec.id, type: spec.type, ts: nowNs, source: `principal:${principal.id}`, schemaVersion: 0x010000,
+      fields: spec.fields, provenance: {}, markings, causationId: cause?.envelopeId,
+    });
+    const ref = entityRef(spec.type, spec.id);
+    if (cause && this.sys.has('lineage')) await this.sys.role('lineage').record({ upstream: cause.envelopeId, downstream: ref, kind: 'transform', markings: cause.markings });
+    const created = (await store.getEntity(spec.type, spec.id))!;   // re-read: lineage may have added markings
+
+    await this.sys.role('audit-log').append({
+      ts: nowNs, actor: principal.id, action: 'write', resource: ref,
+      detail: { action: 'create', cause: cause?.envelopeId ?? null }, markings: created.markings,
+    });
+    await this.sys.role('stream').publish({
+      id: this.nextEventId(), topic: `action.create.${spec.type.replace(/:/g, '.')}`, source: `principal:${principal.id}`,
+      schema: 'core:Event', createdNs: nowNs, markings: created.markings, causationId: cause?.envelopeId,
+      payload: new TextEncoder().encode(JSON.stringify({ action: 'create', target: spec.id })),
+    });
+    return { ok: true, entity: this.redacted(created, principal) };
   }
 }
````

- [ ] **Step 4: Run everything**

Run:
```bash
npm run -s governance 2>&1 | grep -E "❌|passed"; npm run -s automation 2>&1 | grep -E "❌|audit trail|passed" | cut -c1-170
for s in boot:edge boot:enterprise conformance; do npm run -s "$s" 2>&1 | grep -E "[0-9]+/[0-9]+ .*(passed|conformant)"; done; npm run -s typecheck; echo "tsc exit=$?"
```
Expected:
```
37/37 governance checks passed.
  ✅ audit trail captures the whole chain (case, flag, approval, confirm) — flow writes=1, supervisor writes=2, denied attempt logged=1
8/8 automation checks passed.
9/9 checks passed.
13/13 checks passed.
14/14 adapters conformant.
tsc exit=0
```
(The audit counts in the automation demo shift because the case is now created by the automation user through the gate, and governed reads are audited. Task 4 makes that check count by action.)

- [ ] **Step 5: Commit**

```bash
git add spine && git commit -m "governed ports: the action gate — governed target load, redacted results, createEntity; flows create through it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Remove `role()`; structure checks

**Files:**
- Modify: `spine/contracts.ts`, `spine/governance-conformance.ts`, `boot/boot.ts`, `boot/automation.ts`

**Interfaces:**
- Consumes: `GOVERNANCE_RULES`, `SystemPlatform`
- Produces: `BoundPlatform` no longer has `role()`. `spine/governance-conformance.ts` exports `ADAPTER_HELPERS` (private helper names per role; a new private method on an adapter must be added here or the suite fails) and `SYSTEM_COMPONENTS` (`['flows', 'governance-suite', 'governance.propagate', 'kinetic']`).

- [ ] **Step 1: Write the failing checks**

Apply Patch 7.

**Patch 7**

````diff
diff --git a/spine/governance-conformance.ts b/spine/governance-conformance.ts
index 2773d90..74264fb 100644
--- a/spine/governance-conformance.ts
+++ b/spine/governance-conformance.ts
@@ -4,10 +4,11 @@
 // restricted rows — not their ids, counts, neighbours, paths, tracks, envelopes or audit trail —
 // while HIGH observes all of it. Engine-agnostic: it runs against whatever the manifest bound.
 // Design: docs/specs/2026-10-06-governed-ports-design.md §6.
+import { readdirSync, readFileSync } from 'node:fs';
 import type { BoundPlatform } from './contracts.ts';
-import type { Principal, AuditRecord, Envelope } from './ports.ts';
+import type { Principal, AuditRecord, Envelope, RoleId } from './ports.ts';
 import type { CanonicalEntity, MarkingId } from './model.ts';
-import { GovernanceError, entityRef, indexDocFor, propagate } from './governance.ts';
+import { GovernanceError, GOVERNANCE_RULES, entityRef, indexDocFor, propagate } from './governance.ts';
 import { KineticExecutor } from './kinetic.ts';
 import { FlowEngine, type FlowRun } from './flows.ts';
 
@@ -26,6 +27,17 @@ export const HIGH: Principal = { id: 'gov-high', roles: ['operator'], clearances
 /** the principal flows run as in the suite: cleared for everything it will be asked to create */
 export const AUTO: Principal = { id: 'gov-automation', roles: ['automation'], clearances: [SUITE.PUBLIC, SUITE.RESTRICTED] };
 
+/** Private helpers that sit on adapter prototypes (TypeScript `private` is not private at run
+ *  time). Any other method on a bound adapter must be classified in GOVERNANCE_RULES. */
+export const ADAPTER_HELPERS: Partial<Record<RoleId, string[]>> = {
+  'stream': ['framePrefix'], 'blob-cas': ['pathFor'], 'lineage': ['all', 'walk'], 'hot-cache': ['live'], 'vector': ['flush'], 'timeseries-geo': ['toPoints'],
+  'analytics-olap': ['tableQuery', 'typedQuery'],
+};
+const LIFECYCLE = ['constructor', 'init', 'health', 'close'];
+
+/** The only spine components that may take the raw-port handle. */
+export const SYSTEM_COMPONENTS = ['flows', 'governance-suite', 'governance.propagate', 'kinetic'];
+
 // ids sort as P1 < R < P2 so a withheld row sits between two visible ones (exercises page refill)
 const P1 = 'gov-1-pub', R = 'gov-2-sec', P2 = 'gov-3-pub', D = 'gov-4-derived', L = 'gov-5-late', E = 'gov-6-early', B = 'gov-7-bottomup';
 
@@ -429,8 +441,30 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
   }
 
   // ---------------------------------------------------------------- structure
+  await t('structure: the platform has no raw role() accessor', async () => {
+    if (typeof (platform as unknown as Record<string, unknown>).role !== 'undefined') throw new Error('BoundPlatform.role() still exists: callers can bypass the gate');
+    return 'ok';
+  });
+  await t('structure: every method on a bound adapter is classified', async () => {
+    let n = 0;
+    for (const role of Object.keys(GOVERNANCE_RULES) as RoleId[]) {
+      if (!platform.has(role)) continue;
+      const known = new Set([...LIFECYCLE, ...Object.keys(GOVERNANCE_RULES[role]), ...(ADAPTER_HELPERS[role] ?? [])]);
+      const unknown = Object.getOwnPropertyNames(Object.getPrototypeOf(sys.role(role))).filter((m) => !known.has(m));
+      if (unknown.length) throw new Error(`${role}: ${unknown.join(', ')} — classify in GOVERNANCE_RULES (or list as a private helper)`);
+      n++;
+    }
+    return `${n} adapter(s)`;
+  });
+  await t('structure: only the listed spine components take the system handle', async () => {
+    const dir = new URL('.', import.meta.url);
+    const found = new Set<string>();
+    for (const f of readdirSync(dir)) if (f.endsWith('.ts')) for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/\.system\('([^']+)'\)/g)) found.add(m[1]);
+    const got = [...found].sort().join(', ');
+    if (got !== SYSTEM_COMPONENTS.join(', ')) throw new Error(`spine takes system() as: ${got}`);
+    return got;
+  });
   await t('structure: a governed port carries no system method', async () => {
-    const { GOVERNANCE_RULES } = await import('./governance.ts');
     let n = 0;
     for (const [role, rules] of Object.entries(GOVERNANCE_RULES) as [keyof typeof GOVERNANCE_RULES, Record<string, string>][]) {
       if (!platform.has(role)) continue;
````

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run -s governance 2>&1 | grep -E "❌|passed" | cut -c1-170`
Expected:
```
  ❌ structure: the platform has no raw role() accessor — BoundPlatform.role() still exists: callers can bypass the gate
  ❌ structure: only the listed spine components take the system handle — spine takes system() as: flows, governance-suite, governance.propagate, kinetic, legacy
38/40 governance checks passed.
```

- [ ] **Step 3: Implement**

Apply Patch 8.

**Patch 8**

````diff
diff --git a/boot/automation.ts b/boot/automation.ts
index c7e1fd2..717321d 100644
--- a/boot/automation.ts
+++ b/boot/automation.ts
@@ -41,10 +41,11 @@ async function main() {
   rmSync('./.data/auto', { recursive: true, force: true });
   console.log('\n=== Phase 4: declarative automation (flows as data) ===');
   const { platform } = await compile(MANIFEST);
-  const store = platform.role('canonical-store');
-  const stream = platform.role('stream');
-  const audit = platform.role('audit-log');
-  const work = platform.role('work-queue');
+  const sys = platform.system('automation-demo');   // seeding + assertions read the raw roles
+  const store = sys.role('canonical-store');
+  const stream = sys.role('stream');
+  const audit = sys.role('audit-log');
+  const work = sys.role('work-queue');
 
   // --- kinetic Action Types (P7): the only write path flows may use ---
   const kinetic = new KineticExecutor(platform);
@@ -142,16 +143,17 @@ async function main() {
   await check('audit trail captures the whole chain (case, flag, approval, confirm)', async () => {
     let flowWrites = 0, supervisorWrites = 0, denied = 0;
     for await (const rec of audit.scan({})) {
-      if (rec.actor.startsWith('flow:')) flowWrites++;
-      if (rec.actor === SUPERVISOR.id) supervisorWrites++;
-      if (rec.actor === ANALYST.id) denied++;
+      // the flow acts as the automation user through the action gate; it parks approvals as itself
+      if (rec.action === 'write' && (rec.actor === AUTOMATION.id || rec.actor.startsWith('flow:'))) flowWrites++;
+      if (rec.action === 'write' && rec.actor === SUPERVISOR.id) supervisorWrites++;
+      if (rec.action === 'admin' && rec.actor === ANALYST.id) denied++;
     }
     if (!flowWrites || !supervisorWrites || !denied) throw new Error(`flow=${flowWrites} supervisor=${supervisorWrites} analystDenied=${denied}`);
     return `flow writes=${flowWrites}, supervisor writes=${supervisorWrites}, denied attempt logged=${denied}`;
   });
 
   await check('flow + action types are registered data (R10), not code', async () => {
-    const reg = platform.role('registry');
+    const reg = sys.role('registry');
     const flowDef = await reg.get('flow:dark-vessel-response');
     const actDef = await reg.get('planetar:FlagVessel');
     if (!flowDef || !actDef) throw new Error('definitions missing from registry');
diff --git a/boot/boot.ts b/boot/boot.ts
index f117187..f98e5c6 100644
--- a/boot/boot.ts
+++ b/boot/boot.ts
@@ -30,23 +30,26 @@ async function main() {
 
   console.log('\n=== Topology ===\n' + topology);
 
+  // this script is an operator's smoke test of the raw roles, so it takes the system handle
+  const sys = platform.system('boot');
+
   // --- health of every bound role ---
   console.log('\n=== Health ===');
   for (const r of bound) {
-    const h = await platform.role(r).health();
+    const h = await sys.role(r).health();
     console.log(`  ${h.ok ? '✅' : '❌'} ${r} (p99≈${h.p99Ms ?? '?'}ms)`);
   }
 
   // --- end-to-end smoke through the spine ports (engine-agnostic) ---
-  const store = platform.role('canonical-store');
-  const index = platform.role('object-index');
-  const stream = platform.role('stream');
-  const work = platform.role('work-queue');
-  const audit = platform.role('audit-log');
-  const registry = platform.role('registry');
-  const blob = platform.role('blob-cas');
-  const lineage = platform.role('lineage');
-  const policy = platform.role('policy-identity');
+  const store = sys.role('canonical-store');
+  const index = sys.role('object-index');
+  const stream = sys.role('stream');
+  const work = sys.role('work-queue');
+  const audit = sys.role('audit-log');
+  const registry = sys.role('registry');
+  const blob = sys.role('blob-cas');
+  const lineage = sys.role('lineage');
+  const policy = sys.role('policy-identity');
 
   const vid = randomUUID();
   const vessel: CanonicalEntity = {
@@ -127,7 +130,7 @@ async function main() {
 
   // --- optional roles: exercised only if this client's footprint bound them (role selectivity) ---
   if (platform.has('graph')) await check('graph.edges + neighbors + shortestPath', async () => {
-    const g = platform.role('graph');
+    const g = sys.role('graph');
     await g.upsertEdge({ from: vid, to: 'org-acme', linkType: 'crm:works_at' });
     await g.upsertEdge({ from: 'org-acme', to: 'org-parent', linkType: 'crm:subsidiary_of' });
     const nb = await g.neighbors(vid, { maxHops: 2, direction: 'out' });
@@ -136,7 +139,7 @@ async function main() {
     return `${nb.nodes.length} nodes in 2-hop, shortest path = ${sp?.length}`;
   });
   if (platform.has('vector')) await check('vector.upsert + knn (re-ID / RAG)', async () => {
-    const v = platform.role('vector');
+    const v = sys.role('vector');
     await v.upsert(vid, new Float32Array([1, 0, 0]), { kind: 'vessel-photo' });
     await v.upsert('other', new Float32Array([0, 1, 0]), {});
     const top = await v.knn(new Float32Array([0.9, 0.1, 0]), 1);
@@ -144,14 +147,14 @@ async function main() {
     return `nearest = ${top[0].id.slice(0, 8)}… (cos ${top[0].score.toFixed(3)})`;
   });
   if (platform.has('hot-cache')) await check('hot-cache.set + incr (presence/counters)', async () => {
-    const c = platform.role('hot-cache');
+    const c = sys.role('hot-cache');
     await c.set(`presence:${vid}`, 'online', 60);
     const n = await c.incr('rate:api', 1);
     if ((await c.get(`presence:${vid}`)) !== 'online' || n !== 1) throw new Error('cache wrong');
     return `presence cached, rate counter = ${n}`;
   });
   if (platform.has('timeseries-geo')) await check('timeseries-geo.append + range', async () => {
-    const ts = platform.role('timeseries-geo');
+    const ts = sys.role('timeseries-geo');
     const now = nowNs();
     await ts.append({ entityId: vid, ts: now, lat: 48.42, lon: -123.37, fields: { speed_kn: 12 } });
     const r = await ts.range(vid, { fromNs: now - 1_000_000_000n, toNs: now + 1_000_000_000n });
@@ -159,7 +162,7 @@ async function main() {
     return `${r.length} track point(s)`;
   });
   if (platform.has('analytics-olap')) await check('analytics-olap.query (report roll-up)', async () => {
-    const olap = platform.role('analytics-olap');
+    const olap = sys.role('analytics-olap');
     const res = await olap.query({ from: 'entity', dimensions: ['type'], measures: [{ fn: 'count', as: 'n' }], orderBy: [{ key: 'n', dir: 'desc' }] });
     if (!res.rows.length) throw new Error('no rows');
     return `${res.rows.length} group(s); top: ${JSON.stringify(res.rows[0])}`;
diff --git a/spine/contracts.ts b/spine/contracts.ts
index d17f252..c1b4d66 100644
--- a/spine/contracts.ts
+++ b/spine/contracts.ts
@@ -3,7 +3,7 @@
 // binder skeleton. Phase 0/1 of 90-ROADMAP.md. An engine may bind a role only if
 // its declared AdapterCapabilities SATISFY the role contract here.
 
-import type { RoleId, AdapterCapabilities, Adapter, PortByRole, AdapterContext, EngineName, ResolvedBinding, Logger, MarkingResolver, Principal } from './ports.ts';
+import type { RoleId, AdapterCapabilities, Adapter, AdapterContext, EngineName, ResolvedBinding, Logger, MarkingResolver, Principal } from './ports.ts';
 import { MarkingPolicy } from './governance.ts';
 import { GovernedPlatform } from './governed.ts';
 import { SystemPlatform } from './system.ts';
@@ -138,8 +138,6 @@ export class BoundPlatform {
   as(principal: Principal): GovernedPlatform { return new GovernedPlatform(this.#bound, principal, this.#gov); }
   /** Raw ports for spine internals, ingest and seeding. `component` names the caller. */
   system(component: string): SystemPlatform { return new SystemPlatform(this.#bound, component); }
-  /** @deprecated use as(principal) or system(component); removed once every caller has moved. */
-  role<R extends RoleId>(r: R): PortByRole[R] { return this.system('legacy').role(r); }
   get policy(): MarkingPolicy { return this.#gov.policy; }
   nowNs(): bigint { return this.#gov.nowNs(); }
   has(r: RoleId): boolean { return !!this.#bound[r]; }
````

- [ ] **Step 4: Run everything**

Run:
```bash
npm run -s governance 2>&1 | grep -E "❌|passed"; npm run -s automation 2>&1 | grep -E "❌|audit trail|passed" | cut -c1-170
for s in boot:edge boot:enterprise conformance; do npm run -s "$s" 2>&1 | grep -E "[0-9]+/[0-9]+ .*(passed|conformant)"; done; npm run -s typecheck; echo "tsc exit=$?"; grep -rn "platform\.role(" spine boot
```
Expected:
```
40/40 governance checks passed.
  ✅ audit trail captures the whole chain (case, flag, approval, confirm) — flow writes=3, supervisor writes=1, denied attempt logged=1
8/8 automation checks passed.
9/9 checks passed.
13/13 checks passed.
14/14 adapters conformant.
tsc exit=0
```
and the final `grep` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add spine boot && git commit -m "governed ports: remove BoundPlatform.role(); boot scripts take the system handle; structure checks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Edge conditions (Review Focus)

**Files:**
- Modify: `spine/governance-conformance.ts`, `boot/governance.ts`, `spine/conformance.ts`, `adapters/sqlite/canonical-store.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `CanonicalStore.transaction` on the sqlite adapter queues: a caller that arrives while a transaction is open waits for it instead of failing on a nested `BEGIN`. No signature changes.

- [ ] **Step 1: Write the checks**

Apply Patch 9. It adds the five Review Focus checks, a second suite run against a five-role client with read auditing off, and a per-adapter check that transactions started together run one after another.

**Patch 9**

````diff
diff --git a/boot/governance.ts b/boot/governance.ts
index 39e3b5b..c1acf26 100644
--- a/boot/governance.ts
+++ b/boot/governance.ts
@@ -34,11 +34,37 @@ const MANIFEST: ClientManifest = {
   },
 };
 
+// A client that binds only the five roles kinetic writes need, with read auditing off: the gate
+// and the write-side invariants must work when lineage, index, graph, cache and the rest are absent.
+const MINIMAL: ClientManifest = {
+  schema_version: '1.0',
+  client: { id: 'gov-minimal', name: 'Governed-Ports Proof (minimal roles)', tier: 'edge' },
+  capabilities: ['kinetic-writes', 'audit'],
+  roles: {
+    'canonical-store': { engine: 'sqlite', config: { path: `${D}/min/canonical.db` } },
+    'registry': { engine: 'git-fs', config: { path: `${D}/min/registry` } },
+    'audit-log': { engine: 'append-wal', config: { path: `${D}/min/audit.log` } },
+    'stream': { engine: 'file', config: { path: `${D}/min/stream.wal` } },
+    'policy-identity': { engine: 'internal', config: { clearances: ['UNCLASS'] } },
+  },
+  governance: { fls: { [SUITE.type]: { [SUITE.owner]: SUITE.RESTRICTED } }, audit: { reads: 'none' } },
+};
+
 async function main() {
   rmSync(D, { recursive: true, force: true });
   console.log('\n=== Phase 3: governed ports (adversarial suite) ===');
   const { platform } = await compile(MANIFEST);
   const results = await governanceSuite(platform);
+
+  const minimal = (await compile(MINIMAL)).platform;
+  for (const r of await governanceSuite(minimal)) {
+    // with read auditing off there is no read trail to assert on; every other check must hold
+    if (r.name.startsWith('audit: a marked read is recorded')) continue;
+    results.push({ ...r, name: `[minimal roles] ${r.name}` });
+  }
+  let reads = 0; for await (const rec of minimal.system('governance-demo').role('audit-log').scan({})) if (rec.action === 'read') reads++;
+  results.push({ name: '[minimal roles] governance.audit.reads = none writes no read records', ok: reads === 0, info: `${reads} read record(s)` });
+  await minimal.closeAll();
   console.log('\n=== Results ===');
   for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.info}`);
   const passed = results.filter((r) => r.ok).length;
diff --git a/spine/conformance.ts b/spine/conformance.ts
index 38e75b9..b689dd0 100644
--- a/spine/conformance.ts
+++ b/spine/conformance.ts
@@ -40,6 +40,15 @@ const SUITES: Partial<Record<RoleId, (a: Adapter, t: T) => Promise<void>>> = {
       try { await s.transaction(async () => { await s.upsertEntity({ id: 'c2', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} }); throw new Error('boom'); }); } catch { /* expected */ }
       return 'rolled back';
     });
+    await t('transactions started together run one after another', async () => {
+      const put = (id: string) => s.transaction(async () => {
+        await s.upsertEntity({ id, type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} });
+        await new Promise((r) => setTimeout(r, 5));          // hold the transaction open across a real await
+        return id;
+      });
+      for (const id of await Promise.all(['t1', 't2', 't3'].map(put))) if (!await s.getEntity('x:T', id)) throw new Error(`${id} was not committed`);
+      return 'ok';
+    });
     await t('markingsOf: known ids with their markings, unknown ids omitted', async () => {
       await s.upsertEntity({ id: 'm1', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {}, markings: ['A', 'B'] });
       await s.upsertEntity({ id: 'm2', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} });
diff --git a/spine/governance-conformance.ts b/spine/governance-conformance.ts
index 74264fb..e2af438 100644
--- a/spine/governance-conformance.ts
+++ b/spine/governance-conformance.ts
@@ -124,6 +124,16 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
     return 'ok';
   });
 
+  await t('rule: an unmarked row is public; with no clearances every marked row is withheld and paging still ends', async () => {
+    const NONE: Principal = { id: 'gov-none', roles: [], clearances: [] };
+    const none = platform.as(NONE).role('canonical-store');
+    await store.upsertEntity({ id: 'gov-0-open', type: 'gov:Open', ts: nowNs(), source: 'src:gov@1.0.0', schemaVersion: 0x010000, fields: { 'gov:note': 'public' }, provenance: {} });
+    if (!await none.getEntity('gov:Open', 'gov-0-open')) throw new Error('an unmarked row was withheld');
+    const page = await none.listEntities(SUITE.type, { limit: 2 });
+    if (page.items.length || page.cursor !== undefined) throw new Error(`expected an empty, final page; got ${page.items.length} item(s), cursor ${page.cursor}`);
+    return 'ok';
+  });
+
   // ---------------------------------------------------------------- object-index
   if (platform.has('object-index')) {
     const lowIx = low.role('object-index'), highIx = high.role('object-index');
@@ -173,6 +183,13 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
       }
       return 'ok';
     });
+    await t('graph: a node the canonical store does not know is hidden from everyone', async () => {
+      await g.upsertEdge({ from: P1, to: 'gov-not-an-entity', linkType: 'gov:met' });
+      const hi = await high.role('graph').neighbors(P1, { maxHops: 2, direction: 'out' });
+      if (sorted(hi.nodes.map((n) => n.id)) !== sorted([P1, R, P2])) throw new Error(`HIGH nodes=${hi.nodes.map((n) => n.id).join(',')}`);
+      if (hi.edges.some((e) => e.to === 'gov-not-an-entity')) throw new Error('an edge to the unknown node was returned');
+      return 'ok';
+    });
   }
 
   // ---------------------------------------------------------------- vector
@@ -211,6 +228,13 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
       if ((await hts.range(R, w)).length !== 1 || (await hts.within(here, w)).length !== 2) throw new Error('HIGH is missing points');
       return 'ok';
     });
+    await t('timeseries-geo: a track for an id the canonical store does not know is hidden from everyone', async () => {
+      await ts.append({ entityId: 'gov-not-an-entity', ts: now, lat: 48.4, lon: -123.4 });
+      const hts = high.role('timeseries-geo');
+      if ((await hts.range('gov-not-an-entity', w)).length) throw new Error('range returned an unknown entity\'s track');
+      if ((await hts.within(here, w)).length !== 2) throw new Error('area query returned an unknown entity\'s point');
+      return 'ok';
+    });
   }
 
   // ---------------------------------------------------------------- analytics-olap
@@ -421,6 +445,23 @@ export async function governanceSuite(platform: BoundPlatform): Promise<Check[]>
       if ((await kinetic.createEntity(spec, HIGH, nowNs())).ok) throw new Error('create overwrote an existing entity');
       return 'ok';
     });
+    await t('action gate: concurrent actions and a propagation lose neither a write nor a marking', async () => {
+      const ids = ['gov-c1', 'gov-c2', 'gov-c3', 'gov-c4'];
+      for (const id of ids) await seed(vessel(id, 'MV Concurrent', [SUITE.PUBLIC]));
+      if (platform.has('lineage')) for (const id of ids) await sys.role('lineage').record({ upstream: 'src:gov-concurrent', downstream: entityRef(SUITE.type, id), kind: 'observation-entity' });
+      const results = await Promise.all([
+        ...ids.map((id, i) => kinetic.invoke('gov:Rename', { targetId: id, params: { name: `MV Renamed ${i}` } }, HIGH, nowNs())),
+        propagate(platform, 'src:gov-concurrent', [SUITE.RESTRICTED], 'gov-admin').then((): { ok: boolean; reason?: string } => ({ ok: true })),
+      ]);
+      const failed = results.filter((r) => !r.ok);
+      if (failed.length) throw new Error(`${failed.length} call(s) failed: ${failed.map((r) => r.reason).join('; ')}`);
+      for (const [i, id] of ids.entries()) {
+        const e = await highStore.getEntity(SUITE.type, id);
+        if (e?.fields[SUITE.name] !== `MV Renamed ${i}`) throw new Error(`${id}: the rename was lost (name = ${e?.fields[SUITE.name]})`);
+        if (platform.has('lineage') && await lowStore.getEntity(SUITE.type, id)) throw new Error(`${id}: the marking was lost`);
+      }
+      return 'ok';
+    });
     if (platform.has('work-queue')) await t('flows: createEntity goes through the action gate and inherits the trigger\'s markings', async () => {
       const engine = new FlowEngine(platform, kinetic, AUTO, nowNs);
       await engine.register({ id: 'gov-open-case', trigger: { kind: 'stream', topics: ['gov.flow.case'] },
````

- [ ] **Step 2: Run them and see which fail**

Run: `npm run -s conformance 2>&1 | grep -E "❌|conformant" | cut -c1-170; npm run -s governance 2>&1 | grep -E "❌|passed" | cut -c1-170`
Expected:
```
  ❌ canonical-store/sqlite — transactions started together run one after another: cannot start a transaction within a transaction
13/14 adapters conformant.
  ❌ action gate: concurrent actions and a propagation lose neither a write nor a marking — cannot start a transaction within a transaction
  ❌ [minimal roles] action gate: concurrent actions and a propagation lose neither a write nor a marking — cannot start a transaction within a transaction
62/64 governance checks passed.
```
The other four conditions already hold. The crash is not caused by this work: four concurrent `kinetic.invoke` calls fail the same way on commit `51afe11`.

- [ ] **Step 3: Fix the store**

Apply Patch 10.

**Patch 10**

````diff
diff --git a/adapters/sqlite/canonical-store.ts b/adapters/sqlite/canonical-store.ts
index 814317c..0038618 100644
--- a/adapters/sqlite/canonical-store.ts
+++ b/adapters/sqlite/canonical-store.ts
@@ -19,6 +19,7 @@ CREATE INDEX IF NOT EXISTS link_from ON link(from_id);
 
 export class SqliteCanonicalStore implements CanonicalStore {
   private db!: DatabaseSync;
+  private txTail: Promise<unknown> = Promise.resolve();   // the queue transaction() serialises on
   readonly capabilities: AdapterCapabilities = { consistency: 'strong', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 5 };
 
   async init(ctx: AdapterContext): Promise<void> {
@@ -60,10 +61,17 @@ export class SqliteCanonicalStore implements CanonicalStore {
     for (const r of rows) out[r.id] = [...new Set([...(out[r.id] ?? []), ...(JSON.parse(r.m ?? '[]') as MarkingId[])])];
     return out;
   }
+  /** One connection, so transactions run strictly one after another: a caller that arrives
+   *  while one is open waits for it to commit or roll back (a nested BEGIN would throw). */
   async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
-    this.db.exec('BEGIN');
-    try { const r = await fn({ id: 'sqlite-tx' }); this.db.exec('COMMIT'); return r; }
-    catch (e) { this.db.exec('ROLLBACK'); throw e; }
+    const run = async (): Promise<T> => {
+      this.db.exec('BEGIN');
+      try { const r = await fn({ id: 'sqlite-tx' }); this.db.exec('COMMIT'); return r; }
+      catch (e) { this.db.exec('ROLLBACK'); throw e; }
+    };
+    const result = this.txTail.then(run, run);
+    this.txTail = result.catch(() => undefined);
+    return result;
   }
   async health(): Promise<HealthStatus> { this.db.prepare('SELECT 1').get(); return { ok: true, p99Ms: 5 }; }
   async close(): Promise<void> { this.db.close(); }
````

- [ ] **Step 4: Run everything**

Run:
```bash
for s in conformance governance automation boot:edge boot:enterprise; do npm run -s "$s" 2>&1 | grep -E "❌|[0-9]+/[0-9]+ .*(passed|conformant)"; done; npm run -s typecheck; echo "tsc exit=$?"
```
Expected:
```
14/14 adapters conformant.
64/64 governance checks passed.
8/8 automation checks passed.
9/9 checks passed.
13/13 checks passed.
tsc exit=0
```

- [ ] **Step 5: Commit**

```bash
git add spine boot adapters && git commit -m "governed ports: edge conditions — minimal-role client, unmarked rows, unknown ids, audit mode, concurrent actions; sqlite store queues transactions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

States what is now built, with backing paths, and corrects the spec where planning found it short: five wrapped methods on the system handle rather than three; the stricter reading of a principal's OLAP query; protected-field rules for graph and vector filters; markings on action audit records and events; the work queue made system-only; two more known limitations.

**Files:**
- Modify: `README.md`, `boot/README.md`, `spine/README.md`, `90-ROADMAP.md`, `91-HANDOFF.md`, `12-ADAPTER-CONTRACT.md`, `docs/specs/2026-10-06-governed-ports-design.md`
- Modify: `20-PARITY-MATRIX/README.md`, `palantir-foundry-governance.md`, `palantir-foundry-data.md`, `palantir-foundry-semantic.md`, `palantir-gotham.md`

**Interfaces:**
- Consumes: the final check counts (governance 64/64)
- Produces: nothing code depends on

What changes in the parity matrix: ten rows move from *designed* to *partial* (five in the governance slice, two in data, two in Gotham, one in semantic), each naming the file that backs it and what is still open. Totals move from 170 partial / 226 designed to 180 / 216. `91-HANDOFF.md` is a dated record, so it gains a dated note and is otherwise untouched.

- [ ] **Step 1: Apply the edits**

Apply Patch 11.

**Patch 11**

````diff
diff --git a/12-ADAPTER-CONTRACT.md b/12-ADAPTER-CONTRACT.md
index c1ea8df..ac63e66 100644
--- a/12-ADAPTER-CONTRACT.md
+++ b/12-ADAPTER-CONTRACT.md
@@ -242,11 +242,12 @@ export async function bind(manifest: ClientManifest, logger: Logger): Promise<Bo
 }
 ```
 
-The spine then asks the `BoundPlatform` for ports by role:
+The `BoundPlatform` keeps the adapters private. A caller takes one of two handles (§6):
 
 ```ts
-const store = platform.role<CanonicalStore>('canonical-store');   // typed; engine-agnostic
-await store.upsertEntity(entity);
+const store = platform.as(principal).role('canonical-store');     // governed: filtered reads, no writes
+const raw = platform.system('ingest').role('canonical-store');    // spine internals, ingest, seeding
+await raw.upsertEntity(entity);
 ```
 
 ---
@@ -276,3 +277,18 @@ export function canonicalStoreConformance(make: () => CanonicalStore) {
 ```
 
 **Same suite, every engine.** Green across the matrix = a client can bind any of them and the spine behaves identically.
+
+---
+
+## 6. Governance obligations of an adapter
+
+Design: [`docs/specs/2026-10-06-governed-ports-design.md`](./docs/specs/2026-10-06-governed-ports-design.md). The gate ([`spine/governed.ts`](./spine/governed.ts)) filters every row-returning result against the canonical store, so most adapters need nothing extra. What an adapter must provide:
+
+| Role | Obligation |
+|---|---|
+| canonical-store | `markingsOf(ids)` — stored markings by entity id; ids it does not hold are omitted. This is the authority every governed read is checked against. |
+| lineage | `applyMarking(ref, markings)` persists a marking at a ref; `effectiveMarkings(ref)` returns markings applied at the ref or anywhere upstream; marking records never appear as edges. |
+| object-index | `setMarkings(type, id, markings)` replaces the markings stored with a row. |
+| any role that answers **aggregates** for principals (object-index `aggregate`, analytics-olap `query`) | declare `capabilities.enforcesMarkings` and, when the query carries `principal`: select and aggregate only rows whose every marking the principal holds, **and** resolve every name in the query as a logical field of a canonical type — never as a storage column or another table. Without the flag the gate refuses the call. |
+
+Every port method is classified `governed`, `open` or `system` in `GOVERNANCE_RULES` ([`spine/governance.ts`](./spine/governance.ts)). A new method must be classified there, or `tsc` and `npm run governance` both fail. Adapters are checked for the row above by `npm run conformance`, and against a low-clearance attacker by `npm run governance`.
diff --git a/20-PARITY-MATRIX/README.md b/20-PARITY-MATRIX/README.md
index de26b82..5be5857 100644
--- a/20-PARITY-MATRIX/README.md
+++ b/20-PARITY-MATRIX/README.md
@@ -8,12 +8,12 @@ Every Palantir + Salesforce feature, decomposed to planes ([`00`](../00-ARCHITEC
 
 | Slice | File | Features | built | partial | designed | planned |
 |---|---|--:|--:|--:|--:|--:|
-| Foundry — Data/Pipelines/Modeling | [palantir-foundry-data](./palantir-foundry-data.md) | 40 | 13 | 8 | 14 | 5 |
-| Foundry — Ontology/Analytics/Apps | [palantir-foundry-semantic](./palantir-foundry-semantic.md) | 61 | 15 | 20 | 25 | 1 |
-| Foundry — Security/Governance/Cross | [palantir-foundry-governance](./palantir-foundry-governance.md) | 42 | 8 | 13 | 19 | 0 |
-| Gotham | [palantir-gotham](./palantir-gotham.md) | 57 | 14 | 18 | 20 | 5 |
+| Foundry — Data/Pipelines/Modeling | [palantir-foundry-data](./palantir-foundry-data.md) | 40 | 13 | 10 | 12 | 5 |
+| Foundry — Ontology/Analytics/Apps | [palantir-foundry-semantic](./palantir-foundry-semantic.md) | 61 | 15 | 21 | 24 | 1 |
+| Foundry — Security/Governance/Cross | [palantir-foundry-governance](./palantir-foundry-governance.md) | 42 | 8 | 18 | 14 | 0 |
+| Gotham | [palantir-gotham](./palantir-gotham.md) | 57 | 14 | 20 | 18 | 5 |
 | AIP + Apollo | [palantir-aip-apollo](./palantir-aip-apollo.md) | 29 | 1 | 13 | 9 | 6 |
-| **Palantir subtotal** | | **229** | **51** | **72** | **87** | **17** |
+| **Palantir subtotal** | | **229** | **51** | **82** | **77** | **17** |
 | SF Platform — Data + UI | [salesforce-platform-data-ui](./salesforce-platform-data-ui.md) | 52 | 16 | 14 | 22 | 0 |
 | SF Platform — Automation/Security/DevOps | [salesforce-platform-automation-security-devops](./salesforce-platform-automation-security-devops.md) | 47 | 6 | 13 | 24 | 4 |
 | SF Sales + Service/Field | [salesforce-sales-service](./salesforce-sales-service.md) | 67 | 18 | 17 | 19 | 13 |
@@ -21,9 +21,9 @@ Every Palantir + Salesforce feature, decomposed to planes ([`00`](../00-ARCHITEC
 | SF Data Cloud + Analytics + AI | [salesforce-data-analytics-ai](./salesforce-data-analytics-ai.md) | 58 | 10 | 20 | 25 | 3 |
 | SF Integration/Collab/Trust/Experience | [salesforce-integration-collab-trust-experience](./salesforce-integration-collab-trust-experience.md) | 45 | 7 | 13 | 24 | 1 |
 | **Salesforce subtotal** | | **326** | **61** | **98** | **139** | **28** |
-| **TOTAL** | | **555** | **112** | **170** | **226** | **45** |
+| **TOTAL** | | **555** | **112** | **180** | **216** | **45** |
 
-**Read:** ~20% built, ~31% partial, ~41% designed, ~8% planned. **Over half (51%) of all Palantir+Salesforce features already have a spine primitive** — because most features reduce to {objects, links, actions, identity-resolution, streaming, audit}, which exist in `planetar-ontology` / `planetar-broker` / `doibio`. The work is breadth and governance, not a from-scratch core.
+**Read:** ~20% built, ~32% partial, ~39% designed, ~8% planned. (Governance rows restamped 2026-10-06; every other row is as of 2026-06-09.) **Over half (51%) of all Palantir+Salesforce features already have a spine primitive** — because most features reduce to {objects, links, actions, identity-resolution, streaming, audit}, which exist in `planetar-ontology` / `planetar-broker` / `doibio`. The work is breadth and governance, not a from-scratch core.
 
 ## The ten cross-cutting gaps (ranked by how many slices they block)
 
@@ -31,7 +31,7 @@ These recur across nearly every matrix. They — not the per-feature long tail 
 
 | # | Gap | Blocks (slices) | Unblocks |
 |---|---|---|---|
-| 1 | **Marking propagation + FLS/row-level sharing** (R12 propagation + R13 OPA PEP) | all 11 | multi-tenancy, classified/compartmented, CRM sharing, purpose-based access — the hardest-to-clone moat |
+| 1 | **Marking propagation + FLS/row-level sharing** (R12 propagation + R13 OPA PEP) — *core built 2026-10-06 in the zero-service tier; open: OPA/Keycloak, the live service, per-record sharing* | all 11 | multi-tenancy, classified/compartmented, CRM sharing, purpose-based access — the hardest-to-clone moat |
 | 2 | **Manifest compiler / binder** (12 §4 — spec-only today) | foundational | the entire per-client composition thesis; nothing composes without it |
 | 3 | **Declarative Flow/automation engine** (R14 + Temporal + action-graph compiler) | ~8 | Flow/Process/Approvals/Journeys/Automate/Workshop-logic |
 | 4 | **Analytics/OLAP + report builder** (R9 clickhouse/duckdb + Superset) | ~6 | Contour/Quiver/Reports/Dashboards/CRMA/Calculated-Insights/forecasting |
diff --git a/20-PARITY-MATRIX/palantir-foundry-data.md b/20-PARITY-MATRIX/palantir-foundry-data.md
index f241163..a485b09 100644
--- a/20-PARITY-MATRIX/palantir-foundry-data.md
+++ b/20-PARITY-MATRIX/palantir-foundry-data.md
@@ -44,7 +44,7 @@ Foundry's transform layer: Code Repositories (Spark/Python), Pipeline Builder (n
 | Branching / dataset branches | Isolated dataset branch for safe iteration, merge back | P4, P0 | **R1** (copy-on-write), **R10** | Spine: scenario/branch overlay on canonical store (same mechanism as Foundry sandboxes) | designed — copy-on-write overlay specified ([`11` §2 sandboxes](../11-CAPABILITY-ROLE-MAP.md)); not implemented |
 | Data health / expectations / checks | Assert row counts, freshness, schema conformance per build | P1, P4 | **R11**, **R1**, *R9* | Spine: expectation failures as audit envelopes; OSS: dbt tests / Great Expectations | designed — audit envelope path exists; declarative expectation engine not built |
 | Pipeline lineage (transform → dataset edges) | Record which transform produced which dataset, end to end | P1 | **R12**, **R10** | **Spine: lineage emit on every projection** + per-field `_provenance`; **OSS: Marquez/OpenLineage** as the R12 store | partial — per-field provenance built in doibio identity-resolution.ts (630 LOC) + ontology; OpenLineage/Marquez store binding designed-only |
-| Restricted views / column-level transform masking | Transform that drops/masks columns per marking | P1, P4 | **R13**, **R12**, **R1** | Spine: marking-aware projector; OSS: OPA decision at the adapter (PEP) | designed — markings + propagating security are designed-only (brief GAPS) |
+| Restricted views / column-level transform masking | Transform that drops/masks columns per marking | P1, P4 | **R13**, **R12**, **R1** | Spine: marking-aware projector; OSS: OPA decision at the adapter (PEP) | partial — row filter + field redaction built in the platform core 2026-10-06 (`planetar-platform/spine/governed.ts`, `npm run governance` 64/64); transform-level masking and the live service remain |
 | Code Repositories (git-backed transform code) | Version-controlled transform source with CI | P0 | **R10** | **OSS: git** (R10 default is git+filesystem); CI via standard runners | partial — registry is already git-vault-backed (R10); transform-specific CI repo not formalized |
 
 ---
@@ -66,7 +66,7 @@ Foundry's Ontology Manager: define object types, link types, action types, inter
 | Per-field provenance / golden master | Track which source set each field's current value | P5, P1 | **R1**, **R12** | **Spine: per-field `_provenance` in the canonical model** | built — provenance model in doibio + ontology; lineage store (Marquez R12) for cross-dataset edges designed |
 | Conflict / discrepancy surfacing | Flag and hold conflicting source values for review | P5, P8 | **R1**, *R4*, *R14* | Spine: discrepancy as a canonical type + review Action; doibio event-log captures conflicting writes | partial — discrepancy type designed in canonical model; doibio event-sourcing records conflicts, no review UI |
 | Dark-vessel kinematic re-ID (flagship modeling) | Re-identify the same vessel across gaps via kinematics | P5 | **R1**, **R8**, *R7* | **Spine: kinematic matcher** (planetar flagship, the resolution moat) | built — kinematic re-ID in `planetar-ontology`; timeseries-geo (R8) binding for tracks |
-| Object-level / row-level security (FLS, sharing) | Restrict field/row visibility per principal + marking | P1, P6 | **R13**, **R11**, **R1** | Spine: marking checks at the adapter PEP; OSS: OPA decisions (R13) | designed — markings + propagating security designed-only; doibio explicitly lacks FLS/row-level sharing (brief) |
+| Object-level / row-level security (FLS, sharing) | Restrict field/row visibility per principal + marking | P1, P6 | **R13**, **R11**, **R1** | Spine: marking checks at the adapter PEP; OSS: OPA decisions (R13) | partial — object-level visibility and FLS built in the platform core 2026-10-06 (`planetar-platform/spine/governed.ts`); per-record sharing still designed; doibio lacks both |
 | Functions / computed properties (TypeScript/derived) | Server-side derived fields and ontology functions | P6 | **R1**, **R10**, *R9* | Spine: ontology functions (registry-declared, zero-dep TS) | designed — function concept in ontology design; not in the built P1–P5 slice |
 | Object Explorer / faceted object search | Browse, filter, facet, and sort objects in a UI | P8, P6 | **R4**, **R1**, *R7*, *R2* | Spine: Object API; **OSS: opensearch** (R4) for FTS/facet; doibio has Elasticsearch search built | partial — doibio Elasticsearch `es-app` search built `~/data/dev/doibio`; not yet on opensearch behind the R4 adapter; `planetar-ui` graph/list tabs partial |
 | Time-series / Geotime properties on objects | Attach high-frequency geotemporal series to an object | P6, P4 | **R8**, **R1**, *R5* | Spine: track model on objects; **OSS: timescaledb+postgis / clickhouse** (R8) | partial — track data flows via detectors; R8 geo store binding designed; UI Timeline/Signal tabs are stubs |
@@ -82,8 +82,8 @@ Counts across all three areas (40 features total):
 | Status | Count | Notes |
 |---|---|---|
 | **built** | 13 | Streaming ingestion (broker+zmesg), 4 detectors, CSV import, dataset-as-immutable-transaction, schema registry slice, streaming-transform pattern, incremental replay, object types, link types, Action Types, Object API/OSDK, schema versioning slice, identity resolution, per-field provenance, dark-vessel re-ID — all backed by named repos (`planetar-broker`, `zmesg`, `planetar-ontology`, `planetar-registry`, doibio). *(Several rows are jointly "built" mechanisms; the headline 13 are the cleanly-backed ones.)* |
-| **partial** | 8 | Source/connection registry, webhook connector, pipeline lineage, Code Repositories (git), object sets, conflict surfacing, Object Explorer search (doibio ES), time-series object properties — a named repo does part, the rest is designed |
-| **designed** | 14 | Batch/JDBC/file connectors, federated tables, connection health, batch transform engine, build scheduling, branching, data-health checks, restricted views, interfaces, functions, object/row-level security, media references, ontology scenarios — specified in spine docs, no code |
+| **partial** | 10 | Source/connection registry, webhook connector, pipeline lineage, Code Repositories (git), object sets, conflict surfacing, Object Explorer search (doibio ES), time-series object properties — a named repo does part, the rest is designed |
+| **designed** | 12 | Batch/JDBC/file connectors, federated tables, connection health, batch transform engine, build scheduling, branching, data-health checks, interfaces, functions, object/row-level security, media references, ontology scenarios — specified in spine docs, no code |
 | **planned** | 5 | RF connector lane, agent-based on-prem connector runtime, no-code Pipeline Builder GUI, (acknowledged but unspecified) |
 
 The modeling area is the strongest (most "built"); pipelines is the weakest (no GUI, no batch engine wired); data-connection sits in the middle (the streaming/detector edge is built, connector breadth is OSS-deferred).
diff --git a/20-PARITY-MATRIX/palantir-foundry-governance.md b/20-PARITY-MATRIX/palantir-foundry-governance.md
index 80436f4..b567603 100644
--- a/20-PARITY-MATRIX/palantir-foundry-governance.md
+++ b/20-PARITY-MATRIX/palantir-foundry-governance.md
@@ -12,12 +12,12 @@ Every governance feature decomposes (honestly) into `{R1, R10}` plus a specialty
 
 | Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
 |---|---|---|---|---|---|
-| Markings (classification labels) | Tag datasets/objects/columns with security markings that gate visibility | P1 | **R13**, **R10**, *R12* | **spine** (marking model + adapter-as-PEP); OSS: **OPA** for the decision, **Keycloak** for principal/group membership | designed — marking model specified in `00 §3` (principle 4) and `10` R12/R13; schema has `provenance` but **no marking column** yet (`planetar-ontology/src/store/schema.sql`) |
-| Propagating security (marking flows along lineage) | A marking applied upstream auto-applies to every derived dataset/object | P1 | **R12**, **R13**, **R11** | **spine** (propagation rules over the lineage graph — the moat); OSS: **Marquez** (lineage store), **OPA** (eval) | designed — explicitly flagged "next/roadmap" in `10` R12; propagation rules not implemented |
-| Mandatory (need-to-know) markings | Conjunctive markings: principal must hold *all* required marks | P1 | **R13**, **R10** | spine: marking-set intersection in the PEP; OSS: **OPA** policy bundle | designed — OPA Rego pattern specified; no enforced bundle yet |
+| Markings (classification labels) | Tag datasets/objects/columns with security markings that gate visibility | P1 | **R13**, **R10**, *R12* | **spine** (marking model + adapter-as-PEP); OSS: **OPA** for the decision, **Keycloak** for principal/group membership | partial — **built in the platform core 2026-10-06**: markings on entities, observations, envelopes and index rows; one visibility rule (`planetar-platform/spine/governance.ts` `MarkingPolicy`) enforced on every storage role by the gate (`spine/governed.ts`); `npm run governance` 64/64. Not in the live service (`planetar-ontology/src/store/schema.sql` has no marking column) and not on the `zmesg` wire |
+| Propagating security (marking flows along lineage) | A marking applied upstream auto-applies to every derived dataset/object | P1 | **R12**, **R13**, **R11** | **spine** (propagation rules over the lineage graph — the moat); OSS: **Marquez** (lineage store), **OPA** (eval) | partial — **built in the platform core 2026-10-06**: a marking applied at a source is persisted in lineage (`applyMarking` / `effectiveMarkings`, `adapters/fs/lineage.ts`), stamped on existing derivations and inherited by later ones in either write order, index copies included (`spine/system.ts`). Marquez adapter and the live service remain |
+| Mandatory (need-to-know) markings | Conjunctive markings: principal must hold *all* required marks | P1 | **R13**, **R10** | spine: marking-set intersection in the PEP; OSS: **OPA** policy bundle | partial — the conjunctive rule is built and fixed in the spine (`MarkingPolicy.visible`: the principal must hold every marking) and applied in-engine by the sqlite index and OLAP adapters (`enforcesMarkings`). No OPA bundle bound |
 | Organization / namespace markings | Org-scoped data isolation (multi-org boundary) | P1,P0 | **R13**, **R10**, *R1* | spine: org dimension on canonical id; OSS: **Keycloak** orgs/realms | designed — multi-tenancy hardening listed as a GAP |
 | Purpose-based access (CBAC) | Access granted for a declared *purpose*, logged and time-boxed | P1,P7 | **R13**, **R11**, **R10** | spine: purpose param on Action Type + governance gate (lifecycle `00 §4.2`); OSS: **OPA** | designed — kinetic gate exists (`planetar-ontology/src/actions/executor.ts` precondition+effect+audit), purpose dimension not yet a policy input |
-| Restricted views / row-column security | Filter rows / mask columns per principal marking at query time | P1,P4,P6 | **R13**, **R1**, *R4* | spine: PEP wraps `CanonicalStore`/`ObjectIndex` reads; OSS: **OPA** filter compilation, **opensearch** doc-level security | designed — adapters are declared PEPs (`12 §1` `marking: MarkingResolver`); enforcement not wired |
+| Restricted views / row-column security | Filter rows / mask columns per principal marking at query time | P1,P4,P6 | **R13**, **R1**, *R4* | spine: PEP wraps `CanonicalStore`/`ObjectIndex` reads; OSS: **OPA** filter compilation, **opensearch** doc-level security | partial — **built in the platform core 2026-10-06**: `platform.as(principal)` returns governed ports for all 14 roles (row filter + field redaction; counts only from engines that filter in-engine); adversarial suite `spine/governance-conformance.ts`. OPA filter compilation and opensearch doc-level security not bound |
 | Marking inheritance on derived/exported artifacts | Downstream files, reports, exports carry the most-restrictive upstream mark | P1 | **R12**, **R6**, **R11** | spine: propagation rule extends to blob handles + exports; OSS: **Marquez**, **minio** object tags | designed |
 
 ---
@@ -39,7 +39,7 @@ Every governance feature decomposes (honestly) into `{R1, R10}` plus a specialty
 
 | Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
 |---|---|---|---|---|---|
-| Comprehensive audit log (reads/writes/admin) | Immutable record of every read, write, export, admin + AI action | P1 | **R11** | spine: audit envelope on R3; OSS: **ClickHouse** / **Kafka** sink for scale | partial — **write/action** audit built (every Action Type emits a `core:Event`, `planetar-ontology/src/actions/executor.ts` step 5; doibio append-only `src/lib/event-log.ts`); **read** auditing designed-only |
+| Comprehensive audit log (reads/writes/admin) | Immutable record of every read, write, export, admin + AI action | P1 | **R11** | spine: audit envelope on R3; OSS: **ClickHouse** / **Kafka** sink for scale | partial — **write/action** audit built (every Action Type emits a `core:Event`, `planetar-ontology/src/actions/executor.ts` step 5; doibio append-only `src/lib/event-log.ts`); **read** auditing built in the platform core 2026-10-06 (one record per governed call, itself marked so a reader cannot see what was withheld from it — `planetar-platform/spine/governed.ts`); not in the live service |
 | Audit-as-event (writes are evented) | A write *is* an envelope on the bus, so it's auditable by construction | P1,P7,P3 | **R11**, **R3**, **R1** | **spine** (kinetic = single write path; lifecycle `00 §4.2`) | **built** — `planetar-ontology/src/actions/executor.ts` (precondition→effect→`core:Event`); `planetar-broker` WAL is the durable audit substrate |
 | Immutable / tamper-evident audit | Append-only, never rebuilt, exportable as evidence | P1 | **R11** | spine: append-WAL (broker-style); OSS: **ClickHouse** (queryable), **Kafka** (SIEM stream) | **built** (file-level) — `planetar-broker` WAL+CRC32; doibio `event-log.ts` append-only markdown event files (status `pending|applied|failed`) |
 | SIEM export / streaming | Stream audit to a client's external SIEM | P1 | **R11** | OSS: **Kafka** connector / **ClickHouse** export | designed — sink abstraction noted in `13` (`audit: { export: none }`) |
@@ -56,7 +56,7 @@ Every governance feature decomposes (honestly) into `{R1, R10}` plus a specialty
 | RBAC (roles / groups / spaces) | Role- and group-scoped access to projects/spaces | P1 | **R13**, **R10** | spine: role binding in registry; OSS: **Keycloak** groups + **OPA** | partial — coarse single-`role` RBAC in doibio `src/lib/auth.ts`; spaces/groups designed |
 | SSO / SAML / OIDC / SCIM provisioning | Federated login + automated user provisioning | P1,P0 | **R13** | OSS: **Keycloak** (identity broker, SCIM) | designed — Keycloak named default in `10` R13; no adapter wired |
 | Authorization decision (PDP/PEP) | "Can principal do action on resource under marking?" | P1 | **R13** | spine: adapters are PEPs (`12 §1`); OSS: **OPA** is the PDP | partial — kinetic preconditions act as a coarse PDP (`executor.ts`); OPA externalized decision designed |
-| Field-level security (FLS) | Hide/mask specific fields per principal | P1,P6 | **R13**, **R1** | spine: PEP masks on Object API read; OSS: **OPA** field policy | designed — **explicit GAP** (doibio has *no* FLS — confirmed `src/lib/auth.ts`) |
+| Field-level security (FLS) | Hide/mask specific fields per principal | P1,P6 | **R13**, **R1** | spine: PEP masks on Object API read; OSS: **OPA** field policy | partial — **built in the platform core 2026-10-06**: field map in the client manifest (`governance.fls`); redaction on every governed read; protected fields kept out of shared projections (`indexDocFor`); filter / sort / aggregate on a protected field refused (`spine/governed.ts`). Limitation: a protected field is searchable by nobody. Not in the live service (doibio has *no* FLS — `src/lib/auth.ts`) |
 | Row-level / record sharing | Grant access to individual records beyond role defaults | P1 | **R13**, **R1** | spine: sharing table + PEP filter; OSS: **OPA** | designed — **explicit GAP** (doibio has no row-level sharing) |
 | Two-factor / step-up auth | MFA, step-up for sensitive actions | P1 | **R13** | OSS: **Keycloak** (MFA flows) | designed |
 | Token-scoped service access (OSDK tokens) | Scoped tokens for programmatic Object API access | P1,P6 | **R13**, **R2** | spine: token check at Object API; OSS: **Keycloak** client credentials; cache in **redis** (R2) | partial — Object API exists (`planetar-ontology/src/api/server.ts`, `ws.ts`); scoped-token issuance designed |
@@ -120,8 +120,8 @@ Counts are over the **42** governance / cross-cutting features in this slice.
 | Status | Count | What it means here |
 |---|---|---|
 | **built** | 8 | A named repo demonstrably does it (per-field provenance, discrepancy provenance, audit-as-event, immutable WAL audit, versioned types, atomic transactions, Ontology Manager type defs, metadata-driven schema). Backing: `planetar-ontology`, `planetar-registry`, `planetar-broker`, `doibio`. |
-| **partial** | 13 | Spine primitive exists but the governance breadth is incomplete (lineage edges without Marquez DAG, write-audit without read-audit, coarse single-`role` RBAC, branching on git-registry without COW data, encryption-in-transit via CRC32 only, etc.). |
-| **designed** | 19 | Specified in the spine docs (marking model, propagating security, OPA/Keycloak adapters, FLS, row sharing, retention, manifest compiler) but not implemented. |
+| **partial** | 18 | Spine primitive exists but the governance breadth is incomplete (lineage edges without Marquez DAG, write-audit without read-audit, coarse single-`role` RBAC, branching on git-registry without COW data, encryption-in-transit via CRC32 only, etc.). |
+| **designed** | 14 | Specified in the spine docs (OPA/Keycloak adapters, row sharing, retention, manifest compiler) but not implemented. |
 | **planned** | 0 | (Everything in this slice is at least designed.) |
 
 Spine-owned: marking model, propagation rules, per-field provenance, audit-as-event, kinetic gate, registry/codegen, manifest compiler. OSS breadth named and actionable: **Marquez/OpenLineage** (R12), **Keycloak** + **OPA** (R13), **ClickHouse** / **Kafka** (R11 sinks), **minio** (R6 at-rest + object tags), **Vault** (secrets), **Temporal** (governed long-running review/rollout), **opensearch** (audit/restricted-view doc security).
diff --git a/20-PARITY-MATRIX/palantir-foundry-semantic.md b/20-PARITY-MATRIX/palantir-foundry-semantic.md
index 219c005..c2d5bf4 100644
--- a/20-PARITY-MATRIX/palantir-foundry-semantic.md
+++ b/20-PARITY-MATRIX/palantir-foundry-semantic.md
@@ -127,7 +127,7 @@ Status convention: `built` (a named repo does it today) · `partial` (a named re
 |---|---|---|---|---|---|
 | Comprehensive audit | Immutable record of every read/write/export/admin/AI action | P1 | **R11** | **Spine** — audit envelope on the bus; OSS: **clickhouse** sink at scale | partial — `doibio` immutable event-log audit (`src/lib/event-log.ts`); broker WAL R11; reads not yet audited |
 | Data lineage (Monocle) | Provenance graph source→dataset→object→derivation | P1 | **R12**, **R10** | **Spine** — lineage emit rules; OSS: **Marquez** (OpenLineage) | designed — per-field provenance is the seed; Marquez not bound |
-| Markings + propagating security | A marking at ingest flows to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **Spine** — propagation rules; OSS: **OPA** (decisions) + **Marquez** (lineage) | designed — designed-only (a known platform GAP); no FLS/row-level sharing in donors |
+| Markings + propagating security | A marking at ingest flows to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **Spine** — propagation rules; OSS: **OPA** (decisions) + **Marquez** (lineage) | partial — built in the platform core 2026-10-06 (`planetar-platform/spine/governed.ts` + `system.ts`, `npm run governance` 64/64); not in the live service; per-record sharing still designed |
 | Purpose-based access control | Gate access by declared analytic purpose, not just role | P1 | **R13**, **R11** | OSS: **OPA** policy; spine: PEP adapters at each plane | designed — adapter-as-PEP model specified; OPA not bound |
 
 ---
@@ -139,8 +139,8 @@ Counts are over the **61** features enumerated above (a feature counted once, by
 | Status | Count | Notes |
 |---|---|---|
 | **built** | 15 | Object/property/action types, Action executor + validation, identity resolution + per-field provenance, dark-vessel re-ID, golden record, Object API REST + WS, Object API live feed, Slate-pattern React apps, AI chat (Cohere donor), CSV export, webhooks — all backed by `planetar-ontology` and/or `doibio`. |
-| **partial** | 20 | Link types, Object Sets, Ontology Manager, OSDK codegen, Object Explorer/views, global search, graph exploration, conflict handling, multi-source fusion, time-series + geo analytics, charting, SQL transforms, Workshop/widgets/action-forms, map app, AI observability, comprehensive audit, Automate — a named repo does part; the OSS specialty role or builder UI is unbound. |
-| **designed** | 25 | Interfaces, Functions runtime, scenarios/branching, marketplace, semantic/vector search, Contour, code transforms, Quiver, calculated metrics, federation, dashboard builder, scheduled reports/jobs, embedded analytics, Object Views config, app publishing/sharing, all of AIP Logic/Agents/RAG/tool-use, approvals, orchestration, lineage, markings, purpose-based access. |
+| **partial** | 21 | Link types, Object Sets, Ontology Manager, OSDK codegen, Object Explorer/views, global search, graph exploration, conflict handling, multi-source fusion, time-series + geo analytics, charting, SQL transforms, Workshop/widgets/action-forms, map app, AI observability, comprehensive audit, Automate — a named repo does part; the OSS specialty role or builder UI is unbound. |
+| **designed** | 24 | Interfaces, Functions runtime, scenarios/branching, marketplace, semantic/vector search, Contour, code transforms, Quiver, calculated metrics, federation, dashboard builder, scheduled reports/jobs, embedded analytics, Object Views config, app publishing/sharing, all of AIP Logic/Agents/RAG/tool-use, approvals, orchestration, lineage, markings, purpose-based access. |
 | **planned** | 1 | Notebook hosting (no donor). |
 
 **Spine vs OSS split:** the Ontology core, Actions, identity resolution, Object API, and audit envelope are **spine** (built). The analytics engine (**clickhouse/duckdb**), search (**opensearch**), graph (**falkordb**), vector/RAG (**pgvector** + LLM gateway), BI surface (**Superset/Grafana**), lineage (**Marquez**), policy (**OPA**/**Keycloak**), and orchestration (**Temporal**) are the **OSS breadth** still to bind. Every feature decomposes onto **{R1, R10}** plus a specialty role, confirming the role-composition thesis.
diff --git a/20-PARITY-MATRIX/palantir-gotham.md b/20-PARITY-MATRIX/palantir-gotham.md
index 250f7a0..4dd8699 100644
--- a/20-PARITY-MATRIX/palantir-gotham.md
+++ b/20-PARITY-MATRIX/palantir-gotham.md
@@ -95,8 +95,8 @@ Role legend: **R1** canonical-store · **R2** hot-cache · **R3** stream · **R4
 
 | Feature | What it does (1 line) | Owning plane(s) | Required + *enhancing* roles | Spine vs OSS component | Status + backing path |
 |---|---|---|---|---|---|
-| Markings / classifications | Tag data with security markings (UNCLASS/RESTRICTED/handling caveats) | P1 | **R13**, **R10** | spine: marking model in registry; **OSS: OPA** for the decision | designed — marking model designed-only (`README.md` GAPS) |
-| Propagating security | A marking applied at ingest flows along lineage to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **spine** — propagation rules over lineage; **OSS: marquez** (R12) + **OPA** (R13) | designed — R12 lineage built/designed; *propagation* is the named roadmap gap |
+| Markings / classifications | Tag data with security markings (UNCLASS/RESTRICTED/handling caveats) | P1 | **R13**, **R10** | spine: marking model in registry; **OSS: OPA** for the decision | partial — built in the platform core 2026-10-06 (see `palantir-foundry-governance.md`, Markings); not in the live service |
+| Propagating security | A marking applied at ingest flows along lineage to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **spine** — propagation rules over lineage; **OSS: marquez** (R12) + **OPA** (R13) | partial — built in the platform core 2026-10-06: lineage-persisted markings inherited by existing and later derivations (`planetar-platform/spine/system.ts`); not in the live service |
 | Purpose-based / need-to-know access | Gate access by declared purpose, not just role (PBAC) | P1, P7 | **R13**, **R11** | **OSS: OPA** policy bundle behind `policy-identity`; spine: adapters are the PEP | designed — OPA gate specified in adapter context (`MarkingResolver`); not enforced yet |
 | Comprehensive audit log | Immutable record of every read/write/export/admin/AI action | P1 | **R11** | spine: audit envelope on the bus; **doibio immutable event-log** is the built donor; OSS: clickhouse sink | built — doibio immutable event-log audit (`~/data/dev/doibio`); ontology emits audit envelopes |
 | Data lineage (Monocle-equivalent) | Trace any value back to its source through every transform | P1 | **R12**, **R10** | spine: lineage emit; **OSS: marquez (OpenLineage)** behind the R12 port | partial — per-field provenance built in ontology; full marquez lineage store planned |
@@ -124,8 +124,8 @@ Total features assessed: **57**.
 | Status | Count | Where it concentrates |
 |---|---|---|
 | **built** | 14 | Spine moat: bus (R3), entity/link model + Object API (P6), identity + kinematic re-ID (P5), action executor (P7), detectors (P2), doibio audit/CSV/Elasticsearch donors |
-| **partial** | 18 | Analyst surfaces (`planetar-ui` map/graph built, signal/imagery/timeline stubbed), graph traversal (on canonical store, no R5 engine yet), object-index search (doibio ES built, opensearch planned), lineage/provenance, multi-tenancy |
-| **designed** | 20 | Graph-engine paths/patterns (R5), geofence/watchlist triggers, media/visual re-ID (R6/R7), markings + propagating security (P1), agent containment, tasking queues |
+| **partial** | 20 | Analyst surfaces (`planetar-ui` map/graph built, signal/imagery/timeline stubbed), graph traversal (on canonical store, no R5 engine yet), object-index search (doibio ES built, opensearch planned), lineage/provenance, multi-tenancy |
+| **designed** | 18 | Graph-engine paths/patterns (R5), geofence/watchlist triggers, media/visual re-ID (R6/R7), agent containment, tasking queues |
 | **planned** | 5 | FMV exploitation, long-running orchestration (Temporal), row-level sharing/FLS, scenarios/branching, BI export |
 
 (One row — live/streaming UI updates — is labelled `built/partial` and counted under **partial** above.)
diff --git a/90-ROADMAP.md b/90-ROADMAP.md
index 41541e6..da49b1d 100644
--- a/90-ROADMAP.md
+++ b/90-ROADMAP.md
@@ -63,6 +63,8 @@ The #1 blocker across all 11 slices, and the hardest-to-clone differentiator. Do
 
 > **PROGRESS (2026-06-10):** the propagating-security **core is built and runs** — `npm run governance` → **8/8**. [`spine/governance.ts`](./spine/governance.ts) ships `MarkingPolicy` (a real PEP: no-read-up mandatory access control + per-field FLS redaction), `Session` (per-principal governed reads — row filter + field redaction over the canonical store), and `propagate()` (stamps a marking down the lineage closure). [`boot/governance.ts`](./boot/governance.ts) demonstrates the moat end-to-end: a restriction defined **once at a source** propagates along lineage to a derived entity, after which a low-clearance principal can no longer see that row while a high-clearance principal still can, and an FLS field stays redacted for the low principal throughout — all audited. Markings now ride `CanonicalEntity`/`Observation` ([`spine/model.ts`](./spine/model.ts)). Remaining P3: swap the in-process policy for **Keycloak (authn/SSO/SCIM) + OPA (Rego PDP)** behind the same `PolicyIdentity`/`MarkingResolver` ports (needs those services); enforce the PEP inside every adapter (not just the read `Session`); read-auditing breadth + SIEM export.
 
+> **PROGRESS (2026-10-06):** enforcement moved from one helper class to **a gate over every role** — `npm run governance` → **64/64** (adversarial suite, [`spine/governance-conformance.ts`](./spine/governance-conformance.ts)). `BoundPlatform.role()` is gone: callers take `platform.as(principal)` ([`spine/governed.ts`](./spine/governed.ts)) or `platform.system(component)` ([`spine/system.ts`](./spine/system.ts)). Closed: search/count/graph/vector/track/stream/audit leaks, the flow engine's un-gated write, stale index copies after propagation, and derivations made after a source was marked. Design: [`docs/specs/2026-10-06-governed-ports-design.md`](./docs/specs/2026-10-06-governed-ports-design.md). Remaining P3: Keycloak + OPA behind the same ports; in-engine enforcement in the production adapters; the live `planetar-ontology` service; markings on the `zmesg` wire; SIEM export formats.
+
 ---
 
 ## Phase 4 — Automation + analytics breadth · *gaps #3,#4*
diff --git a/91-HANDOFF.md b/91-HANDOFF.md
index 05b3630..f3901aa 100644
--- a/91-HANDOFF.md
+++ b/91-HANDOFF.md
@@ -74,6 +74,8 @@ A 6-lens adversarial review of the runnable code (correctness, concurrency, **go
 6. `BrokerStream`: unhandled socket `error` on the pub path; subscribe sockets never closed by `close()`.
 7. `propagate()` re-stamps entities in R1 but **not their object-index copies** → stale searchable rows.
 
+> **Update 2026-10-06:** suspects **1, 2 and 7 are closed** by the governed-ports work ([`docs/specs/2026-10-06-governed-ports-design.md`](./docs/specs/2026-10-06-governed-ports-design.md); `npm run governance` 64/64), together with a hole this list missed: an entity derived *after* its source was marked did not inherit the marking. Four more leaks of the same family were found by review and closed in the same work: raw storage columns and unmarked tables reachable through analytics-olap, a protected value readable in an action's audit detail and event payload, engine filters usable as an oracle on graph and vector, and unmarked work-queue jobs claimable by any principal (the queue is now system-only). Also fixed, and not on this list: concurrent transactions on the sqlite canonical store failed with a nested `BEGIN` (they now queue). Suspects 3–6 are still open. The review workflow was not rerun.
+
 ## 7. The machine wedge (why the session ended)
 
 From ~16:00 on 2026-06-10, **every freshly spawned shell hung before executing** (even `uptime`), while harness file ops kept working. Began during the review fleet's verify stage but **persisted after all load was shed** → external cause; signature matches shell profile init blocking on a stale/slow mount (prime suspect `~/data`) — or session-local shell-spawn corruption, since the user later believed the machine had recovered while this session's spawns still hung. All five checks were green *before* the wedge; no code state was lost.
diff --git a/README.md b/README.md
index 3b09171..9f0bdb3 100644
--- a/README.md
+++ b/README.md
@@ -35,9 +35,9 @@ Decision (locked): **custom spine + OSS breadth.** The spine never depends on a
 | [`11-CAPABILITY-ROLE-MAP.md`](./11-CAPABILITY-ROLE-MAP.md) | How any Palantir/Salesforce capability decomposes into storage roles; worked examples | ⭐ keystone |
 | [`12-ADAPTER-CONTRACT.md`](./12-ADAPTER-CONTRACT.md) | The adapter (port) interfaces per role + a reference adapter implementation | ⭐ |
 | [`13-CLIENT-MANIFEST.md`](./13-CLIENT-MANIFEST.md) | The per-client manifest schema (assigns engines to roles) + validation + a worked example | ⭐ |
-| [`spine/`](./spine/README.md) | **Real TypeScript** of the locked contracts: `model.ts`, `ports.ts` (14 role ports), `contracts.ts` (binder), `compiler.ts`+`capabilities.ts` (manifest compiler), `conformance.ts`, `governance.ts` (PEP + lineage propagation), `kinetic.ts` (Action Types), `flows.ts` (declarative automation). Type-checks clean. | ✅ Phases 0–4 |
+| [`spine/`](./spine/README.md) | **Real TypeScript** of the locked contracts: `model.ts`, `ports.ts` (14 role ports), `contracts.ts` (binder), `compiler.ts`+`capabilities.ts` (manifest compiler), `conformance.ts`, `governance.ts` + `governed.ts` + `system.ts` (policy, the read gate over every role, and the write-side marking invariants), `kinetic.ts` (Action Types), `flows.ts` (declarative automation). Type-checks clean. | ✅ Phases 0–4 |
 | [`adapters/`](./adapters/) | 15 runnable zero-service adapters (sqlite ×6, file ×2, fs ×3, memory, git-fs, internal, broker-over-node:net) registered into the binder; all 14 conformant | ✅ Phase 1 + 2 |
-| [`boot/`](./boot/README.md) | Runnable proofs: `boot:edge` (9/9), `boot:enterprise` (13/13), `conformance` (14/14), `governance` (8/8), `automation` (8/8) | ✅ runnable proof |
+| [`boot/`](./boot/README.md) | Runnable proofs: `boot:edge` (9/9), `boot:enterprise` (13/13), `conformance` (14/14), `governance` (64/64), `automation` (8/8) | ✅ runnable proof |
 | [`20-PARITY-MATRIX/`](./20-PARITY-MATRIX/README.md) | Palantir + Salesforce feature parity: 555 features → spine/OSS component → storage roles → status | ✅ 11 slices + scorecard |
 | [`30-CLIENTS/`](./30-CLIENTS/README.md) | The 4 reference client architectures, each a full manifest + topology + sample code | ✅ 4 clients |
 | [`40-ADAPTERS/`](./40-ADAPTERS/README.md) | Per-engine adapter sample code (redis, sqlite, postgres, mysql, kafka, spanner, …) | ✅ 9 adapter sets |
@@ -47,7 +47,7 @@ Decision (locked): **custom spine + OSS breadth.** The spine never depends on a
 
 ## Parity at a glance
 
-555 Palantir + Salesforce features cataloged → **112 built (~20%) · 170 partial (~31%) · 226 designed (~41%) · 45 planned (~8%)**. Over half already have a spine primitive. Full scorecard + the ten cross-cutting gaps: [`20-PARITY-MATRIX/README.md`](./20-PARITY-MATRIX/README.md). Build sequence: [`90-ROADMAP.md`](./90-ROADMAP.md).
+555 Palantir + Salesforce features cataloged → **112 built (~20%) · 180 partial (~32%) · 216 designed (~39%) · 45 planned (~8%)**. Over half already have a spine primitive. Full scorecard + the ten cross-cutting gaps: [`20-PARITY-MATRIX/README.md`](./20-PARITY-MATRIX/README.md). Build sequence: [`90-ROADMAP.md`](./90-ROADMAP.md).
 
 ---
 
diff --git a/boot/README.md b/boot/README.md
index 41bdb40..e512f23 100644
--- a/boot/README.md
+++ b/boot/README.md
@@ -6,7 +6,7 @@
 npm run boot:edge          # client 1: maritime/defence edge  → 9/9 checks
 npm run boot:enterprise    # client 2: generic enterprise CRM → 13/13 checks
 npm run conformance        # one suite, every adapter         → 14/14 conformant
-npm run governance         # Phase 3: propagating security    → 8/8 checks
+npm run governance         # Phase 3: governed ports          → 64/64 checks
 npm run automation         # Phase 4: declarative flows       → 8/8 checks
 ```
 
@@ -19,14 +19,16 @@ npm run automation         # Phase 4: declarative flows       → 8/8 checks
 - The approval step parks a **durable work item** (R14) an omni-channel console can claim; an analyst without the `supervisor` role is denied (and audited); the supervisor's approval runs `planetar:ConfirmDarkVessel` **as the approver**.
 - Re-flagging a suspect vessel is rejected by the kinetic precondition guard; the audit trail shows the whole chain (flow writes, supervisor write, denied attempt).
 
-## Propagating security ([`governance.ts`](./governance.ts), Phase 3)
+## Governed ports ([`governance.ts`](./governance.ts), Phase 3)
 
-`npm run governance` proves the hardest-to-clone part of the moat: **security defined once at a source propagates along lineage**, and two principals get different governed views of the *same* store.
+`npm run governance` runs the adversarial suite ([`spine/governance-conformance.ts`](../spine/governance-conformance.ts)): it binds every data role, plants public, restricted and derived entities, and attacks each role as a principal cleared only for `UNCLASS`. The client passes when that principal can never observe the restricted rows. It runs twice: against a client with every data role bound, and against one that binds only the five roles kinetic writes need.
 
-- **FLS redaction** — a low-clearance principal sees vessel *Alpha* but its `owner` field is redacted; a high-clearance principal sees `owner`.
-- **Propagation** — vessel *Bravo* (initially UNCLASS) derives from a classified feed; applying `OPS-RESTRICTED` **once at the source** flows along the lineage closure and re-stamps *Bravo*.
-- **Restricted view** — after propagation, the low principal can no longer see *Bravo* (row-level filter); the high principal still can.
-- **Governed lists + audit** — `low.listEntities` returns 1 row (owner redacted), `high.listEntities` returns 2; the propagation is captured as an immutable audit record.
+- **One gate** — callers take `platform.as(principal)` (filtered reads, no data writes) or `platform.system(component)` (spine internals, seeding). There is no raw `role()`.
+- **No leak, per role** — ids, counts, graph neighbours and paths, nearest neighbours, tracks, stream envelopes, audit records and lineage edges of a restricted row are withheld; a high-clearance principal sees all of them.
+- **Inheritance that holds over time** — a marking applied **once at a source** restricts what was already derived from it and what is derived later, in either write order; markings never shrink.
+- **Writes** — entities are created and changed only through the action gate; a restricted target looks like a missing one.
+- **Field-level security** — the field map lives in the manifest (`governance.fls`); a protected field is redacted, is kept out of shared projections, and cannot be used to filter, sort or aggregate.
+- **Structure** — every port method is classified governed / open / system, and the suite fails if one is not.
 
 The policy engine is in-process ([`MarkingPolicy`](../spine/governance.ts)); the **production swap is Keycloak (authn) + OPA (Rego PDP)** behind the same `PolicyIdentity` / `MarkingResolver` ports — no spine change.
 
@@ -97,4 +99,4 @@ flowchart LR
 - The edge `stream` binds the **`file`** engine (durable WAL file, zero-service). The real **`broker`** adapter (TCP, BE-length / LE-zmesg framing) is now **written and codec-verified** in [`../adapters/broker/stream.ts`](../adapters/broker/stream.ts); a live end-to-end run needs the broker process (which this session does not own), so the boots use `file`.
 - **Markings can't ride the current zmesg header** — `zmesg.h` v1 has no markings field (only a `flags` byte). The `file` engine preserves markings (JSON); the `broker` codec drops them. So governance markings need a zmesg v2 field (or must travel inside the canonical payload). This is the concrete answer to the Phase 0 "verify markings placement" item.
 - Production engines (postgres multiplex, redis, opensearch, falkordb, minio, kafka, spanner, clickhouse, qdrant, pgvector) remain **sample code** in [`../40-ADAPTERS/`](../40-ADAPTERS/); the runnable repo stays zero-dependency. The zero-service engines (sqlite/file/fs/memory/broker-over-node:net) prove the mechanism; production engines drop in behind the same ports once a deploy provides the services + drivers.
-- Governance is edge-permissive (`PERMISSIVE_MARKING` + `internal` policy). Real propagating-security (Keycloak+OPA, marking propagation enforced at every PEP) is Phase 3.
+- Governance decisions are made in-process (`MarkingPolicy` + the `internal` policy engine) and enforced on every role by the gate. Binding Keycloak + OPA behind the same ports is still open.
diff --git a/docs/specs/2026-10-06-governed-ports-design.md b/docs/specs/2026-10-06-governed-ports-design.md
index 2cd9683..59b4c74 100644
--- a/docs/specs/2026-10-06-governed-ports-design.md
+++ b/docs/specs/2026-10-06-governed-ports-design.md
@@ -99,7 +99,7 @@ class BoundPlatform {
 - The adapters are held in a `#private` field. There is no public `role()`.
 - `GovernedPlatform.role(r)` returns a port that exposes only the methods marked *governed* or
   *open* in §4.3. `Session` is deleted; `platform.as(p).role('canonical-store')` replaces it.
-- `SystemPlatform.role(r)` returns the raw adapter, with three wrapped methods that uphold I1 and
+- `SystemPlatform.role(r)` returns the raw adapter, with five wrapped methods that uphold I1 and
   I2 for every in-process writer (§4.6). Each `system('…')` call names its component, and the
   suite checks the set of call sites in `spine/` against an allow-list.
 - This is protection against accidental bypass and the seam a network API will sit behind. It is
@@ -125,7 +125,7 @@ class BoundPlatform {
 | audit-log | `scan`, `export` | | `append` |
 | lineage | `upstreamOf`, `downstreamOf` | | `record`, `propagateMarking`, `applyMarking` (new), `effectiveMarkings` (new) |
 | policy-identity | | `authenticate`, `authorize`, `members` | |
-| work-queue | | `claim`, `complete`, `fail` | `enqueue` |
+| work-queue | | | `enqueue`, `claim`, `complete`, `fail` |
 
 The table is a typed constant, `GOVERNANCE_RULES`. The suite fails if any method found on a bound
 adapter is missing from it, so a new port method cannot ship unclassified.
@@ -140,13 +140,17 @@ How each governed method filters:
   `facets` and `total` are returned only from an enforcing adapter. `aggregate`: enforcing
   adapter only, otherwise `GovernanceError`.
 - **graph** — `neighbors` and `shortestPath` are computed by the facade as a breadth-first walk
-  of one-hop expansions that never steps onto or through a node the principal cannot see.
+  of one-hop expansions that never steps onto or through a node the principal cannot see. A
+  traversal filter that names a protected field is refused.
 - **vector** — `knn` over-fetches and drops ids that are not visible until `k` remain or the
-  store is exhausted.
+  store is exhausted. An engine filter that names a protected field, as a key or as a value at
+  any depth, is refused.
 - **timeseries-geo** — `range`, `downsample`: empty unless the entity is visible. `within`:
   drops points of entities that are not visible.
-- **analytics-olap** — enforcing adapter only; rejects a dimension, measure or `where` on a field
-  the principal cannot see.
+- **analytics-olap** — enforcing adapter only. For a principal, `from` is a canonical type and
+  every dimension, measure and `where` names a logical field of it; the engine can reach no
+  storage column and no other table. A field the principal cannot see is rejected, and so is a
+  federated table reference.
 - **stream** — withholds envelopes whose `markings` the principal does not hold.
 - **audit-log** — withholds records whose `markings` the principal does not hold.
 - **lineage** — drops edges that touch an entity the principal cannot see or carry markings it
@@ -161,7 +165,8 @@ New capability flag `AdapterCapabilities.enforcesMarkings`. An adapter that sets
 1. persist markings with every row it stores;
 2. accept `principal` on its query object (`SearchQuery` has it; add it to `AggQuery` and
    `OlapQuery`) and, when present, select and aggregate only rows whose markings the principal
-   holds, using the rule of §4.1 exactly;
+   holds, using the rule of §4.1 exactly — and resolve every name in that query as a logical
+   field of a canonical type, never as a storage column or another table;
 3. implement `setMarkings(type, id, markings)`.
 
 In this change: `sqlite` object-index and `sqlite` analytics-olap become enforcing. No other
@@ -178,7 +183,9 @@ adapter needs it, because the facade handles their roles row by row.
 - `KineticExecutor.invoke` loads its target through the governed read as the invoking principal.
   A target the principal cannot see produces the same result as a missing one. The returned
   entity is redacted for that principal, and a failed precondition on a field the principal
-  cannot see reports the field and operator only.
+  cannot see reports the field and operator only. When an action writes a protected field, its
+  audit record and its event carry that field's marking as well as the target's, because both
+  hold the written value.
 
 ### 4.6 Propagation that holds over time
 
@@ -188,16 +195,19 @@ adapter needs it, because the facade handles their roles row by row.
 - **`propagate(platform, ref, markings, actor)`** applies the marking, stamps every downstream
   entity, calls `setMarkings` on every bound enforcing projection, and writes one audit record.
   (Today the demo writes that audit record by hand.)
-- **System-handle wrappers.** Three methods are wrapped; everything else on the system handle is
+- **System-handle wrappers.** Five methods are wrapped; everything else on the system handle is
   the raw adapter.
   - `canonical-store.upsertEntity` stores `given ∪ existing ∪ effectiveMarkings(entity ref)` and
     restamps enforcing projections when the set grew.
-  - `lineage.record` stamps the downstream entity, if it exists, with
-    `effectiveMarkings(upstream)`.
+  - `lineage.record` stamps every existing entity at or below the new edge with the markings it
+    now inherits.
+  - `lineage.applyMarking` and `lineage.propagateMarking` stamp every entity at or below the ref,
+    so marking a ref through the raw lineage port cannot leave entity rows behind.
   - `object-index.index` stores `doc.markings ∪ markingsOf(id)`, so a projector cannot index a
     copy with fewer markings than the canonical row.
 
-  The first two hold I1 for both orders: edge first then entity, or entity first then edge. When
+  The first three hold I1 for every order: edge first, entity first, or a chain recorded
+  bottom-up. When
   no lineage role is bound there is nothing to inherit and the wrappers only enforce I2.
 
 ### 4.7 Field-level security
@@ -282,13 +292,19 @@ must stay green. `typecheck` must pass under `tsc --strict`, which first needs T
 
 - A protected field cannot be searched, filtered or aggregated by anyone, including cleared
   principals.
+- Field-level security covers entity fields. Stream envelope payloads and track-point fields are
+  governed by row markings only: whoever may see the envelope or the entity sees all of it.
 - A blob is readable by whoever holds its handle. Hiding the field that carries the handle is the
   only control.
-- Work-queue payloads carry no markings. Approval prompts must not embed restricted values.
+- The work queue is not available to principals. Jobs carry no markings, so a claim could hand a
+  restricted payload to anyone; until they do, only spine components and operators holding the
+  system handle claim, complete or fail jobs.
 - Registry content (schemas, flows, action definitions) is readable by every principal.
 - Aggregates are unavailable on an engine that does not enforce in-engine.
 - The facade's graph walk and row re-checks cost one canonical lookup per batch of ids; fine for
   the zero-service tier, to be replaced by in-engine enforcement on production engines.
+- The sqlite canonical store has one connection: transactions queue, but a plain write that lands
+  while another caller's transaction is open is rolled back with it if that transaction fails.
 - No information-flow control beyond inheritance at creation: an action that copies a value from
   a restricted entity into a public one is not detected.
 
diff --git a/spine/README.md b/spine/README.md
index 71ece04..e669ec0 100644
--- a/spine/README.md
+++ b/spine/README.md
@@ -13,7 +13,7 @@ This directory is **Phase 0 of [`../90-ROADMAP.md`](../90-ROADMAP.md)**: the aut
 - **Spine code imports only `ports.ts` + `model.ts`.** Never an engine driver. (Adapters in `40-ADAPTERS/` import the ports and implement them.)
 - **A binding is checkable.** `satisfies(role, adapter.capabilities)` is a pure function; the manifest compiler (Phase 1) calls it per role, so an under-provisioned client is a *compile error*, not a runtime incident.
 - **Federated/external engines are first-class.** `AdapterCapabilities.external` lets R9 bind BigQuery/Snowflake query-in-place without claiming rebuildable-from-stream.
-- **Governance is woven in, not bolted on.** Every `AdapterContext` carries a `MarkingResolver`; adapters are Policy Enforcement Points. The `Lineage.propagateMarking` method is the seam for the roadmap's clone-resistant propagating-security (Phase 3).
+- **Governance is woven in, not bolted on.** `BoundPlatform` keeps its adapters private: a caller takes `platform.as(principal)` (governed ports, [`governed.ts`](./governed.ts)) or `platform.system(component)` (raw ports with the marking invariants, [`system.ts`](./system.ts)). Every port method is classified in `GOVERNANCE_RULES` ([`governance.ts`](./governance.ts)); markings applied at a lineage ref are inherited by everything derived from it.
 
 ## Status
 
````

- [ ] **Step 2: Check the numbers and links**

Run:
```bash
grep -rn "8/8 checks\|(8/8), \`automation\`\|35/35\|58/58\|63/63" README.md boot/README.md 90-ROADMAP.md 20-PARITY-MATRIX/*.md | grep -i govern
grep -c "64/64" README.md boot/README.md 90-ROADMAP.md 91-HANDOFF.md
for f in spine/governed.ts spine/system.ts spine/governance-conformance.ts docs/specs/2026-10-06-governed-ports-design.md; do test -f "$f" && echo "ok $f"; done
for s in conformance governance automation boot:edge boot:enterprise; do npm run -s "$s" 2>&1 | grep -E "[0-9]+/[0-9]+ .*(passed|conformant)"; done
```
Expected: the first `grep` prints nothing (no stale governance count); the second prints `1` for each of the four files; four `ok` lines; then `14/14`, `64/64`, `8/8`, `9/9`, `13/13`.

- [ ] **Step 3: Commit**

```bash
git add -A '*.md' && git commit -m "governed ports: docs — what is built, with backing paths; spec corrections" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the last task

- `git log --oneline main..governed-ports` shows seven commits (docs, five code tasks, docs).
- Not done by this plan, by design: nothing is pushed, nothing is merged to `main`, and `planetar-ontology` (the live service) is untouched.
- Next, per the spec's "Not in this spec": bring the gate to `planetar-ontology`, then markings on the `zmesg` wire.
