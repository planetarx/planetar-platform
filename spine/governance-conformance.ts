// spine/governance-conformance.ts — the adversarial governance suite.
// Plants public, restricted and derived data through the system handle, then attacks every
// governed port as a low-clearance principal. A client passes when LOW can never observe the
// restricted rows — not their ids, counts, neighbours, paths, tracks, envelopes or audit trail —
// while HIGH observes all of it. Engine-agnostic: it runs against whatever the manifest bound.
// Design: docs/specs/2026-10-06-governed-ports-design.md §6.
import type { BoundPlatform } from './contracts.ts';
import type { Principal, AuditRecord, Envelope } from './ports.ts';
import type { CanonicalEntity, MarkingId } from './model.ts';
import { GovernanceError, entityRef, indexDocFor, propagate } from './governance.ts';

export interface Check { name: string; ok: boolean; info: string }

/** The fixture vocabulary. The client manifest must protect SUITE.owner with SUITE.RESTRICTED
 *  (governance.fls) or the first check fails. */
export const SUITE = {
  type: 'gov:Vessel', name: 'gov:name', owner: 'gov:owner',
  PUBLIC: 'UNCLASS', RESTRICTED: 'OPS-RESTRICTED',
  source: 'src:gov-classified', topic: 'gov.test',
} as const;

export const LOW: Principal = { id: 'gov-low', roles: ['operator'], clearances: [SUITE.PUBLIC] };
export const HIGH: Principal = { id: 'gov-high', roles: ['operator'], clearances: [SUITE.PUBLIC, SUITE.RESTRICTED] };

// ids sort as P1 < R < P2 so a withheld row sits between two visible ones (exercises page refill)
const P1 = 'gov-1-pub', R = 'gov-2-sec', P2 = 'gov-3-pub', D = 'gov-4-derived', L = 'gov-5-late', E = 'gov-6-early', B = 'gov-7-bottomup';

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const sorted = (xs: string[]) => xs.slice().sort().join(',');

function vessel(id: string, name: string, markings: MarkingId[], extra: Record<string, string> = {}): CanonicalEntity {
  return { id, type: SUITE.type, ts: nowNs(), source: 'src:gov@1.0.0', schemaVersion: 0x010000, fields: { [SUITE.name]: name, ...extra }, provenance: {}, markings };
}

async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (e) { if (e instanceof GovernanceError) return true; throw e; }
}

async function first<T>(it: AsyncIterator<T>, ms = 500): Promise<T | undefined> {
  const r = await Promise.race([it.next(), new Promise<IteratorResult<T>>((res) => setTimeout(() => res({ value: undefined, done: true }), ms))]);
  return r.done ? undefined : r.value;
}

export async function governanceSuite(platform: BoundPlatform): Promise<Check[]> {
  const checks: Check[] = [];
  const t = async (name: string, fn: () => Promise<string>) => {
    try { checks.push({ name, ok: true, info: await fn() }); } catch (e) { checks.push({ name, ok: false, info: (e as Error).message }); }
  };
  const sys = platform.system('governance-suite');
  const low = platform.as(LOW), high = platform.as(HIGH);
  const policy = platform.policy;
  const store = sys.role('canonical-store');
  const seed = async (e: CanonicalEntity) => {
    await store.upsertEntity(e);
    if (sys.has('object-index')) await sys.role('object-index').index(e.type, e.id, indexDocFor(policy, e));
    if (sys.has('graph')) await sys.role('graph').upsertNode({ id: e.id, type: e.type, markings: e.markings });
  };

  await t('fixture: the manifest protects gov:owner with OPS-RESTRICTED', async () => {
    if (policy.fieldMarking(SUITE.type, SUITE.owner) !== SUITE.RESTRICTED) throw new Error(`add governance.fls { "${SUITE.type}": { "${SUITE.owner}": "${SUITE.RESTRICTED}" } } to the manifest`);
    return 'ok';
  });

  await seed(vessel(P1, 'MV Public', [SUITE.PUBLIC], { [SUITE.owner]: 'Acme Shipping' }));
  await seed(vessel(R, 'MV Secretname', [SUITE.PUBLIC, SUITE.RESTRICTED]));
  await seed(vessel(P2, 'MV Quay', [SUITE.PUBLIC]));

  // ---------------------------------------------------------------- canonical-store
  const lowStore = low.role('canonical-store'), highStore = high.role('canonical-store');
  await t('canonical-store: a restricted row is hidden from LOW and visible to HIGH', async () => {
    if (await lowStore.getEntity(SUITE.type, R) !== null) throw new Error('LOW read the restricted row');
    if (!await highStore.getEntity(SUITE.type, R)) throw new Error('HIGH could not read it');
    if (!await lowStore.getEntity(SUITE.type, P1)) throw new Error('LOW could not read a public row');
    return 'ok';
  });
  await t('canonical-store: a protected field is redacted for LOW and present for HIGH', async () => {
    const lo = await lowStore.getEntity(SUITE.type, P1), hi = await highStore.getEntity(SUITE.type, P1);
    if (lo?.fields[SUITE.owner] !== undefined) throw new Error('owner reached LOW');
    if (hi?.fields[SUITE.owner] !== 'Acme Shipping') throw new Error('owner missing for HIGH');
    return `LOW sees name=${lo?.fields[SUITE.name]}, owner redacted`;
  });
  await t('canonical-store: lists hide restricted rows and refill pages around them', async () => {
    const pages: string[][] = []; let cursor: string | undefined;
    do {
      const page = await lowStore.listEntities(SUITE.type, { limit: 1, cursor });
      if (page.cursor && page.items.length !== 1) throw new Error(`short page (${page.items.length}) with more to come reveals a withheld row`);
      if (page.total !== undefined) throw new Error('total must not be reported');
      pages.push(page.items.map((e) => e.id)); cursor = page.cursor;
    } while (cursor);
    const ids = pages.flat();
    if (sorted(ids) !== sorted([P1, P2])) throw new Error(`LOW listed ${ids.join(',')}`);
    const hi = (await highStore.listEntities(SUITE.type, {})).items.map((e) => e.id);
    if (sorted(hi) !== sorted([P1, R, P2])) throw new Error(`HIGH listed ${hi.join(',')}`);
    return `LOW pages: ${pages.map((p) => `[${p.join(',')}]`).join(' ')}`;
  });
  await t('canonical-store: a link to a hidden entity is dropped', async () => {
    const link = (id: string, to: string) => ({ id, type: 'gov:Link', ts: nowNs(), source: 'src:gov@1.0.0', schemaVersion: 0x010000, linkType: 'gov:met', from: P1, to });
    await store.putLink(link('gov-link-1', R)); await store.putLink(link('gov-link-2', P2));
    const lo = (await lowStore.getLinks(SUITE.type, P1)).map((l) => l.to), hi = (await highStore.getLinks(SUITE.type, P1)).map((l) => l.to);
    if (sorted(lo) !== P2 || sorted(hi) !== sorted([R, P2])) throw new Error(`LOW=${lo.join(',')} HIGH=${hi.join(',')}`);
    return 'ok';
  });
  await t('canonical-store: filtering or sorting on a protected field is refused for LOW only', async () => {
    const q = { filter: [{ field: SUITE.owner, op: 'eq' as const, value: 'Acme Shipping' }] };
    if (!await refused(() => lowStore.listEntities(SUITE.type, q))) throw new Error('LOW filtered on a field it cannot see');
    if (!await refused(() => lowStore.listEntities(SUITE.type, { orderBy: [{ field: SUITE.owner, dir: 'asc' }] }))) throw new Error('LOW sorted on a field it cannot see');
    await highStore.listEntities(SUITE.type, q);
    return 'ok';
  });

  // ---------------------------------------------------------------- object-index
  if (platform.has('object-index')) {
    const lowIx = low.role('object-index'), highIx = high.role('object-index');
    await t('object-index: search never returns a restricted id to LOW', async () => {
      const lo = (await lowIx.search({ type: SUITE.type, text: 'secretname' })).hits.map((h) => h.id);
      const hi = (await highIx.search({ type: SUITE.type, text: 'secretname' })).hits.map((h) => h.id);
      if (lo.length || sorted(hi) !== R) throw new Error(`LOW=${lo.join(',')} HIGH=${hi.join(',')}`);
      return 'ok';
    });
    await t('object-index: counts exclude restricted rows for LOW', async () => {
      const count = async (p: typeof lowIx) => (await p.aggregate({ type: SUITE.type, groupBy: [], metrics: [{ fn: 'count' }] })).rows[0].metrics.count;
      if (await count(lowIx) !== 2 || await count(highIx) !== 3) throw new Error(`LOW=${await count(lowIx)} HIGH=${await count(highIx)}`);
      return 'LOW 2, HIGH 3';
    });
    await t('object-index: a protected value is not findable, and filtering on it is refused', async () => {
      for (const ix of [lowIx, highIx]) {
        if ((await ix.search({ type: SUITE.type, text: 'acme' })).hits.length) throw new Error('found an entity by its protected owner');
        if (!await refused(() => ix.search({ type: SUITE.type, filter: [{ field: SUITE.owner, op: 'eq', value: 'Acme Shipping' }] }))) throw new Error('filter on a protected field was accepted');
      }
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- graph
  if (platform.has('graph')) {
    const g = sys.role('graph');
    await g.upsertEdge({ from: P1, to: R, linkType: 'gov:met' });
    await g.upsertEdge({ from: R, to: P2, linkType: 'gov:met' });
    await t('graph: LOW cannot step onto or through a restricted node', async () => {
      const lo = await low.role('graph').neighbors(P1, { maxHops: 2, direction: 'out' });
      const hi = await high.role('graph').neighbors(P1, { maxHops: 2, direction: 'out' });
      if (sorted(lo.nodes.map((n) => n.id)) !== P1 || lo.edges.length) throw new Error(`LOW nodes=${lo.nodes.map((n) => n.id).join(',')} edges=${lo.edges.length}`);
      if (sorted(hi.nodes.map((n) => n.id)) !== sorted([P1, R, P2])) throw new Error(`HIGH nodes=${hi.nodes.map((n) => n.id).join(',')}`);
      return 'ok';
    });
    await t('graph: a path that exists only through a restricted node does not exist for LOW', async () => {
      const lo = await low.role('graph').shortestPath(P1, P2, { maxHops: 5 });
      const hi = await high.role('graph').shortestPath(P1, P2, { maxHops: 5 });
      if (lo !== null || hi?.length !== 2) throw new Error(`LOW=${lo?.length ?? null} HIGH=${hi?.length ?? null}`);
      return 'LOW no path, HIGH length 2';
    });
    await t('graph: a traversal filter on a protected field is refused', async () => {
      const filter = [{ field: SUITE.owner, op: 'eq', value: 'Acme Shipping' }];
      for (const p of [low, high]) {
        if (!await refused(() => p.role('graph').neighbors(P1, { maxHops: 1, filter }))) throw new Error('neighbors accepted the filter');
        if (!await refused(() => p.role('graph').shortestPath(P1, P2, { maxHops: 3, filter }))) throw new Error('shortestPath accepted the filter');
      }
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- vector
  if (platform.has('vector')) {
    const v = sys.role('vector');
    await v.upsert(R, new Float32Array([1, 0, 0]), {});
    await v.upsert(P1, new Float32Array([0.9, 0.1, 0]), {});
    await v.upsert('gov-not-an-entity', new Float32Array([0.95, 0.05, 0]), {});
    await t('vector: nearest-neighbour results skip restricted and unknown ids', async () => {
      const q = new Float32Array([1, 0, 0]);
      const lo = (await low.role('vector').knn(q, 1)).map((r) => r.id), hi = (await high.role('vector').knn(q, 1)).map((r) => r.id);
      if (sorted(lo) !== P1 || sorted(hi) !== R) throw new Error(`LOW=${lo.join(',')} HIGH=${hi.join(',')}`);
      return 'ok';
    });
    await t('vector: an engine filter that names a protected field is refused, whatever its shape', async () => {
      const q = new Float32Array([1, 0, 0]);
      for (const p of [low, high]) {
        if (!await refused(() => p.role('vector').knn(q, 1, { [SUITE.owner]: 'Acme Shipping' }))) throw new Error('accepted the field as a key');
        if (!await refused(() => p.role('vector').knn(q, 1, { must: [{ key: SUITE.owner, match: 'Acme Shipping' }] }))) throw new Error('accepted the field as a nested value');
      }
      await low.role('vector').knn(q, 1, { kind: 'vessel-photo' });       // an ordinary filter still works
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- timeseries-geo
  if (platform.has('timeseries-geo')) {
    const ts = sys.role('timeseries-geo'); const now = nowNs();
    const w = { fromNs: now - 1_000_000_000n, toNs: now + 1_000_000_000n }, here = { lat: 48.4, lon: -123.4, radiusKm: 10 };
    await ts.append({ entityId: R, ts: now, lat: 48.4, lon: -123.4 });
    await ts.append({ entityId: P1, ts: now, lat: 48.41, lon: -123.41 });
    await t('timeseries-geo: tracks of a restricted entity are withheld from LOW', async () => {
      const lts = low.role('timeseries-geo'), hts = high.role('timeseries-geo');
      if ((await lts.range(R, w)).length || (await lts.downsample(R, w, 60)).length) throw new Error('LOW read the restricted track');
      if (sorted((await lts.within(here, w)).map((p) => p.entityId)) !== P1) throw new Error('LOW area query leaked');
      if ((await hts.range(R, w)).length !== 1 || (await hts.within(here, w)).length !== 2) throw new Error('HIGH is missing points');
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- analytics-olap
  if (platform.has('analytics-olap')) {
    // for a principal, `from` is a canonical type and every name is a logical field of it
    const rowsOf = async (p: typeof low, from: string, dimensions: string[]) => (await p.role('analytics-olap').query({ from, dimensions, measures: [{ fn: 'count', as: 'n' }] })).rows;
    await t('analytics-olap: aggregates exclude restricted rows for LOW', async () => {
      const lo = Number((await rowsOf(low, SUITE.type, []))[0].n), hi = Number((await rowsOf(high, SUITE.type, []))[0].n);
      if (lo !== 2 || hi !== 3) throw new Error(`LOW=${lo} HIGH=${hi}`);
      return `LOW ${lo}, HIGH ${hi}`;
    });
    await t('analytics-olap: a principal groups by fields it may read; a protected field is refused for LOW only', async () => {
      const names = (await rowsOf(low, SUITE.type, [SUITE.name])).map((r) => String(r[SUITE.name]));
      if (sorted(names) !== sorted(['MV Public', 'MV Quay'])) throw new Error(`LOW grouped names: ${names.join(',')}`);
      if (!await refused(() => rowsOf(low, SUITE.type, [SUITE.owner]))) throw new Error('LOW grouped by a field it cannot read');
      const owners = (await rowsOf(high, SUITE.type, [SUITE.owner])).map((r) => r[SUITE.owner]);
      if (!owners.includes('Acme Shipping')) throw new Error(`HIGH could not group by owner: ${JSON.stringify(owners)}`);
      return 'ok';
    });
    await t('analytics-olap: a principal cannot reach a storage column or another table', async () => {
      const leaked = (rows: unknown) => /Acme Shipping|Secretname|gov-2-sec/.test(JSON.stringify(rows));
      if (leaked(await rowsOf(low, SUITE.type, ['body']))) throw new Error('grouping by the raw body column exposed a protected or restricted value');
      for (const table of ['entity', 'link', 'observation']) {
        const rows = await rowsOf(low, table, []);
        if (Number(rows[0]?.n ?? 0) !== 0 || leaked(rows)) throw new Error(`LOW read ${JSON.stringify(rows)} from table '${table}'`);
      }
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- stream
  if (platform.has('stream')) {
    await t('stream: a restricted envelope is not delivered to LOW', async () => {
      const lo = low.role('stream').subscribe([`${SUITE.topic}.**`], 'latest')[Symbol.asyncIterator]();
      const hi = high.role('stream').subscribe([`${SUITE.topic}.**`], 'latest')[Symbol.asyncIterator]();
      const env = (n: number, markings: MarkingId[]): Envelope => ({ id: `00000000-0000-7000-8000-00000000000${n}`, topic: `${SUITE.topic}.x`, source: 'src:gov@1.0.0', schema: 'gov:T', createdNs: nowNs(), markings, payload: new Uint8Array([n]) });
      await sys.role('stream').publish(env(1, [SUITE.RESTRICTED]));
      await sys.role('stream').publish(env(2, [SUITE.PUBLIC]));
      const l1 = await first(lo), h1 = await first(hi);
      if (l1?.payload[0] !== 2 || h1?.payload[0] !== 1) throw new Error(`LOW first=${l1?.payload[0]} HIGH first=${h1?.payload[0]}`);
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- audit-log
  const auditOf = async (p: typeof low, actor: string) => { const out: AuditRecord[] = []; for await (const r of p.role('audit-log').scan({ actor })) out.push(r); return out; };
  if (platform.has('audit-log')) {
    await t('audit-log: a restricted record is withheld from LOW', async () => {
      await sys.role('audit-log').append({ ts: nowNs(), actor: 'gov-suite', action: 'admin', resource: 'gov-a', markings: [SUITE.RESTRICTED] });
      await sys.role('audit-log').append({ ts: nowNs(), actor: 'gov-suite', action: 'admin', resource: 'gov-b', markings: [SUITE.PUBLIC] });
      const lo = (await auditOf(low, 'gov-suite')).length, hi = (await auditOf(high, 'gov-suite')).length;
      if (lo !== 1 || hi !== 2) throw new Error(`LOW=${lo} HIGH=${hi}`);
      let exported = 0; for await (const _ of low.role('audit-log').export({ fromNs: 0n, toNs: nowNs() }, 'json')) exported++;
      for await (const line of low.role('audit-log').export({ fromNs: 0n, toNs: nowNs() }, 'json')) if (line.includes('gov-a')) throw new Error('export leaked the restricted record');
      return `LOW scans 1 of 2; export ${exported} line(s)`;
    });
    await t('audit: a marked read is recorded, and a read that withheld rows is hidden from that reader', async () => {
      await highStore.getEntity(SUITE.type, R);
      await lowStore.getEntity(SUITE.type, R);
      const all: AuditRecord[] = []; for await (const r of sys.role('audit-log').scan({})) all.push(r);
      const reads = (who: Principal) => all.filter((r) => r.actor === who.id && r.action === 'read' && r.resource === 'canonical-store.getEntity');
      if (!reads(HIGH).length) throw new Error('the HIGH read of a marked row was not audited');
      const withheld = reads(LOW).filter((r) => (r.detail as { withheld?: number } | undefined)?.withheld);
      if (!withheld.length) throw new Error('the withheld LOW read was not audited');
      if ((await auditOf(low, LOW.id)).some((r) => (r.detail as { withheld?: number } | undefined)?.withheld)) throw new Error('LOW can see that rows were withheld from it');
      return `${reads(HIGH).length} HIGH read(s), ${withheld.length} withheld LOW read(s) hidden from LOW`;
    });
  }

  // ---------------------------------------------------------------- work-queue
  if (platform.has('work-queue')) {
    await t('work-queue: a principal cannot claim, complete or fail jobs (they carry no markings)', async () => {
      const id = await sys.role('work-queue').enqueue({ kind: 'gov-approval', payload: { targetId: R, note: 'restricted matter' } });
      for (const p of [low, high]) {
        const port = p.role('work-queue') as unknown as Record<string, unknown>;
        for (const m of ['claim', 'complete', 'fail', 'enqueue']) if (port[m] !== undefined) throw new Error(`work-queue.${m} is exposed to principals`);
      }
      if (!(await sys.role('work-queue').claim('gov-suite', 10)).some((j) => j.id === id)) throw new Error('the system handle could not claim the job');
      await sys.role('work-queue').complete(id);
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- hot-cache
  if (platform.has('hot-cache')) {
    await t('hot-cache: principals with different clearances never share an entry', async () => {
      await low.role('hot-cache').set('gov-k', 'low');
      if (await high.role('hot-cache').get('gov-k') !== null) throw new Error('HIGH read LOW\'s entry');
      await high.role('hot-cache').set('gov-k', 'high');
      if (await low.role('hot-cache').get('gov-k') !== 'low') throw new Error('LOW read HIGH\'s entry');
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- inheritance (needs lineage)
  if (platform.has('lineage')) {
    const lineage = sys.role('lineage');
    const lowSees = async (id: string) => (await lowStore.getEntity(SUITE.type, id)) !== null;
    const lowFinds = async (text: string) => platform.has('object-index') ? (await low.role('object-index').search({ type: SUITE.type, text })).hits.length : 0;
    await seed(vessel(D, 'MV Derived', [SUITE.PUBLIC]));
    await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-1', kind: 'source-observation' });
    await lineage.record({ upstream: 'gov-obs-1', downstream: entityRef(SUITE.type, D), kind: 'observation-entity' });

    await t('inheritance: marking a source restricts what was already derived from it, in every projection', async () => {
      if (!await lowSees(D) || await lowFinds('derived') !== 1) throw new Error('precondition: D should be public before the source is marked');
      const stamped = await propagate(platform, SUITE.source, [SUITE.RESTRICTED], 'gov-admin');
      if (!stamped.includes(entityRef(SUITE.type, D))) throw new Error(`propagate stamped ${stamped.join(',') || 'nothing'}`);
      if (await lowSees(D)) throw new Error('LOW still reads D');
      if (await lowFinds('derived')) throw new Error('LOW still finds D by search');
      if (!await highStore.getEntity(SUITE.type, D)) throw new Error('HIGH lost D');
      if (platform.has('object-index')) {
        const c = (await low.role('object-index').aggregate({ type: SUITE.type, groupBy: [], metrics: [{ fn: 'count' }] })).rows[0].metrics.count;
        if (c !== 2) throw new Error(`LOW count is ${c}, expected 2`);
      }
      return `stamped ${stamped.length}`;
    });
    await t('inheritance: an entity linked to the marked source afterwards inherits (entity first, then edge)', async () => {
      await seed(vessel(L, 'MV Late', [SUITE.PUBLIC]));
      await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-2', kind: 'source-observation' });
      await lineage.record({ upstream: 'gov-obs-2', downstream: entityRef(SUITE.type, L), kind: 'observation-entity' });
      if (await lowSees(L) || await lowFinds('late')) throw new Error('LOW reaches the late derivation');
      return 'ok';
    });
    await t('inheritance: an entity written after its edge inherits (edge first, then entity)', async () => {
      await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-3', kind: 'source-observation' });
      await lineage.record({ upstream: 'gov-obs-3', downstream: entityRef(SUITE.type, E), kind: 'observation-entity' });
      await seed(vessel(E, 'MV Early', [SUITE.PUBLIC]));
      if (await lowSees(E) || await lowFinds('early')) throw new Error('LOW reaches the early-edge derivation');
      return 'ok';
    });
    await t('inheritance: a chain recorded bottom-up still restricts the entity at its end', async () => {
      await seed(vessel(B, 'MV Bottomup', [SUITE.PUBLIC]));
      await lineage.record({ upstream: 'gov-obs-4', downstream: entityRef(SUITE.type, B), kind: 'observation-entity' });
      if (!await lowSees(B)) throw new Error('precondition: B is public until its chain reaches the marked source');
      await lineage.record({ upstream: SUITE.source, downstream: 'gov-obs-4', kind: 'source-observation' });
      if (await lowSees(B) || await lowFinds('bottomup')) throw new Error('LOW reaches B');
      return 'ok';
    });
    await t('invariant: markings never shrink, in the store or in a projection', async () => {
      await seed(vessel(D, 'MV Derived', [SUITE.PUBLIC]));        // a writer "forgets" the restriction
      if (await lowSees(D) || await lowFinds('derived')) throw new Error('re-writing D with fewer markings exposed it');
      return 'ok';
    });
    await t('lineage: LOW cannot see the edges of a restricted chain', async () => {
      const lo = await low.role('lineage').downstreamOf(SUITE.source), hi = await high.role('lineage').downstreamOf(SUITE.source);
      if (lo.length || !hi.length) throw new Error(`LOW=${lo.length} HIGH=${hi.length}`);
      return `HIGH sees ${hi.length} edge(s)`;
    });
    if (platform.has('audit-log')) await t('propagation is audited once, by the actor who ordered it', async () => {
      const recs = (await auditOf(high, 'gov-admin')).filter((r) => r.resource === SUITE.source && r.action === 'admin');
      if (recs.length !== 1) throw new Error(`${recs.length} record(s)`);
      if ((await auditOf(low, 'gov-admin')).length) throw new Error('LOW can see the propagation record');
      return 'ok';
    });
  }

  // ---------------------------------------------------------------- structure
  await t('structure: a governed port carries no system method', async () => {
    const { GOVERNANCE_RULES } = await import('./governance.ts');
    let n = 0;
    for (const [role, rules] of Object.entries(GOVERNANCE_RULES) as [keyof typeof GOVERNANCE_RULES, Record<string, string>][]) {
      if (!platform.has(role)) continue;
      const port = low.role(role) as Record<string, unknown>;
      for (const m of Object.keys(port)) if (port[m] !== undefined && rules[m] !== 'governed' && rules[m] !== 'open') throw new Error(`${role}.${m} is exposed but classified '${rules[m]}'`);
      n++;
    }
    return `${n} role(s)`;
  });

  return checks;
}
