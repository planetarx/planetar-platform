// spine/kinetic.ts — the KINETIC layer (P7): Action Types as the ONLY sanctioned write path.
// An Action Type is a registered, typed, precondition-guarded, audited mutation. Humans, flows
// (spine/flows.ts), and AI agents all mutate state exclusively through invoke() — that is how
// AIP/Agentforce containment works: an agent gets a list of Action Types, nothing else.
import type { BoundPlatform } from './contracts.ts';
import type { Principal } from './ports.ts';
import type { TypeName, EntityId, FieldName, Json, MarkingId, FilterOp, CanonicalEntity } from './model.ts';
import type { SystemPlatform } from './system.ts';
import { entityRef, union } from './governance.ts';

export interface ActionTypeDef {
  name: TypeName;                                   // 'planetar:ConfirmDarkVessel'
  targetType: TypeName;                             // entity type this action mutates
  params?: Record<string, 'string' | 'number' | 'boolean'>;
  /** all must hold on the CURRENT target entity or the invoke is rejected */
  preconditions?: { field: FieldName; op: FilterOp; value: Json }[];
  /** fields written on success; a value of {param:'x'} pulls from invocation params */
  effects: { set: Record<FieldName, Json | { param: string }> };
  /** clearances required to invoke (in addition to seeing the target) */
  requiresMarking?: MarkingId[];
}

export interface ActionInvocation {
  targetId: EntityId;
  params?: Record<string, Json>;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  /** the entity after the write, redacted for the principal who invoked it */
  entity?: CanonicalEntity;
}

/** A new entity to create through the gate. */
export interface CreateSpec {
  type: TypeName;
  id: EntityId;
  fields: Record<FieldName, Json>;
  markings?: MarkingId[];
}

/** What caused a create (the triggering envelope): its markings are inherited and it becomes
 *  the new entity's lineage parent. */
export interface Cause {
  envelopeId: string;
  markings?: MarkingId[];
}

export function matchOp(actual: Json | undefined, op: FilterOp, expected: Json): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual as Json);
    case 'contains': return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'exists': return (actual !== undefined && actual !== null) === Boolean(expected);
    default: return false;
  }
}

export class KineticExecutor {
  private platform: BoundPlatform;
  private sys: SystemPlatform;
  private defs = new Map<TypeName, ActionTypeDef>();
  private seq = 0;
  constructor(platform: BoundPlatform) { this.platform = platform; this.sys = platform.system('kinetic'); }

  private nextEventId(): string { return `00000000-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`; }
  private redacted(e: CanonicalEntity, principal: Principal): CanonicalEntity {
    return { ...e, fields: this.platform.policy.redactFields(principal, e.type, e.fields) };
  }

  /** Register an Action Type (also persisted to the R10 registry for provenance/discovery). */
  async register(def: ActionTypeDef): Promise<void> {
    this.defs.set(def.name, def);
    await this.sys.role('registry').put({
      id: `action-${def.name.replace(/[:/]/g, '_')}`, type: 'core:ActionType',
      ts: 0n, source: 'platform', schemaVersion: 0x010000,
      name: def.name, semver: '1.0.0', jsonSchema: def as unknown as Json,
    });
  }

  list(): ActionTypeDef[] { return [...this.defs.values()]; }

  /** The governed write path: authorize → load → preconditions → effects (tx) → audit + event. */
  async invoke(actionName: TypeName, inv: ActionInvocation, principal: Principal, nowNs: bigint): Promise<ActionResult> {
    const def = this.defs.get(actionName);
    if (!def) return { ok: false, reason: `unknown action ${actionName}` };

    // typed-param validation
    for (const [p, t] of Object.entries(def.params ?? {})) {
      const v = inv.params?.[p];
      if (v === undefined) return { ok: false, reason: `missing param '${p}'` };
      if (typeof v !== t) return { ok: false, reason: `param '${p}' must be ${t}` };
    }

    // A target the principal cannot see is reported exactly like a missing one: the gate must
    // not confirm that a restricted entity exists.
    const notFound: ActionResult = { ok: false, reason: `target ${def.targetType}/${inv.targetId} not found` };
    if (!await this.platform.as(principal).role('canonical-store').getEntity(def.targetType, inv.targetId)) return notFound;
    const store = this.sys.role('canonical-store');
    const target = await store.getEntity(def.targetType, inv.targetId);
    if (!target) return notFound;

    // governance gate: principal must hold the action's markings AND the target's markings
    const policy = this.sys.role('policy-identity');
    const need = [...new Set([...(def.requiresMarking ?? []), ...(target.markings ?? [])])];
    const decision = await policy.authorize(principal, `action:${actionName}`, { type: def.targetType, id: inv.targetId, markings: need });
    if (!decision.allow) return { ok: false, reason: decision.reason ?? 'denied' };

    // preconditions against current state
    for (const pre of def.preconditions ?? []) {
      if (!matchOp(target.fields[pre.field], pre.op, pre.value)) {
        // on a field the principal cannot read, say which check failed but not against what
        const readable = this.platform.policy.canUseField(principal, def.targetType, pre.field);
        return { ok: false, reason: `precondition failed: ${pre.field} ${pre.op}${readable ? ` ${JSON.stringify(pre.value)}` : ''}` };
      }
    }

    // effects, atomically
    const updated = await store.transaction(async () => {
      for (const [field, raw] of Object.entries(def.effects.set)) {
        const value = raw !== null && typeof raw === 'object' && 'param' in raw ? inv.params?.[(raw as { param: string }).param] ?? null : raw as Json;
        target.fields[field] = value;
      }
      target.ts = nowNs;
      await store.upsertEntity(target);
      return target;
    });

    // audit + event on the bus (a human decision is just an envelope, like a sensor reading).
    // Both carry the invocation params, so when the action writes a protected field they take
    // that field's marking too: otherwise the value would be readable in the target's audit
    // trail and events by a principal who cannot read it on the entity.
    const written = Object.keys(def.effects.set).flatMap((f) => this.platform.policy.fieldMarking(def.targetType, f) ?? []);
    const recordMarkings = union(updated.markings, written);
    await this.sys.role('audit-log').append({
      ts: nowNs, actor: principal.id, action: 'write',
      resource: `${def.targetType}/${inv.targetId}`,
      detail: { action: actionName, params: inv.params ?? {} }, markings: recordMarkings,
    });
    await this.sys.role('stream').publish({
      id: this.nextEventId(),
      topic: `action.${actionName.replace(/:/g, '.')}`, source: `principal:${principal.id}`,
      schema: 'core:Event', createdNs: nowNs, markings: recordMarkings,
      payload: new TextEncoder().encode(JSON.stringify({ action: actionName, target: inv.targetId, params: inv.params ?? {} })),
    });
    return { ok: true, entity: this.redacted(updated, principal) };
  }

  /**
   * The governed CREATE path (flows and agents use this; nothing writes entities directly).
   * The creator must hold every marking the new entity will carry: its own plus its cause's.
   * Never overwrites: an existing id is refused.
   */
  async createEntity(spec: CreateSpec, principal: Principal, nowNs: bigint, cause?: Cause): Promise<ActionResult> {
    const markings = union(spec.markings, cause?.markings);
    // one wording for every refusal that is not "you can see it and it exists", so a refusal on an
    // id the creator cannot see says nothing about whether that id exists
    const denied: ActionResult = { ok: false, reason: `create:${spec.type} denied` };
    const decision = await this.sys.role('policy-identity').authorize(principal, `create:${spec.type}`, { type: spec.type, id: spec.id, markings });
    if (!decision.allow) return denied;

    const store = this.sys.role('canonical-store');
    const existing = await store.getEntity(spec.type, spec.id);
    if (existing) return this.platform.policy.visible(principal, existing.markings ?? []) ? { ok: false, reason: `${spec.type}/${spec.id} already exists` } : denied;
    await store.upsertEntity({
      id: spec.id, type: spec.type, ts: nowNs, source: `principal:${principal.id}`, schemaVersion: 0x010000,
      fields: spec.fields, provenance: {}, markings, causationId: cause?.envelopeId,
    });
    const ref = entityRef(spec.type, spec.id);
    if (cause && this.sys.has('lineage')) await this.sys.role('lineage').record({ upstream: cause.envelopeId, downstream: ref, kind: 'transform', markings: cause.markings });
    const created = (await store.getEntity(spec.type, spec.id))!;   // re-read: lineage may have added markings

    await this.sys.role('audit-log').append({
      ts: nowNs, actor: principal.id, action: 'write', resource: ref,
      detail: { action: 'create', cause: cause?.envelopeId ?? null }, markings: created.markings,
    });
    await this.sys.role('stream').publish({
      id: this.nextEventId(), topic: `action.create.${spec.type.replace(/:/g, '.')}`, source: `principal:${principal.id}`,
      schema: 'core:Event', createdNs: nowNs, markings: created.markings, causationId: cause?.envelopeId,
      payload: new TextEncoder().encode(JSON.stringify({ action: 'create', target: spec.id })),
    });
    return { ok: true, entity: this.redacted(created, principal) };
  }
}
