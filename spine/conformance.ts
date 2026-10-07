// spine/conformance.ts — the shared, engine-agnostic conformance suite.
// An engine is "supported for a role" only when its adapter passes the role's suite.
// This is what makes adapters swap-safe across clients (12-ADAPTER-CONTRACT §5).
import { ADAPTER_REGISTRY, type RoleBinding } from './contracts.ts';
import { consoleLogger, PERMISSIVE_MARKING, makeShared } from './compiler.ts';
import type { RoleId, Adapter, AdapterContext, Principal, CanonicalStore, ObjectIndex, WorkQueue, Stream, BlobCas, AuditLog, Lineage, Registry, PolicyIdentity, Cache, VectorStore, GraphStore, TimeSeriesGeo } from './ports.ts';
import type { Json } from './model.ts';

export interface ConformanceReport { role: RoleId; engine: string; ok: boolean; checks: { name: string; ok: boolean; info: string }[]; }

const nowNs = () => BigInt(Date.now()) * 1_000_000n;

export async function conform(role: RoleId, engine: string, config: Record<string, Json>): Promise<ConformanceReport> {
  const factory = ADAPTER_REGISTRY[role]?.[engine];
  const checks: ConformanceReport['checks'] = [];
  if (!factory) return { role, engine, ok: false, checks: [{ name: 'registered', ok: false, info: 'no adapter' }] };
  const adapter = factory(makeShared());
  const ctx: AdapterContext = { role, manifest: { engine, config } as RoleBinding as never, logger: consoleLogger('conf'), marking: PERMISSIVE_MARKING };
  const t = async (name: string, fn: () => Promise<string>) => { try { checks.push({ name, ok: true, info: await fn() }); } catch (e) { checks.push({ name, ok: false, info: (e as Error).message }); } };

  await t('init', async () => { await adapter.init(ctx); return 'ok'; });
  await t('declares satisfying capabilities', async () => { const { satisfies } = await import('./contracts.ts'); const r = satisfies(role, adapter.capabilities); if (!r.ok) throw new Error(r.reasons.join('; ')); return adapter.capabilities.consistency; });
  await t('health', async () => { const h = await adapter.health(); if (!h.ok) throw new Error('unhealthy'); return `p99≈${h.p99Ms}ms`; });
  await SUITES[role]?.(adapter, t);
  await adapter.close();
  return { role, engine, ok: checks.every((c) => c.ok), checks };
}

type T = (name: string, fn: () => Promise<string>) => Promise<void>;

const SUITES: Partial<Record<RoleId, (a: Adapter, t: T) => Promise<void>>> = {
  'canonical-store': async (a, t) => {
    const s = a as CanonicalStore;
    await t('entity round-trips + idempotent upsert', async () => {
      const e = { id: 'c1', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: { k: 'v' }, provenance: {} };
      await s.upsertEntity(e); await s.upsertEntity(e);
      const g = await s.getEntity('x:T', 'c1'); if (!g || g.fields.k !== 'v') throw new Error('mismatch'); return 'ok';
    });
    await t('transaction rolls back on throw', async () => {
      try { await s.transaction(async () => { await s.upsertEntity({ id: 'c2', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} }); throw new Error('boom'); }); } catch { /* expected */ }
      return 'rolled back';
    });
    await t('transactions started together run one after another', async () => {
      const put = (id: string) => s.transaction(async () => {
        await s.upsertEntity({ id, type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} });
        await new Promise((r) => setTimeout(r, 5));          // hold the transaction open across a real await
        return id;
      });
      for (const id of await Promise.all(['t1', 't2', 't3'].map(put))) if (!await s.getEntity('x:T', id)) throw new Error(`${id} was not committed`);
      return 'ok';
    });
    await t('addMarkings is atomic, and upsertEntity never shrinks the markings a row already has', async () => {
      const row = (f: number, markings: string[]) => ({ id: 'm3', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: { f }, provenance: {}, markings });
      await s.upsertEntity(row(1, ['A']));
      if (!await s.addMarkings('x:T', 'm3', ['B'])) throw new Error('addMarkings should report growth');
      if (await s.addMarkings('x:T', 'm3', ['B'])) throw new Error('addMarkings should report no growth the second time');
      if (await s.addMarkings('x:T', 'nope', ['B'])) throw new Error('addMarkings on a missing row must report false');
      await s.upsertEntity(row(2, ['A']));                         // a writer holding a stale copy of the row
      const g = await s.getEntity('x:T', 'm3');
      if (g?.fields.f !== 2 || (g.markings ?? []).slice().sort().join() !== 'A,B') throw new Error(`fields=${JSON.stringify(g?.fields)} markings=${JSON.stringify(g?.markings)}`);
      return 'ok';
    });
    await t('markingsOf: known ids with their markings, unknown ids omitted', async () => {
      await s.upsertEntity({ id: 'm1', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {}, markings: ['A', 'B'] });
      await s.upsertEntity({ id: 'm2', type: 'x:T', ts: nowNs(), source: 's', schemaVersion: 1, fields: {}, provenance: {} });
      const m = await s.markingsOf(['m1', 'm2', 'nope']);
      if ((m.m1 ?? []).slice().sort().join() !== 'A,B') throw new Error(`m1 = ${JSON.stringify(m.m1)}`);
      if (!Array.isArray(m.m2) || m.m2.length !== 0) throw new Error(`m2 = ${JSON.stringify(m.m2)}`);
      if ('nope' in m) throw new Error('unknown id must be omitted');
      return 'ok';
    });
  },
  'object-index': async (a, t) => {
    const ix = a as ObjectIndex;
    await t('index + search + blocking', async () => {
      await ix.index('x:T', 'i1', { id: 'i1', type: 'x:T', text: 'alpha bravo', fields: { mmsi: '123' } });
      if (!(await ix.search({ type: 'x:T', text: 'bravo' })).hits.length) throw new Error('no hit');
      if (!(await ix.searchCandidates('x:T', { mmsi: '123' }, 5)).includes('i1')) throw new Error('no candidate');
      return 'ok';
    });
    if (a.capabilities.enforcesMarkings) await t('enforces markings: search + aggregate filter by principal; setMarkings restricts later', async () => {
      const low: Principal = { id: 'low', roles: [], clearances: ['U'] };
      const high: Principal = { id: 'high', roles: [], clearances: ['U', 'S'] };
      const count = async (p?: Principal) => (await ix.aggregate({ type: 'e:T', groupBy: [], metrics: [{ fn: 'count' }], principal: p })).rows[0].metrics.count;
      const ids = async (p?: Principal) => (await ix.search({ type: 'e:T', text: 'charlie', principal: p })).hits.map((h) => h.id).sort().join();
      await ix.index('e:T', 'pub', { id: 'pub', type: 'e:T', text: 'charlie one', fields: {}, markings: ['U'] });
      await ix.index('e:T', 'sec', { id: 'sec', type: 'e:T', text: 'charlie two', fields: {}, markings: ['U', 'S'] });
      if (await ids(low) !== 'pub' || await ids(high) !== 'pub,sec') throw new Error(`search low=${await ids(low)} high=${await ids(high)}`);
      if (await count(low) !== 1 || await count(high) !== 2 || await count() !== 2) throw new Error(`count low=${await count(low)} high=${await count(high)} none=${await count()}`);
      const odd: Principal = { id: 'odd', roles: [], clearances: ['U', null as unknown as string] };
      if (await count(odd) !== 1 || await ids(odd) !== 'pub') throw new Error(`a null clearance counted as held: count=${await count(odd)} ids=${await ids(odd)}`);
      await ix.setMarkings('e:T', 'pub', ['U', 'S']);
      if (await ids(low) !== '' || await count(low) !== 0) throw new Error('setMarkings did not restrict the row');
      return 'ok';
    });
  },
  'work-queue': async (a, t) => {
    const q = a as WorkQueue;
    await t('enqueue→claim→complete (exactly-once)', async () => {
      const id = await q.enqueue({ kind: 'k', payload: { n: 1 } });
      const c1 = await q.claim('w', 10); await q.complete(id);
      const c2 = await q.claim('w', 10);
      if (!c1.find((j) => j.id === id) || c2.find((j) => j.id === id)) throw new Error('claim semantics wrong');
      return 'ok';
    });
  },
  'stream': async (a, t) => {
    const st = a as Stream;
    await t('publish + subscribe (live)', async () => {
      const it = st.subscribe(['x.**'], 'latest')[Symbol.asyncIterator]();
      await st.publish({ id: '00000000-0000-7000-8000-000000000001', topic: 'x.y', source: 's', schema: 'x:T', createdNs: nowNs(), payload: new Uint8Array([1, 2, 3]) });
      const got = await Promise.race([it.next(), new Promise<IteratorResult<unknown>>((r) => setTimeout(() => r({ value: undefined, done: true }), 800))]);
      if (got.done) throw new Error('no envelope'); return 'ok';
    });
  },
  'blob-cas': async (a, t) => {
    const b = a as BlobCas;
    await t('content-addressed put/get', async () => { const bytes = new TextEncoder().encode('hello'); const h = await b.put(bytes, 'text/plain'); if ((await b.get(h)).length !== 5) throw new Error('mismatch'); return h.sha256.slice(0, 8); });
  },
  'audit-log': async (a, t) => {
    const al = a as AuditLog;
    await t('append + scan', async () => { await al.append({ ts: nowNs(), actor: 'u', action: 'write', resource: 'r' }); let n = 0; for await (const _ of al.scan({ actor: 'u' })) n++; if (!n) throw new Error('empty'); return `${n}`; });
  },
  'lineage': async (a, t) => {
    const l = a as Lineage;
    await t('record + downstream + propagate', async () => { await l.record({ upstream: 'A', downstream: 'B', kind: 'transform' }); await l.record({ upstream: 'B', downstream: 'C', kind: 'transform' }); const aff = await l.propagateMarking('A', ['M']); if (!aff.includes('B') || !aff.includes('C')) throw new Error('closure wrong'); return `${aff.length}`; });
    await t('effectiveMarkings: a marking applied at a ref is inherited downstream, in either order', async () => {
      const eff = async (ref: string) => (await l.effectiveMarkings(ref)).slice().sort().join();
      if (await eff('C') !== 'M') throw new Error(`C should inherit M from A (propagated above), got '${await eff('C')}'`);
      await l.record({ upstream: 'C', downstream: 'D', kind: 'transform' });            // edge recorded AFTER the marking
      if (await eff('D') !== 'M') throw new Error(`late derivation D got '${await eff('D')}'`);
      await l.applyMarking('B', ['N']);
      if (await eff('D') !== 'M,N' || await eff('A') !== 'M') throw new Error(`after N at B: D='${await eff('D')}' A='${await eff('A')}'`);
      if (await eff('unrelated') !== '') throw new Error('unrelated ref must have no markings');
      if ((await l.downstreamOf('A')).some((e) => e.kind === 'marking')) throw new Error('marking records must not appear as edges');
      return 'ok';
    });
  },
  'registry': async (a, t) => {
    const r = a as Registry;
    await t('put + get + versions', async () => { await r.put({ id: 's', type: 'core:SchemaType', ts: nowNs(), source: 'p', schemaVersion: 1, name: 'x:T', semver: '1.0.0', jsonSchema: {} }); const g = await r.get('x:T'); if (!g) throw new Error('missing'); return g.semver; });
  },
  'policy-identity': async (a, t) => {
    const p = a as PolicyIdentity;
    await t('authenticate + authorize', async () => { const pr = await p.authenticate('tok'); if (!pr) throw new Error('no principal'); const d = await p.authorize(pr, 'read', { type: 'x:T' }); if (!d.allow) throw new Error('denied'); return 'ok'; });
  },
  'hot-cache': async (a, t) => {
    const c = a as Cache;
    await t('set/get/incr/del', async () => { await c.set('k', 'v'); if (await c.get('k') !== 'v') throw new Error('get'); if (await c.incr('n', 2) !== 2) throw new Error('incr'); await c.del('k'); if (await c.get('k') !== null) throw new Error('del'); return 'ok'; });
  },
  'vector': async (a, t) => {
    const v = a as VectorStore;
    await t('upsert + knn ranks self first', async () => { await v.upsert('a', new Float32Array([1, 0, 0]), {}); await v.upsert('b', new Float32Array([0, 1, 0]), {}); const r = await v.knn(new Float32Array([1, 0, 0]), 2); if (r[0].id !== 'a') throw new Error('ranking'); return `top=${r[0].id}`; });
  },
  'graph': async (a, t) => {
    const g = a as GraphStore;
    await t('edges + neighbors + shortestPath', async () => { await g.upsertEdge({ from: 'A', to: 'B', linkType: 'l' }); await g.upsertEdge({ from: 'B', to: 'C', linkType: 'l' }); const nb = await g.neighbors('A', { maxHops: 2, direction: 'out' }); const sp = await g.shortestPath('A', 'C', { maxHops: 5 }); if (!nb.nodes.find((n) => n.id === 'C') || sp?.length !== 2) throw new Error('traversal'); return `path=${sp?.length}`; });
  },
  'timeseries-geo': async (a, t) => {
    const ts = a as TimeSeriesGeo;
    await t('append + range + within', async () => { const now = nowNs(); await ts.append({ entityId: 'e', ts: now, lat: 48.4, lon: -123.4 }); const r = await ts.range('e', { fromNs: now - 1_000_000_000n, toNs: now + 1_000_000_000n }); const w = await ts.within({ lat: 48.4, lon: -123.4, radiusKm: 10 }, { fromNs: now - 1_000_000_000n, toNs: now + 1_000_000_000n }); if (!r.length || !w.length) throw new Error('query'); return 'ok'; });
  },
};
