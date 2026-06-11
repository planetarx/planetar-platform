// spine/conformance.ts — the shared, engine-agnostic conformance suite.
// An engine is "supported for a role" only when its adapter passes the role's suite.
// This is what makes adapters swap-safe across clients (12-ADAPTER-CONTRACT §5).
import { ADAPTER_REGISTRY, type RoleBinding } from './contracts.ts';
import { consoleLogger, PERMISSIVE_MARKING, makeShared } from './compiler.ts';
import type { RoleId, Adapter, AdapterContext, CanonicalStore, ObjectIndex, WorkQueue, Stream, BlobCas, AuditLog, Lineage, Registry, PolicyIdentity, Cache, VectorStore, GraphStore, TimeSeriesGeo } from './ports.ts';
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
  },
  'object-index': async (a, t) => {
    const ix = a as ObjectIndex;
    await t('index + search + blocking', async () => {
      await ix.index('x:T', 'i1', { id: 'i1', type: 'x:T', text: 'alpha bravo', fields: { mmsi: '123' } });
      if (!(await ix.search({ type: 'x:T', text: 'bravo' })).hits.length) throw new Error('no hit');
      if (!(await ix.searchCandidates('x:T', { mmsi: '123' }, 5)).includes('i1')) throw new Error('no candidate');
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
