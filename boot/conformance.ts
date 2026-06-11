// boot/conformance.ts — run the shared conformance suite over every built zero-service adapter,
// plus a broker zmesg-codec round-trip (no live broker needed).
//   run:  node --experimental-sqlite boot/conformance.ts   (npm run conformance)
import { rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import '../adapters/index.ts';
import { conform } from '../spine/conformance.ts';
import { zmesgEncode, zmesgDecode } from '../adapters/broker/stream.ts';
import type { RoleId } from '../spine/ports.ts';
import type { Json } from '../spine/model.ts';

const TARGETS: [RoleId, string, Record<string, Json>][] = [
  ['canonical-store', 'sqlite', { path: './.data/conf/cs.db' }],
  ['object-index', 'sqlite', { path: './.data/conf/ix.db' }],
  ['work-queue', 'sqlite', { path: './.data/conf/wq.db' }],
  ['stream', 'file', { path: './.data/conf/stream.wal' }],
  ['blob-cas', 'filesystem', { root: './.data/conf/blobs' }],
  ['audit-log', 'append-wal', { path: './.data/conf/audit.log' }],
  ['lineage', 'fs', { path: './.data/conf/lineage.jsonl' }],
  ['registry', 'git-fs', { path: './.data/conf/registry' }],
  ['policy-identity', 'internal', { clearances: ['UNCLASS'] }],
  ['hot-cache', 'in-process', {}],
  ['vector', 'file', { path: './.data/conf/vec.json' }],
  ['graph', 'sqlite', { path: './.data/conf/graph.db' }],
  ['timeseries-geo', 'sqlite', { path: './.data/conf/ts.db' }],
];

async function main() {
  rmSync('./.data/conf', { recursive: true, force: true });
  console.log('=== Conformance suite (one suite, every adapter) ===');
  let pass = 0, total = 0;
  for (const [role, engine, config] of TARGETS) {
    const r = await conform(role, engine, config);
    total++; if (r.ok) pass++;
    const fails = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.info}`).join('; ');
    console.log(`  ${r.ok ? '✅' : '❌'} ${role}/${engine} — ${fails || `${r.checks.length} checks`}`);
  }

  // broker R3 adapter: validate the zmesg wire codec without a running broker
  const env = { id: '01890000-0000-7000-8000-0000000000ab', topic: 'vessel.ais.position', source: 'src:ais@1.0.0', schema: 'planetar:Observation', createdNs: BigInt(Date.now()) * 1_000_000n, correlationId: 'corr-1', payload: new Uint8Array([10, 20, 30, 40]) };
  const back = zmesgDecode(zmesgEncode(env));
  const codecOk = back.topic === env.topic && back.id === env.id && back.source === env.source && back.correlationId === env.correlationId && back.createdNs === env.createdNs && Buffer.compare(Buffer.from(back.payload), Buffer.from(env.payload)) === 0;
  total++; if (codecOk) pass++;
  console.log(`  ${codecOk ? '✅' : '❌'} stream/broker — zmesg codec round-trip (topic/id/source/corr/ts/payload preserved)`);

  console.log(`\n${pass}/${total} adapters conformant.`);
  if (pass !== total) process.exit(1);
}
main().catch((e) => { console.error('CONFORMANCE FAILED:', e); process.exit(1); });
