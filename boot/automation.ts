// boot/automation.ts — Phase 4 proof: the DECLARATIVE automation engine.
// A flow defined as pure data (trigger + steps) reacts to a bus envelope: condition gate →
// create a Case → invoke a kinetic Action → park a durable APPROVAL work item → a supervisor
// (role-gated) approves → the confirm action runs as the approver → full audit trail.
// This is Salesforce Flow + Approval Processes + Foundry Automate + Omni-Channel work items,
// one mechanism.   run: node --experimental-sqlite boot/automation.ts   (npm run automation)
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compile, type ClientManifest } from '../spine/compiler.ts';
import { KineticExecutor } from '../spine/kinetic.ts';
import { FlowEngine, type FlowDef, type FlowRun } from '../spine/flows.ts';
import '../adapters/index.ts';
import type { Principal } from '../spine/ports.ts';

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; info: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try { results.push({ name, ok: true, info: await fn() }); } catch (e) { results.push({ name, ok: false, info: (e as Error).message }); }
}

const MANIFEST: ClientManifest = {
  schema_version: '1.0',
  client: { id: 'automation-demo', name: 'Declarative Automation Demo', tier: 'standard' },
  capabilities: ['kinetic-writes', 'automation-flow', 'watchlists-alerting', 'audit'],
  roles: {
    'canonical-store': { engine: 'sqlite', config: { path: './.data/auto/canonical.db' } },
    'registry': { engine: 'git-fs', config: { path: './.data/auto/registry' } },
    'audit-log': { engine: 'append-wal', config: { path: './.data/auto/audit.log' } },
    'stream': { engine: 'file', config: { path: './.data/auto/stream.wal' } },
    'work-queue': { engine: 'sqlite', config: { path: './.data/auto/work.db' } },
    'policy-identity': { engine: 'internal', config: { clearances: ['UNCLASS'] } },
  },
};

const AUTOMATION: Principal = { id: 'automation', roles: ['automation'], clearances: ['UNCLASS'] };
const ANALYST: Principal = { id: 'analyst-1', roles: ['operator'], clearances: ['UNCLASS'] };
const SUPERVISOR: Principal = { id: 'supervisor-1', roles: ['operator', 'supervisor'], clearances: ['UNCLASS'] };

async function main() {
  rmSync('./.data/auto', { recursive: true, force: true });
  console.log('\n=== Phase 4: declarative automation (flows as data) ===');
  const { platform } = await compile(MANIFEST);
  const store = platform.role('canonical-store');
  const stream = platform.role('stream');
  const audit = platform.role('audit-log');
  const work = platform.role('work-queue');

  // --- kinetic Action Types (P7): the only write path flows may use ---
  const kinetic = new KineticExecutor(platform);
  await kinetic.register({
    name: 'planetar:FlagVessel', targetType: 'planetar:Vessel',
    params: { reason: 'string' },
    preconditions: [{ field: 'planetar:status', op: 'eq', value: 'normal' }],
    effects: { set: { 'planetar:status': 'suspect', 'planetar:flag_reason': { param: 'reason' } } },
  });
  await kinetic.register({
    name: 'planetar:ConfirmDarkVessel', targetType: 'planetar:Vessel',
    preconditions: [{ field: 'planetar:status', op: 'eq', value: 'suspect' }],
    effects: { set: { 'planetar:status': 'dark-confirmed' } },
  });

  // --- the flow, as pure data (registrable / versionable / packageable) ---
  const FLOW: FlowDef = {
    id: 'dark-vessel-response',
    description: 'On AIS-lost anomaly: open a case, flag the vessel, require supervisor approval to confirm.',
    trigger: { kind: 'stream', topics: ['vessel.anomaly'] },
    steps: [
      { kind: 'condition', path: 'payload.kind', op: 'eq', value: 'ais_lost' },
      { kind: 'createEntity', type: 'planetar:Case', saveAs: 'case',
        fields: { 'planetar:subject': { from: 'payload.mmsi' }, 'planetar:status': 'open', 'planetar:opened_by': 'flow' } },
      { kind: 'action', action: 'planetar:FlagVessel', targetIdFrom: 'payload.vesselId', params: { reason: { from: 'payload.kind' } } },
      { kind: 'approval', role: 'supervisor', prompt: 'Confirm dark vessel?',
        onApprove: { action: 'planetar:ConfirmDarkVessel', targetIdFrom: 'payload.vesselId' } },
    ],
  };
  const engine = new FlowEngine(platform, kinetic, AUTOMATION, nowNs);
  await engine.register(FLOW);

  const runs: FlowRun[] = [];
  void engine.start((r) => runs.push(r));   // consume the bus in the background

  // --- seed: a vessel previously ingested ---
  const V = randomUUID();
  await store.upsertEntity({ id: V, type: 'planetar:Vessel', ts: nowNs(), source: 'src:ais@1.0.0', schemaVersion: 0x010000,
    fields: { 'planetar:name': 'MV Shadow', 'planetar:status': 'normal' }, provenance: {}, markings: ['UNCLASS'] });

  const publish = (kind: string) => stream.publish({
    id: randomUUID(), topic: 'vessel.anomaly', source: 'src:detector@1.0.0', schema: 'planetar:Anomaly',
    createdNs: nowNs(), payload: new TextEncoder().encode(JSON.stringify({ kind, vesselId: V, mmsi: '316009999' })),
  });

  await check('non-matching envelope exits at the condition gate', async () => {
    await publish('speeding'); await sleep(80);
    const r = runs.find((x) => x.status === 'exited-on-condition');
    if (!r || runs.length !== 1) throw new Error(`expected 1 exited run, got ${JSON.stringify(runs.map((x) => x.status))}`);
    return r.detail ?? 'exited';
  });

  await check('matching envelope: case created + vessel flagged + approval parked', async () => {
    await publish('ais_lost'); await sleep(80);
    const r = runs.find((x) => x.status === 'awaiting-approval');
    if (!r) throw new Error(`no awaiting-approval run: ${JSON.stringify(runs.map((x) => x.status))}`);
    const cases = await store.listEntities('planetar:Case', {});
    if (cases.items.length !== 1 || cases.items[0].fields['planetar:subject'] !== '316009999') throw new Error('case not created from payload');
    const v = await store.getEntity('planetar:Vessel', V);
    if (v?.fields['planetar:status'] !== 'suspect') throw new Error(`vessel status = ${v?.fields['planetar:status']}`);
    return `case ${cases.items[0].id.slice(0, 18)}…, vessel=suspect, approval job ${r.detail}`;
  });

  const jobId = runs.find((x) => x.status === 'awaiting-approval')!.detail!;

  await check('approval is a durable work item (omni-channel console can claim it)', async () => {
    const claimed = await work.claim('approval-desk', 10);
    const j = claimed.find((x) => x.id === jobId);
    if (!j || j.kind !== 'approval') throw new Error('approval job not in the durable queue');
    return `claimed '${(j.payload as { prompt: string }).prompt}' for role ${(j.payload as { role: string }).role}`;
  });

  await check('kinetic precondition guard: re-flagging a suspect vessel is rejected', async () => {
    const r = await kinetic.invoke('planetar:FlagVessel', { targetId: V, params: { reason: 'again' } }, AUTOMATION, nowNs());
    if (r.ok) throw new Error('should have failed precondition');
    return r.reason ?? 'rejected';
  });

  await check('role gate: analyst (no supervisor role) cannot approve', async () => {
    const r = await engine.approve(jobId, ANALYST, true);
    if (r.status !== 'failed') throw new Error('analyst approval should fail');
    const v = await store.getEntity('planetar:Vessel', V);
    if (v?.fields['planetar:status'] !== 'suspect') throw new Error('status must be unchanged');
    return r.detail ?? 'denied';
  });

  await check('supervisor approves → confirm action runs AS the approver → flow completes', async () => {
    const r = await engine.approve(jobId, SUPERVISOR, true);
    if (r.status !== 'completed') throw new Error(`expected completed, got ${r.status}: ${r.detail}`);
    const v = await store.getEntity('planetar:Vessel', V);
    if (v?.fields['planetar:status'] !== 'dark-confirmed') throw new Error(`status = ${v?.fields['planetar:status']}`);
    return 'vessel status = dark-confirmed';
  });

  await check('audit trail captures the whole chain (case, flag, approval, confirm)', async () => {
    let flowWrites = 0, supervisorWrites = 0, denied = 0;
    for await (const rec of audit.scan({})) {
      if (rec.actor.startsWith('flow:')) flowWrites++;
      if (rec.actor === SUPERVISOR.id) supervisorWrites++;
      if (rec.actor === ANALYST.id) denied++;
    }
    if (!flowWrites || !supervisorWrites || !denied) throw new Error(`flow=${flowWrites} supervisor=${supervisorWrites} analystDenied=${denied}`);
    return `flow writes=${flowWrites}, supervisor writes=${supervisorWrites}, denied attempt logged=${denied}`;
  });

  await check('flow + action types are registered data (R10), not code', async () => {
    const reg = platform.role('registry');
    const flowDef = await reg.get('flow:dark-vessel-response');
    const actDef = await reg.get('planetar:FlagVessel');
    if (!flowDef || !actDef) throw new Error('definitions missing from registry');
    return `registry holds ${flowDef.name} + ${actDef.name}`;
  });

  console.log('\n=== Results ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.info}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} automation checks passed.`);
  engine.stop();
  await platform.closeAll();
  if (passed !== results.length) process.exit(1);
}
main().catch((e) => { console.error('AUTOMATION DEMO FAILED:', e); process.exit(1); });
