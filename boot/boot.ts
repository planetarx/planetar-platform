// boot/boot.ts — compile a client manifest and boot the platform from it.
// Proof of 90-ROADMAP Phase 1: the maritime EDGE manifest binds the already-built
// spine to zero-service engines and runs end-to-end, with NO code change to the spine.
//   run:  node --experimental-sqlite boot/boot.ts [manifest.json]
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compile, type ClientManifest } from '../spine/compiler.ts';
import { satisfies } from '../spine/contracts.ts';
import '../adapters/index.ts';   // registers all built adapters
import type { Envelope } from '../spine/ports.ts';
import type { CanonicalEntity, SchemaType } from '../spine/model.ts';

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const results: { name: string; ok: boolean; info: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try { results.push({ name, ok: true, info: await fn() }); }
  catch (e) { results.push({ name, ok: false, info: (e as Error).message }); }
}

async function main() {
  const manifestPath = process.argv[2] ?? new URL('./manifests/maritime-edge.json', import.meta.url).pathname;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientManifest;
  rmSync('./.data', { recursive: true, force: true });   // clean slate for a deterministic demo

  console.log(`\n=== Compiling manifest: ${manifest.client.name} (tier=${manifest.client.tier}) ===`);
  const { platform, required, bound, warnings, topology } = await compile(manifest);
  console.log(`\nrequired roles (${required.length}): ${required.join(', ')}`);
  console.log(`bound roles    (${bound.length}): ${bound.join(', ')}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);

  console.log('\n=== Topology ===\n' + topology);

  // this script is an operator's smoke test of the raw roles, so it takes the system handle
  const sys = platform.system('boot');

  // --- health of every bound role ---
  console.log('\n=== Health ===');
  for (const r of bound) {
    const h = await sys.role(r).health();
    console.log(`  ${h.ok ? '✅' : '❌'} ${r} (p99≈${h.p99Ms ?? '?'}ms)`);
  }

  // --- end-to-end smoke through the spine ports (engine-agnostic) ---
  const store = sys.role('canonical-store');
  const index = sys.role('object-index');
  const stream = sys.role('stream');
  const work = sys.role('work-queue');
  const audit = sys.role('audit-log');
  const registry = sys.role('registry');
  const blob = sys.role('blob-cas');
  const lineage = sys.role('lineage');
  const policy = sys.role('policy-identity');

  const vid = randomUUID();
  const vessel: CanonicalEntity = {
    id: vid, type: 'planetar:Vessel', ts: nowNs(), source: 'src:ais@1.0.0', schemaVersion: 0x010000,
    fields: { 'planetar:mmsi': '316001234', 'planetar:name': 'MV Demo' },
    provenance: { 'planetar:mmsi': { obs: 'obs-1', src: 'src:ais@1.0.0', conf: 0.95, ts: nowNs() } },
  };

  await check('registry.put + get', async () => {
    const schema: SchemaType = { id: 'sch-vessel', type: 'core:SchemaType', ts: nowNs(), source: 'platform', schemaVersion: 0x010000, name: 'planetar:Vessel', extends: 'core:CanonicalEntity', semver: '1.0.0', jsonSchema: { type: 'object' } };
    await registry.put(schema);
    const got = await registry.get('planetar:Vessel');
    return got ? `schema ${got.name}@${got.semver}` : 'MISSING';
  });

  await check('canonical-store.upsert + get', async () => {
    await store.upsertEntity(vessel);
    const got = await store.getEntity('planetar:Vessel', vid);
    if (!got || got.fields['planetar:mmsi'] !== '316001234') throw new Error('round-trip mismatch');
    return `entity ${got.fields['planetar:name']} (mmsi ${got.fields['planetar:mmsi']})`;
  });

  await check('object-index.index + search + blocking', async () => {
    await index.index('planetar:Vessel', vid, { id: vid, type: 'planetar:Vessel', text: 'MV Demo', fields: vessel.fields });
    const hits = await index.search({ type: 'planetar:Vessel', text: 'demo', limit: 5 });
    const cands = await index.searchCandidates('planetar:Vessel', { 'planetar:mmsi': '316001234' }, 5);
    if (!hits.hits.length || !cands.includes(vid)) throw new Error('search/blocking failed');
    return `${hits.hits.length} hit(s), ${cands.length} resolution candidate(s)`;
  });

  await check('stream.publish + subscribe (live)', async () => {
    const sub = stream.subscribe(['vessel.**'], 'latest')[Symbol.asyncIterator]();
    const env: Envelope = { id: randomUUID(), topic: 'vessel.ais.position', source: 'src:ais@1.0.0', schema: 'planetar:Observation', createdNs: nowNs(), markings: ['UNCLASS'], payload: new TextEncoder().encode(JSON.stringify({ mmsi: '316001234', lat: 48.4, lon: -123.4 })) };
    await stream.publish(env);
    const got = await Promise.race([sub.next(), new Promise<IteratorResult<Envelope>>((r) => setTimeout(() => r({ value: undefined as never, done: true }), 1000))]);
    if (got.done) throw new Error('no envelope received');
    return `received ${got.value.topic} (${got.value.payload.length} bytes)`;
  });

  await check('blob-cas.put + get (content-addressed)', async () => {
    const bytes = new TextEncoder().encode('fake-sar-chip-bytes');
    const handle = await blob.put(bytes, 'image/png');
    const back = await blob.get(handle);
    if (back.length !== bytes.length) throw new Error('blob round-trip mismatch');
    return `sha256 ${handle.sha256.slice(0, 12)}… (${handle.size} bytes)`;
  });

  await check('work-queue.enqueue + claim + complete', async () => {
    const id = await work.enqueue({ kind: 'confirm-dark-vessel', payload: { entityId: vid } });
    const claimed = await work.claim('worker-1', 10);
    await work.complete(id);
    if (!claimed.find((j) => j.id === id)) throw new Error('claim missed the job');
    return `job ${id} enqueued→claimed→completed`;
  });

  await check('audit-log.append + scan (hash-chained)', async () => {
    await audit.append({ ts: nowNs(), actor: 'worker-1', action: 'write', resource: `planetar:Vessel/${vid}`, markings: ['UNCLASS'] });
    let n = 0; for await (const _ of audit.scan({ actor: 'worker-1' })) n++;
    return `${n} audit record(s)`;
  });

  await check('lineage.record + propagateMarking', async () => {
    await lineage.record({ upstream: 'src:ais@1.0.0', downstream: `obs-1`, kind: 'source-observation' });
    await lineage.record({ upstream: 'obs-1', downstream: `planetar:Vessel/${vid}`, kind: 'observation-entity' });
    const affected = await lineage.propagateMarking('src:ais@1.0.0', ['OPS-RESTRICTED']);
    return `marking propagated to ${affected.length} downstream ref(s)`;
  });

  await check('policy-identity.authorize (PEP)', async () => {
    const p = await policy.authenticate('analyst-token');
    if (!p) throw new Error('auth failed');
    const held = p.clearances[0] ?? 'UNCLASS';            // a marking this client's principal actually holds
    const allow = await policy.authorize(p, 'read', { type: 'planetar:Vessel', id: vid, markings: [held] });
    const deny = await policy.authorize(p, 'read', { type: 'planetar:Vessel', markings: ['__UNHELD__'] });
    if (!allow.allow || deny.allow) throw new Error('policy decision wrong');
    return `allow ${held} ✓, deny unheld marking ✓`;
  });

  // --- optional roles: exercised only if this client's footprint bound them (role selectivity) ---
  if (platform.has('graph')) await check('graph.edges + neighbors + shortestPath', async () => {
    const g = sys.role('graph');
    await g.upsertEdge({ from: vid, to: 'org-acme', linkType: 'crm:works_at' });
    await g.upsertEdge({ from: 'org-acme', to: 'org-parent', linkType: 'crm:subsidiary_of' });
    const nb = await g.neighbors(vid, { maxHops: 2, direction: 'out' });
    const sp = await g.shortestPath(vid, 'org-parent', { maxHops: 5 });
    if (!nb.nodes.find((n) => n.id === 'org-parent') || sp?.length !== 2) throw new Error('traversal failed');
    return `${nb.nodes.length} nodes in 2-hop, shortest path = ${sp?.length}`;
  });
  if (platform.has('vector')) await check('vector.upsert + knn (re-ID / RAG)', async () => {
    const v = sys.role('vector');
    await v.upsert(vid, new Float32Array([1, 0, 0]), { kind: 'vessel-photo' });
    await v.upsert('other', new Float32Array([0, 1, 0]), {});
    const top = await v.knn(new Float32Array([0.9, 0.1, 0]), 1);
    if (top[0].id !== vid) throw new Error('knn ranking wrong');
    return `nearest = ${top[0].id.slice(0, 8)}… (cos ${top[0].score.toFixed(3)})`;
  });
  if (platform.has('hot-cache')) await check('hot-cache.set + incr (presence/counters)', async () => {
    const c = sys.role('hot-cache');
    await c.set(`presence:${vid}`, 'online', 60);
    const n = await c.incr('rate:api', 1);
    if ((await c.get(`presence:${vid}`)) !== 'online' || n !== 1) throw new Error('cache wrong');
    return `presence cached, rate counter = ${n}`;
  });
  if (platform.has('timeseries-geo')) await check('timeseries-geo.append + range', async () => {
    const ts = sys.role('timeseries-geo');
    const now = nowNs();
    await ts.append({ entityId: vid, ts: now, lat: 48.42, lon: -123.37, fields: { speed_kn: 12 } });
    const r = await ts.range(vid, { fromNs: now - 1_000_000_000n, toNs: now + 1_000_000_000n });
    if (!r.length) throw new Error('no track points');
    return `${r.length} track point(s)`;
  });
  if (platform.has('analytics-olap')) await check('analytics-olap.query (report roll-up)', async () => {
    const olap = sys.role('analytics-olap');
    const res = await olap.query({ from: 'entity', dimensions: ['type'], measures: [{ fn: 'count', as: 'n' }], orderBy: [{ key: 'n', dir: 'desc' }] });
    if (!res.rows.length) throw new Error('no rows');
    return `${res.rows.length} group(s); top: ${JSON.stringify(res.rows[0])}`;
  });

  // --- contract guardrail: the compiler refuses an engine that can't meet a role's contract ---
  console.log('\n=== Contract guardrail (under-provisioning is a compile error, not a 3am incident) ===');
  const badStream = satisfies('stream', { consistency: 'eventual', durable: false, rebuildable: true, scale: 'single', p99TargetMs: 1 });
  console.log(`  non-durable engine bound to R3 stream → ${badStream.ok ? '❌ ALLOWED (bug!)' : '✅ REJECTED'}: ${badStream.reasons.join('; ')}`);
  const okPg = satisfies('canonical-store', { consistency: 'strong', durable: true, rebuildable: true, scale: 'vertical', p99TargetMs: 8 });
  console.log(`  postgres bound to R1 canonical-store → ${okPg.ok ? '✅ ACCEPTED' : '❌ rejected'}`);

  // --- report ---
  console.log('\n=== Smoke (spine ports over the bound engines) ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.info}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);

  await platform.closeAll();
  console.log('platform closed cleanly.\n');
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error('BOOT FAILED:', e); process.exit(1); });
