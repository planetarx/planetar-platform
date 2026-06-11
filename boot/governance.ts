// boot/governance.ts — Phase 3 proof: propagating security.
// Security defined ONCE at a source propagates along lineage to derived entities, and two
// principals get different governed views of the SAME store (row-level filter + FLS redaction).
//   run:  node --experimental-sqlite boot/governance.ts   (npm run governance)
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compile, type ClientManifest } from '../spine/compiler.ts';
import { MarkingPolicy, Session, propagate, entityRef } from '../spine/governance.ts';
import '../adapters/index.ts';
import type { CanonicalStore, Lineage, AuditLog, Principal } from '../spine/ports.ts';
import type { CanonicalEntity } from '../spine/model.ts';

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const results: { name: string; ok: boolean; info: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try { results.push({ name, ok: true, info: await fn() }); } catch (e) { results.push({ name, ok: false, info: (e as Error).message }); }
}

const MANIFEST: ClientManifest = {
  schema_version: '1.0',
  client: { id: 'gov-demo', name: 'Propagating-Security Demo', tier: 'standard' },
  capabilities: ['kinetic-writes', 'identity-resolution', 'propagating-security', 'audit', 'search'],
  roles: {
    'canonical-store': { engine: 'sqlite', config: { path: './.data/gov/canonical.db' } },
    'object-index': { engine: 'sqlite', config: { path: './.data/gov/index.db' } },
    'registry': { engine: 'git-fs', config: { path: './.data/gov/registry' } },
    'audit-log': { engine: 'append-wal', config: { path: './.data/gov/audit.log' } },
    'stream': { engine: 'file', config: { path: './.data/gov/stream.wal' } },
    'lineage': { engine: 'fs', config: { path: './.data/gov/lineage.jsonl' } },
    'policy-identity': { engine: 'internal', config: { clearances: ['UNCLASS'] } },
  },
  governance: { markings: [{ id: 'UNCLASS', default: true }, { id: 'OPS-RESTRICTED' }], propagate: 'lineage' },
};

// FLS: the 'owner' field of a Vessel requires OPS-RESTRICTED clearance to be seen.
const POLICY = new MarkingPolicy({ 'planetar:Vessel': { 'planetar:owner': 'OPS-RESTRICTED' } });

const LOW: Principal = { id: 'analyst-low', roles: ['operator'], clearances: ['UNCLASS'] };
const HIGH: Principal = { id: 'analyst-high', roles: ['operator'], clearances: ['UNCLASS', 'OPS-RESTRICTED'] };

function vessel(id: string, name: string, extra: Record<string, string> = {}): CanonicalEntity {
  return { id, type: 'planetar:Vessel', ts: nowNs(), source: 'src:ais@1.0.0', schemaVersion: 0x010000,
    fields: { 'planetar:name': name, ...extra }, provenance: {}, markings: ['UNCLASS'] };
}

async function main() {
  rmSync('./.data/gov', { recursive: true, force: true });
  console.log('\n=== Phase 3: propagating security ===');
  const { platform } = await compile(MANIFEST);
  const store: CanonicalStore = platform.role('canonical-store');
  const lineage: Lineage = platform.role('lineage');
  const audit: AuditLog = platform.role('audit-log');

  const A = randomUUID(), B = randomUUID();
  await store.upsertEntity(vessel(A, 'MV Alpha', { 'planetar:owner': 'Acme Shipping Ltd' }));   // UNCLASS, owner is FLS-restricted
  await store.upsertEntity(vessel(B, 'MV Bravo'));                                               // UNCLASS for now

  // B derives from a classified feed (lineage): src:classified-feed -> obs-B -> Vessel/B
  await lineage.record({ upstream: 'src:classified-feed', downstream: 'obs-B', kind: 'source-observation' });
  await lineage.record({ upstream: 'obs-B', downstream: entityRef('planetar:Vessel', B), kind: 'observation-entity' });

  const low = new Session(platform, LOW, POLICY);
  const high = new Session(platform, HIGH, POLICY);

  await check('FLS: low principal sees Alpha but owner is redacted', async () => {
    const e = await low.getEntity('planetar:Vessel', A);
    if (!e) throw new Error('Alpha should be visible (UNCLASS)');
    if (e.fields['planetar:owner'] !== undefined) throw new Error('owner must be redacted for low clearance');
    return `name=${e.fields['planetar:name']}, owner=<redacted>`;
  });
  await check('FLS: high principal sees Alpha owner', async () => {
    const e = await high.getEntity('planetar:Vessel', A);
    if (e?.fields['planetar:owner'] !== 'Acme Shipping Ltd') throw new Error('owner should be visible');
    return `owner=${e.fields['planetar:owner']}`;
  });
  await check('before propagation: low principal CAN see Bravo', async () => {
    const e = await low.getEntity('planetar:Vessel', B);
    if (!e) throw new Error('Bravo is UNCLASS, should be visible');
    return 'visible';
  });

  // Define the restriction ONCE, at the source. It propagates along lineage to Bravo.
  const stamped = await propagate(platform, 'src:classified-feed', ['OPS-RESTRICTED']);
  await audit.append({ ts: nowNs(), actor: 'system', action: 'admin', resource: 'src:classified-feed', detail: { propagated: 'OPS-RESTRICTED', to: stamped }, markings: ['OPS-RESTRICTED'] });

  await check('propagation: OPS-RESTRICTED flowed from source to Bravo', async () => {
    if (!stamped.includes(entityRef('planetar:Vessel', B))) throw new Error('Bravo was not re-stamped');
    const raw = await store.getEntity('planetar:Vessel', B);
    if (!raw?.markings?.includes('OPS-RESTRICTED')) throw new Error('marking not persisted');
    return `stamped ${stamped.length} entity(ies): ${stamped.join(', ')}`;
  });
  await check('after propagation: low principal can NO LONGER see Bravo (restricted view)', async () => {
    const e = await low.getEntity('planetar:Vessel', B);
    if (e !== null) throw new Error('Bravo must be filtered out for low clearance');
    return 'filtered ✓';
  });
  await check('after propagation: high principal STILL sees Bravo', async () => {
    const e = await high.getEntity('planetar:Vessel', B);
    if (!e) throw new Error('high clearance should still see Bravo');
    return 'visible ✓';
  });
  await check('list reflects governance: low sees fewer rows than high', async () => {
    const lo = await low.listEntities('planetar:Vessel', {});
    const hi = await high.listEntities('planetar:Vessel', {});
    if (lo.length !== 1 || hi.length !== 2) throw new Error(`expected low=1 high=2, got low=${lo.length} high=${hi.length}`);
    if (lo[0].fields['planetar:owner'] !== undefined) throw new Error('owner should be redacted in low list');
    return `low sees ${lo.length} (owner redacted), high sees ${hi.length}`;
  });
  await check('audit captured the propagation as an immutable record', async () => {
    let n = 0; for await (const _ of audit.scan({ actor: 'system' })) n++;
    if (!n) throw new Error('no audit record'); return `${n} record(s)`;
  });

  console.log('\n=== Results ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.info}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} governance checks passed.`);
  await platform.closeAll();
  if (passed !== results.length) process.exit(1);
}
main().catch((e) => { console.error('GOVERNANCE DEMO FAILED:', e); process.exit(1); });
