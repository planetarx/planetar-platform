// tools/review-workflow.js — the adversarial multi-lens review of the runnable platform code.
// PROVENANCE: authored 2026-06-10 (session run wf_52cdcc1c-48b, stopped mid-verify by a machine
// shell wedge — never completed). Relaunch in any Claude Code session with the Workflow tool:
//   Workflow({ scriptPath: '<this file>' })
// 6 finder lenses → adversarial skeptic verification per finding → returns {confirmed, refutedCount}.
// The "known suspects" the lenses were seeded with (expect these to be confirmed):
//   - SqliteObjectIndex ignores markings → search/searchCandidates leak restricted entity ids
//   - FlowEngine createEntity writes directly to the store, bypassing the kinetic gate
//   - FlowEngine pending-approvals Map is in-memory only → approvals not restart-durable
//   - boot.ts rmSync('./.data') wipes ALL demos' data (collateral across manifests)
//   - FlowEngine.stop() doesn't unblock the awaited subscribe iterator until the next envelope
//   - BrokerStream: unhandled socket 'error' on pub path; subscribe sockets not closed by close()

export const meta = {
  name: 'platform-runnable-review',
  description: 'Adversarial multi-lens review of the runnable planetar-platform code (spine + adapters + boot)',
  phases: [
    { title: 'Review', detail: '6 lens-specific finders over the runnable TypeScript' },
    { title: 'Verify', detail: 'adversarial refutation of every finding' },
  ],
}

const ROOT = '/home/sness/github/planetarx/planetar-platform'

const COMMON = `
You are reviewing the RUNNABLE TypeScript of the Planetar Platform at ${ROOT}.
Scope (read these fully): ${ROOT}/spine/*.ts (model, ports, contracts, capabilities, compiler, conformance, governance, kinetic, flows, json, asyncqueue), ${ROOT}/adapters/**/*.ts (sqlite x6 + _db, file/stream, file/vector, fs x3, gitfs/registry, memory/cache, internal/policy-identity, broker/stream), ${ROOT}/boot/*.ts (boot, conformance, governance, automation) and boot/manifests/*.json.
Context docs (skim for intent): ${ROOT}/10-STORAGE-ROLES.md, ${ROOT}/12-ADAPTER-CONTRACT.md, ${ROOT}/13-CLIENT-MANIFEST.md, ${ROOT}/boot/README.md.
Runtime facts: Node 22 type-stripping (erasable TS only), node:sqlite (--experimental-sqlite), zero npm deps. You MAY run the demos to test hypotheses: cd ${ROOT} && node --experimental-sqlite boot/<x>.ts (they wipe ./.data themselves; do NOT modify any source files).
The five checks currently pass: boot:edge 9/9, boot:enterprise 13/13, conformance 14/14, governance 8/8, automation 8/8 — so look for what the happy-path checks DON'T cover.
Report findings ONLY in your lens. Quality bar: a finding must be concrete (file:line, what goes wrong, under what input/sequence) — no style nits, no 'consider adding tests', no hypotheticals that the architecture explicitly defers (e.g. Keycloak/OPA swap, production engines, live broker run are KNOWN deferred work; the in-process policy being permissive at edge is a DOCUMENTED stand-in).
Severity: high = wrong result/data loss/security bypass reachable through the public ports; medium = real bug needing an unusual-but-plausible sequence; low = latent hazard.
Max 10 findings, ranked. Your final message is data for an orchestrator.`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string', description: 'line number or range' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string', description: 'what goes wrong, under exactly what input/sequence' },
          fix: { type: 'string', description: 'suggested minimal fix' },
        },
        required: ['title', 'file', 'line', 'severity', 'description', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean', description: 'true only if the bug is reachable as described' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    severityAdjusted: { type: 'string', enum: ['high', 'medium', 'low', 'not-a-bug'] },
  },
  required: ['isReal', 'confidence', 'reasoning', 'severityAdjusted'],
}

const LENSES = [
  { key: 'correctness', prompt: `${COMMON}
LENS: pure logic correctness. Wrong comparisons/operators, off-by-one, bad cursor/pagination logic, incorrect SQL (escaping, NULL handling, type affinity TEXT-vs-INTEGER comparisons e.g. timestamps stored as TEXT), wrong regex (topic matching in adapters/file/stream.ts and spine/flows.ts), wrong byte offsets in the zmesg codec vs the layout documented in adapters/broker/stream.ts comments and zmesg.h (66-byte LE header: magic@0 ver@4 flags@5 hdrlen@6 id@8 created@24 stored@32 published@40 topiclen@48 srclen@50 schemalen@52 corrlen@54 causelen@56 schemaver@58 payloadlen@62), error swallowing that converts failures into wrong answers.` },
  { key: 'concurrency', prompt: `${COMMON}
LENS: async/concurrency. Floating promises (void engine.start), races between FlowEngine.start consumption and stop/closeAll, AsyncQueue waiter/buffer races or lost close, re-entrancy of sqlite transaction() (nested BEGIN on one DatabaseSync connection — e.g. KineticExecutor.invoke inside store.transaction while another transaction is open; FlowEngine createEntity + kinetic.invoke interleavings), concurrent publish() during subscribe replay in file/stream, BrokerStream lazy pubSock connect races and write-before-connect, awaiting inside for-await while more pushes arrive, work-queue claim/complete races across processes (sqlite single-writer assumptions).` },
  { key: 'governance-bypass', prompt: `${COMMON}
LENS: governance bypass. Ways to read or write around the PEP through PUBLIC surfaces the code itself wires: Session filters reads, but does object-index search/searchCandidates leak restricted entity ids or field text to a low-clearance caller (SqliteObjectIndex stores doc.text/fields but never checks markings)? Does listEntities cursor/total leak existence? Does the kinetic executor's authorize cover createEntity steps in flows (FlowEngine createEntity writes DIRECTLY to the store, bypassing kinetic)? Can approve() be replayed (jobId reuse), or the pending Map diverge from the durable queue (restart = approvals lost — in-memory Map is the only resume state)? Does propagate() in governance.ts re-stamp entities but NOT their object-index copies (stale index rows still searchable)? Audit gaps: which mutations produce NO audit record?` },
  { key: 'contract-drift', prompt: `${COMMON}
LENS: drift between code and its own contracts. Compare adapters' declared AdapterCapabilities against ROLE_CONTRACT in spine/contracts.ts and the role definitions in 10-STORAGE-ROLES.md (e.g. sqlite work-queue declares rebuildable:false — does satisfies() even check isSourceOfRecord?; file vector durable:true but flush rewrites whole JSON non-atomically). Compare port semantics promised in 12-ADAPTER-CONTRACT.md vs implementations (ObjectIndex.aggregate ignoring groupBy/metrics in sqlite; GraphStore.query returning empty; Stream.ack no-ops; Cache pub-sub optional methods unimplemented anywhere). Compare 13-CLIENT-MANIFEST.md compiler promises vs spine/compiler.ts behavior (illegal-collapse detection promised but not implemented; tier defaults). Flag where the BOOT README or roadmap claims something the code doesn't do.` },
  { key: 'data-integrity', prompt: `${COMMON}
LENS: data integrity round-trips. bigint handling: jstr/jparse __big envelopes vs plain JSON.parse usages (file/vector uses JSON.parse/stringify — what happens to bigint meta?), sqlite lastInsertRowid (number|bigint?) -> String() -> Number() round-trip in work-queue, ts stored as TEXT in entity/observation then compared/sorted, Number(p.ts / 1_000_000n) precision for far-future ns, zmesg codec: payload byte ranges, UUID hex without dashes round-trip, topic/source length truncation (>255 bytes, UTF-8 multibyte lengths using Buffer.byteLength vs .length), audit hash-chain: prevHash read at init but concurrent appends within one process, jstr of objects containing __big keys colliding with the sentinel, file/stream WAL replay parsing lines with embedded newlines in payload b64 (safe?) and JSON in topic strings.` },
  { key: 'robustness', prompt: `${COMMON}
LENS: resource/robustness. Socket and fd leaks (BrokerStream subscribe sockets never closed on close(); pubSock error handling — unhandled 'error' event crash on ECONNREFUSED), unbounded growth (AsyncQueue buffers when consumer is slow; FileStream subs array never pruned; readFileSync of entire WAL/audit/lineage on every scan — O(file) per call in propagateMarking's repeated downstreamOf), missing close() cleanup (FlowEngine subscription never terminated by stop() until next envelope arrives), process.exit paths skipping closeAll, rmSync('./.data') in boot.ts nuking ALL demo data including other demos' (boot.ts wipes ./.data while manifests use ./.data/edge and ./.data/ent — collateral), conformance suite leaving claimed-but-incomplete state.` },
]

phase('Review')
const reviewed = await pipeline(
  LENSES,
  (l) => agent(l.prompt, { label: `find:${l.key}`, phase: 'Review', schema: FINDINGS }),
  (rev, lens) => parallel((rev?.findings ?? []).slice(0, 10).map((f) => () =>
    agent(`You are an adversarial verifier for a code-review finding on the Planetar Platform runnable code at ${ROOT} (Node 22 type-stripping, node:sqlite, zero deps). Your DEFAULT position is that the finding is wrong — try hard to REFUTE it by reading the actual code and, if useful, running the demos (node --experimental-sqlite boot/<x>.ts from ${ROOT}; do not modify source).

FINDING (lens=${lens.key}):
  title: ${f.title}
  file: ${f.file}  line(s): ${f.line}
  severity claimed: ${f.severity}
  description: ${f.description}
  suggested fix: ${f.fix}

Check: (1) does the code actually read as described? (2) is the bad input/sequence reachable through the public ports/engine APIs as wired today (not through hypothetical production engines)? (3) is it explicitly documented as a deferred stand-in (boot/README.md 'honest notes', 90-ROADMAP.md) — if so it is NOT a bug, mark not-a-bug? (4) would the suggested fix actually be safe? Mark isReal=true ONLY if you failed to refute it on (1)+(2)+(3).`,
      { label: `verify:${lens.key}:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT })
      .then((v) => ({ ...f, lens: lens.key, verdict: v }))
  ))
)

const all = reviewed.filter(Boolean).flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict?.isReal && f.verdict?.severityAdjusted !== 'not-a-bug')
const rejected = all.length - confirmed.length
log(`review complete: ${all.length} findings, ${confirmed.length} confirmed, ${rejected} refuted`)
return {
  confirmed: confirmed.sort((a, b) => ['high', 'medium', 'low'].indexOf(a.verdict.severityAdjusted) - ['high', 'medium', 'low'].indexOf(b.verdict.severityAdjusted)),
  refutedCount: rejected,
}
