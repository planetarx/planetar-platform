// spine/governance.ts — Phase 3: propagating security (the hardest-to-clone moat).
// This file holds the POLICY (who may see what), the RULE TABLE (how every port method is
// classified) and propagate(). The read gate is spine/governed.ts; the write-side invariants
// are spine/system.ts. Design: docs/specs/2026-10-06-governed-ports-design.md.
import type { BoundPlatform } from './contracts.ts';
import type { MarkingResolver, Principal, RoleId, PortByRole, Adapter, IndexDoc } from './ports.ts';
import type { CanonicalEntity, TypeName, EntityId, FieldName, Json, MarkingId } from './model.ts';

/** Field-level security map: type → field → marking required to SEE that field. */
export type FlsMap = Record<TypeName, Record<FieldName, MarkingId>>;

/** Thrown when a governed call would be an oracle, needs in-engine enforcement, or names an unbound role. */
export class GovernanceError extends Error {}

/** The one visibility rule (spec §4.1): a principal sees a row iff it holds EVERY marking on it. */
export class MarkingPolicy implements MarkingResolver {
  private fls: FlsMap;
  constructor(fls: FlsMap = {}) { this.fls = fls; }

  visible(principal: Principal, markings: MarkingId[]): boolean {
    return (markings ?? []).every((m) => principal.clearances.includes(m));
  }

  /** drop fields whose FLS marking the principal lacks. */
  redactFields(principal: Principal, type: TypeName, fields: Record<FieldName, Json>): Record<FieldName, Json> {
    const rules = this.fls[type];
    if (!rules) return fields;
    const out: Record<FieldName, Json> = { ...fields };
    for (const [field, need] of Object.entries(rules)) if (!principal.clearances.includes(need)) delete out[field];
    return out;
  }

  /** the marking needed to see `field` of `type`, if the field is protected. */
  fieldMarking(type: TypeName, field: FieldName): MarkingId | undefined { return this.fls[type]?.[field]; }

  /** the types whose rules apply: the named type, or every type when it is unknown or has no rules
   *  of its own (a query may name a table rather than a type). */
  private typesFor(type: TypeName | undefined): TypeName[] {
    return type !== undefined && this.fls[type] ? [type] : Object.keys(this.fls);
  }

  /** is `field` protected on `type` — or, when the type is unknown, on any type? */
  protectsField(type: TypeName | undefined, field: FieldName): boolean {
    return this.typesFor(type).some((t) => this.fls[t][field] !== undefined);
  }

  /** may the principal filter, sort or aggregate on `field`? If not, the result would be an
   *  oracle for a value it cannot read. */
  canUseField(principal: Principal, type: TypeName | undefined, field: FieldName): boolean {
    return this.typesFor(type).every((t) => this.fls[t][field] === undefined || principal.clearances.includes(this.fls[t][field]));
  }

  /** every protected field removed, whoever asks — what a SHARED projection may hold. */
  publicFields(type: TypeName, fields: Record<FieldName, Json>): Record<FieldName, Json> {
    const rules = this.fls[type];
    if (!rules) return fields;
    const out: Record<FieldName, Json> = { ...fields };
    for (const field of Object.keys(rules)) delete out[field];
    return out;
  }
}

// ---------------------------------------------------------------------------
// The rule table (spec §4.3). EVERY port method is classified:
//   governed — callable by a principal, result filtered by spine/governed.ts
//   open     — callable by a principal, unfiltered
//   system   — not on the governed port; reachable only through platform.system()
// `satisfies` makes an unclassified or misspelled method a compile error.
// ---------------------------------------------------------------------------

export type Rule = 'governed' | 'open' | 'system';
type PortMethod<R extends RoleId> = Exclude<keyof PortByRole[R], keyof Adapter> & string;

export const GOVERNANCE_RULES = {
  'canonical-store': { getEntity: 'governed', listEntities: 'governed', getLinks: 'governed', putObservation: 'system', upsertEntity: 'system', putLink: 'system', transaction: 'system', markingsOf: 'system', addMarkings: 'system' },
  'hot-cache': { get: 'governed', set: 'governed', del: 'governed', incr: 'governed', publish: 'governed', subscribe: 'governed' },
  'stream': { subscribe: 'governed', publish: 'system', ack: 'system' },
  'object-index': { search: 'governed', aggregate: 'governed', index: 'system', remove: 'system', searchCandidates: 'system', setMarkings: 'system' },
  'graph': { neighbors: 'governed', shortestPath: 'governed', upsertNode: 'system', upsertEdge: 'system', query: 'system' },
  'blob-cas': { get: 'open', presignRead: 'open', put: 'system' },
  'vector': { knn: 'governed', upsert: 'system', remove: 'system' },
  'timeseries-geo': { range: 'governed', downsample: 'governed', within: 'governed', append: 'system' },
  'analytics-olap': { query: 'governed', registerExternal: 'system' },
  'registry': { loadAll: 'open', get: 'open', versions: 'open', put: 'system' },
  'audit-log': { scan: 'governed', export: 'governed', append: 'system' },
  'lineage': { upstreamOf: 'governed', downstreamOf: 'governed', record: 'system', propagateMarking: 'system', applyMarking: 'system', effectiveMarkings: 'system' },
  'policy-identity': { authenticate: 'open', authorize: 'open', members: 'open' },
  'work-queue': { claim: 'system', complete: 'system', fail: 'system', enqueue: 'system' },   // jobs carry no markings yet
} satisfies { [R in RoleId]: Record<PortMethod<R>, Rule> };

export function ruleFor(role: RoleId, method: string): Rule | undefined {
  return (GOVERNANCE_RULES[role] as Record<string, Rule>)[method];
}

// ---------------------------------------------------------------------------
// Helpers shared by the gate, the system handle and callers
// ---------------------------------------------------------------------------

export function union(...sets: (MarkingId[] | undefined)[]): MarkingId[] {
  return [...new Set(sets.flatMap((s) => s ?? []))];
}

/** Lineage ref convention: `${type}/${id}` for entities, plain id for sources/observations. */
export function entityRef(type: TypeName, id: EntityId): string { return `${type}/${id}`; }
export function parseRef(ref: string): { type: TypeName; id: EntityId } | null {
  const i = ref.indexOf('/'); return i === -1 ? null : { type: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** The index document for an entity: its markings, and NO protected field (spec §4.7). Build
 *  every shared projection row with this so a protected value is never searchable. */
export function indexDocFor(policy: MarkingPolicy, e: CanonicalEntity): IndexDoc {
  const fields = policy.publicFields(e.type, e.fields);
  return { id: e.id, type: e.type, text: Object.values(fields).map(String).join(' '), fields, markings: e.markings ?? [] };
}

/**
 * THE moat: apply `markings` at `ref`, once. They are persisted at the ref (so later derivations
 * inherit), stamped on every downstream entity and on its projections, and the act is audited.
 * Returns the entity refs that were actually re-stamped.
 */
export async function propagate(platform: BoundPlatform, ref: string, markings: MarkingId[], actor = 'system'): Promise<string[]> {
  const sys = platform.system('governance.propagate');
  const stamped = await sys.applyMarking(ref, markings);
  if (sys.has('audit-log')) {
    // the record names every stamped entity, so it carries all of their markings, not only the new one
    const ids = stamped.map((r) => parseRef(r)?.id).filter((x): x is EntityId => x !== undefined);
    const theirs = sys.has('canonical-store') ? Object.values(await sys.role('canonical-store').markingsOf(ids)).flat() : [];
    await sys.role('audit-log').append({ ts: platform.nowNs(), actor, action: 'admin', resource: ref, detail: { propagated: markings, to: stamped }, markings: union(markings, theirs) });
  }
  return stamped;
}
