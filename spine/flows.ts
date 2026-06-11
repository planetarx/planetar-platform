// spine/flows.ts — the DECLARATIVE automation engine (Flow Builder / Process / Approvals /
// Foundry Automate parity). A flow is DATA, not code: a registered trigger + step list. The
// engine consumes the stream (R3), evaluates steps, mutates only through the kinetic executor
// (P7), and parks approval gates as durable work items (R14) that a human resumes — i.e.
// Omni-Channel routing and Approval Processes fall out of the same mechanism.
import type { BoundPlatform } from './contracts.ts';
import type { Principal, Envelope, TopicPattern, JobId } from './ports.ts';
import type { TypeName, FieldName, Json, FilterOp } from './model.ts';
import { KineticExecutor, matchOp } from './kinetic.ts';

// ---------------------------------------------------------------------------
// Flow definitions (pure data — registrable, versionable, packageable)
// ---------------------------------------------------------------------------

/** `{from:'payload.mmsi'}` pulls a dotted path out of the run context at execution time. */
export type Binding = Json | { from: string };

export type FlowStep =
  | { kind: 'condition'; path: string; op: FilterOp; value: Json }                 // false → run exits
  | { kind: 'createEntity'; type: TypeName; idFrom?: string; fields: Record<FieldName, Binding>; markings?: string[]; saveAs?: string }
  | { kind: 'action'; action: TypeName; targetIdFrom: string; params?: Record<string, Binding> }
  | { kind: 'approval'; role: string; prompt: string; onApprove: { action: TypeName; targetIdFrom: string; params?: Record<string, Binding> } };

export interface FlowDef {
  id: string;
  description?: string;
  trigger: { kind: 'stream'; topics: TopicPattern[] };
  steps: FlowStep[];
}

export interface FlowRun {
  runId: string;
  flowId: string;
  status: 'completed' | 'exited-on-condition' | 'awaiting-approval' | 'failed';
  detail?: string;
  context: Record<string, Json>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function topicMatches(topic: string, patterns: TopicPattern[]): boolean {
  return patterns.some((p) => {
    if (p === '**') return true;
    const rx = '^' + p.split('.').map((seg) =>
      seg === '**' ? '.*' : seg === '*' ? '[^.]*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('\\.') + '$';
    return new RegExp(rx).test(topic);
  });
}

function pluck(ctx: Record<string, Json>, path: string): Json | undefined {
  let cur: Json | undefined = ctx as Json;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, Json>)[part];
  }
  return cur;
}

function resolve(ctx: Record<string, Json>, b: Binding): Json {
  return b !== null && typeof b === 'object' && !Array.isArray(b) && 'from' in b && typeof (b as { from: unknown }).from === 'string'
    ? pluck(ctx, (b as { from: string }).from) ?? null
    : b as Json;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface PendingApproval {
  jobId: JobId;
  flow: FlowDef;
  stepIndex: number;                 // index of the approval step
  context: Record<string, Json>;
  runId: string;
  role: string;
}

export class FlowEngine {
  private platform: BoundPlatform;
  private kinetic: KineticExecutor;
  private flows: FlowDef[] = [];
  private pending = new Map<JobId, PendingApproval>();
  private runSeq = 0;
  private nowNs: () => bigint;
  /** the principal flows run as for non-approval steps (the "automation user") */
  private automationUser: Principal;
  private stopped = false;

  constructor(platform: BoundPlatform, kinetic: KineticExecutor, automationUser: Principal, nowNs: () => bigint) {
    this.platform = platform; this.kinetic = kinetic; this.automationUser = automationUser; this.nowNs = nowNs;
  }

  /** Register a flow (also persisted to the R10 registry — flows are data like schemas). */
  async register(flow: FlowDef): Promise<void> {
    this.flows.push(flow);
    await this.platform.role('registry').put({
      id: `flow-${flow.id}`, type: 'core:FlowDefinition', ts: 0n, source: 'platform',
      schemaVersion: 0x010000, name: `flow:${flow.id}`, semver: '1.0.0',
      jsonSchema: flow as unknown as Json,
    });
  }

  /** Consume the stream and trigger matching flows. Returns the runs it executed (resolves on stop()). */
  async start(onRun?: (run: FlowRun) => void): Promise<void> {
    const topics = [...new Set(this.flows.flatMap((f) => f.trigger.topics))];
    const sub = this.platform.role('stream').subscribe(topics, 'latest');
    for await (const env of sub) {
      if (this.stopped) break;
      for (const flow of this.flows) {
        if (!topicMatches(env.topic, flow.trigger.topics)) continue;
        const run = await this.execute(flow, env);
        onRun?.(run);
      }
    }
  }
  stop(): void { this.stopped = true; }

  /** Execute one flow run from a triggering envelope (resumable at approval gates). */
  private async execute(flow: FlowDef, env: Envelope): Promise<FlowRun> {
    let payload: Json = null;
    try { payload = JSON.parse(new TextDecoder().decode(env.payload)) as Json; } catch { payload = null; }
    const context: Record<string, Json> = { topic: env.topic, source: env.source, payload };
    const runId = `${flow.id}#${++this.runSeq}`;
    return this.runSteps(flow, 0, context, runId);
  }

  private async runSteps(flow: FlowDef, from: number, context: Record<string, Json>, runId: string): Promise<FlowRun> {
    for (let i = from; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      if (step.kind === 'condition') {
        if (!matchOp(pluck(context, step.path) ?? null, step.op, step.value)) {
          return { runId, flowId: flow.id, status: 'exited-on-condition', detail: `${step.path} ${step.op} ${JSON.stringify(step.value)}`, context };
        }
      } else if (step.kind === 'createEntity') {
        const id = (step.idFrom ? String(pluck(context, step.idFrom)) : `${flow.id}-${runId}`);
        const fields: Record<FieldName, Json> = {};
        for (const [k, b] of Object.entries(step.fields)) fields[k] = resolve(context, b);
        const store = this.platform.role('canonical-store');
        await store.upsertEntity({ id, type: step.type, ts: this.nowNs(), source: `flow:${flow.id}`, schemaVersion: 0x010000, fields, provenance: {}, markings: step.markings });
        await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: `flow:${flow.id}`, action: 'write', resource: `${step.type}/${id}`, detail: { runId } });
        if (step.saveAs) context[step.saveAs] = { id, type: step.type };
      } else if (step.kind === 'action') {
        const targetId = String(pluck(context, step.targetIdFrom) ?? '');
        const params: Record<string, Json> = {};
        for (const [k, b] of Object.entries(step.params ?? {})) params[k] = resolve(context, b);
        const r = await this.kinetic.invoke(step.action, { targetId, params }, this.automationUser, this.nowNs());
        if (!r.ok) return { runId, flowId: flow.id, status: 'failed', detail: `action ${step.action}: ${r.reason}`, context };
      } else if (step.kind === 'approval') {
        // park: durable work item (R14) + in-memory resume state; a human resumes via approve()
        const targetId = String(pluck(context, step.onApprove.targetIdFrom) ?? '');
        const params: Record<string, Json> = {};
        for (const [k, b] of Object.entries(step.onApprove.params ?? {})) params[k] = resolve(context, b);
        const jobId = await this.platform.role('work-queue').enqueue({
          kind: 'approval', payload: { flowId: flow.id, runId, prompt: step.prompt, role: step.role, action: step.onApprove.action, targetId, params },
        });
        this.pending.set(jobId, { jobId, flow, stepIndex: i, context, runId, role: step.role });
        await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: `flow:${flow.id}`, action: 'write', resource: `approval/${jobId}`, detail: { runId, prompt: step.prompt, role: step.role } });
        return { runId, flowId: flow.id, status: 'awaiting-approval', detail: jobId, context };
      }
    }
    return { runId, flowId: flow.id, status: 'completed', context };
  }

  /** Human resumes a parked approval. Role-gated; the approved action runs AS THE APPROVER. */
  async approve(jobId: JobId, principal: Principal, approved: boolean): Promise<FlowRun> {
    const p = this.pending.get(jobId);
    if (!p) return { runId: 'unknown', flowId: 'unknown', status: 'failed', detail: `no pending approval ${jobId}`, context: {} };
    if (!principal.roles.includes(p.role)) {
      await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: principal.id, action: 'admin', resource: `approval/${jobId}`, detail: { denied: `requires role ${p.role}` } });
      return { runId: p.runId, flowId: p.flow.id, status: 'failed', detail: `principal lacks role '${p.role}'`, context: p.context };
    }
    this.pending.delete(jobId);
    if (!approved) {
      await this.platform.role('work-queue').complete(jobId, { approved: false, by: principal.id });
      await this.platform.role('audit-log').append({ ts: this.nowNs(), actor: principal.id, action: 'write', resource: `approval/${jobId}`, detail: { approved: false } });
      return { runId: p.runId, flowId: p.flow.id, status: 'completed', detail: 'rejected', context: p.context };
    }
    const step = p.flow.steps[p.stepIndex];
    if (step.kind !== 'approval') return { runId: p.runId, flowId: p.flow.id, status: 'failed', detail: 'corrupt resume state', context: p.context };
    const targetId = String(pluck(p.context, step.onApprove.targetIdFrom) ?? '');
    const params: Record<string, Json> = {};
    for (const [k, b] of Object.entries(step.onApprove.params ?? {})) params[k] = resolve(p.context, b);
    const r = await this.kinetic.invoke(step.onApprove.action, { targetId, params }, principal, this.nowNs());
    await this.platform.role('work-queue').complete(jobId, { approved: true, by: principal.id, actionOk: r.ok });
    if (!r.ok) return { runId: p.runId, flowId: p.flow.id, status: 'failed', detail: `approved action failed: ${r.reason}`, context: p.context };
    // continue any steps after the approval gate
    return this.runSteps(p.flow, p.stepIndex + 1, p.context, p.runId);
  }

  pendingApprovals(): PendingApproval[] { return [...this.pending.values()]; }
}
