// spine/kinetic.ts — the KINETIC layer (P7): Action Types as the ONLY sanctioned write path.
// An Action Type is a registered, typed, precondition-guarded, audited mutation. Humans, flows
// (spine/flows.ts), and AI agents all mutate state exclusively through invoke() — that is how
// AIP/Agentforce containment works: an agent gets a list of Action Types, nothing else.
import type { BoundPlatform } from './contracts.ts';
import type { Principal } from './ports.ts';
import type { TypeName, EntityId, FieldName, Json, MarkingId, FilterOp, CanonicalEntity } from './model.ts';

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
  entity?: CanonicalEntity;
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
  private defs = new Map<TypeName, ActionTypeDef>();
  private seq = 0;
  constructor(platform: BoundPlatform) { this.platform = platform; }

  /** Register an Action Type (also persisted to the R10 registry for provenance/discovery). */
  async register(def: ActionTypeDef): Promise<void> {
    this.defs.set(def.name, def);
    await this.platform.role('registry').put({
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

    const store = this.platform.role('canonical-store');
    const target = await store.getEntity(def.targetType, inv.targetId);
    if (!target) return { ok: false, reason: `target ${def.targetType}/${inv.targetId} not found` };

    // governance gate: principal must hold the action's markings AND the target's markings
    const policy = this.platform.role('policy-identity');
    const need = [...new Set([...(def.requiresMarking ?? []), ...(target.markings ?? [])])];
    const decision = await policy.authorize(principal, `action:${actionName}`, { type: def.targetType, id: inv.targetId, markings: need });
    if (!decision.allow) return { ok: false, reason: decision.reason ?? 'denied' };

    // preconditions against current state
    for (const pre of def.preconditions ?? []) {
      if (!matchOp(target.fields[pre.field], pre.op, pre.value)) {
        return { ok: false, reason: `precondition failed: ${pre.field} ${pre.op} ${JSON.stringify(pre.value)}` };
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

    // audit + event on the bus (a human decision is just an envelope, like a sensor reading)
    await this.platform.role('audit-log').append({
      ts: nowNs, actor: principal.id, action: 'write',
      resource: `${def.targetType}/${inv.targetId}`,
      detail: { action: actionName, params: inv.params ?? {} }, markings: target.markings,
    });
    await this.platform.role('stream').publish({
      id: `00000000-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`,
      topic: `action.${actionName.replace(/:/g, '.')}`, source: `principal:${principal.id}`,
      schema: 'core:Event', createdNs: nowNs, markings: target.markings,
      payload: new TextEncoder().encode(JSON.stringify({ action: actionName, target: inv.targetId, params: inv.params ?? {} })),
    });
    return { ok: true, entity: updated };
  }
}
