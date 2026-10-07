// boot/governance.ts — Phase 3 proof: no ungoverned read or write path.
// Compiles one client with every data role bound and runs the adversarial suite
// (spine/governance-conformance.ts) against it.
//   run:  node --experimental-sqlite boot/governance.ts   (npm run governance)
import { rmSync } from 'node:fs';
import { compile, type ClientManifest } from '../spine/compiler.ts';
import { governanceSuite, SUITE } from '../spine/governance-conformance.ts';
import '../adapters/index.ts';

const D = './.data/gov';
const MANIFEST: ClientManifest = {
  schema_version: '1.0',
  client: { id: 'gov-demo', name: 'Governed-Ports Proof', tier: 'standard' },
  capabilities: ['kinetic-writes', 'identity-resolution', 'propagating-security', 'audit', 'search', 'link-analysis', 'geotemporal', 'reporting-olap', 'automation-flow', 'omnichannel-routing'],
  roles: {
    'canonical-store': { engine: 'sqlite', config: { path: `${D}/canonical.db` } },
    'object-index': { engine: 'sqlite', config: { path: `${D}/index.db` } },
    'graph': { engine: 'sqlite', config: { path: `${D}/graph.db` } },
    'vector': { engine: 'file', config: { path: `${D}/vectors.json` } },
    'timeseries-geo': { engine: 'sqlite', config: { path: `${D}/tracks.db` } },
    'analytics-olap': { engine: 'sqlite', config: { path: `${D}/canonical.db` } },   // reports over the live entity table
    'hot-cache': { engine: 'in-process', config: {} },
    'work-queue': { engine: 'sqlite', config: { path: `${D}/work.db` } },
    'registry': { engine: 'git-fs', config: { path: `${D}/registry` } },
    'audit-log': { engine: 'append-wal', config: { path: `${D}/audit.log` } },
    'stream': { engine: 'file', config: { path: `${D}/stream.wal` } },
    'lineage': { engine: 'fs', config: { path: `${D}/lineage.jsonl` } },
    'policy-identity': { engine: 'internal', config: { clearances: ['UNCLASS'] } },
  },
  governance: {
    markings: [{ id: SUITE.PUBLIC, default: true }, { id: SUITE.RESTRICTED }],
    propagate: 'lineage',
    fls: { [SUITE.type]: { [SUITE.owner]: SUITE.RESTRICTED } },
  },
};

// A client that binds only the five roles kinetic writes need, with read auditing off: the gate
// and the write-side invariants must work when lineage, index, graph, cache and the rest are absent.
const MINIMAL: ClientManifest = {
  schema_version: '1.0',
  client: { id: 'gov-minimal', name: 'Governed-Ports Proof (minimal roles)', tier: 'edge' },
  capabilities: ['kinetic-writes', 'audit'],
  roles: {
    'canonical-store': { engine: 'sqlite', config: { path: `${D}/min/canonical.db` } },
    'registry': { engine: 'git-fs', config: { path: `${D}/min/registry` } },
    'audit-log': { engine: 'append-wal', config: { path: `${D}/min/audit.log` } },
    'stream': { engine: 'file', config: { path: `${D}/min/stream.wal` } },
    'policy-identity': { engine: 'internal', config: { clearances: ['UNCLASS'] } },
  },
  governance: { fls: { [SUITE.type]: { [SUITE.owner]: SUITE.RESTRICTED } }, audit: { reads: 'none' } },
};

async function main() {
  rmSync(D, { recursive: true, force: true });
  console.log('\n=== Phase 3: governed ports (adversarial suite) ===');
  const { platform } = await compile(MANIFEST);
  const results = await governanceSuite(platform);

  const minimal = (await compile(MINIMAL)).platform;
  for (const r of await governanceSuite(minimal)) {
    // with read auditing off there is no read trail to assert on; every other check must hold
    if (r.name.startsWith('audit: a marked read is recorded')) continue;
    results.push({ ...r, name: `[minimal roles] ${r.name}` });
  }
  let reads = 0; for await (const rec of minimal.system('governance-demo').role('audit-log').scan({})) if (rec.action === 'read') reads++;
  results.push({ name: '[minimal roles] governance.audit.reads = none writes no read records', ok: reads === 0, info: `${reads} read record(s)` });
  await minimal.closeAll();
  console.log('\n=== Results ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.info}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} governance checks passed.`);
  await platform.closeAll();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error('GOVERNANCE SUITE FAILED:', e); process.exit(1); });
