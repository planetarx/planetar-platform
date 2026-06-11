// spine/governance.ts — Phase 3: propagating security (the hardest-to-clone moat).
// Three pieces: (1) MarkingPolicy = a real PEP MarkingResolver (no-read-up + FLS redaction);
// (2) Session = governed reads that filter rows + redact fields per principal;
// (3) propagate = stamp a marking down the lineage closure so "defined once at source" flows
// to every derived entity. In-process here; the production swap is Keycloak (authn) + OPA
// (policy) behind the same MarkingResolver/PolicyIdentity ports — no spine change.
import type { BoundPlatform } from './contracts.ts';
import type { MarkingResolver, Principal, CanonicalStore } from './ports.ts';
import type { CanonicalEntity, TypeName, EntityId, FieldName, Json, MarkingId, EntityQuery } from './model.ts';

/** Field-level security map: type → field → marking required to SEE that field. */
export type FlsMap = Record<TypeName, Record<FieldName, MarkingId>>;

/** A concrete MarkingResolver: no-read-up visibility + per-field FLS redaction. */
export class MarkingPolicy implements MarkingResolver {
  private fls: FlsMap;
  constructor(fls: FlsMap = {}) { this.fls = fls; }

  /** principal may see data iff it holds EVERY marking on it (mandatory access control). */
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
}

/** A per-principal governed view of the platform. Reads go through the PEP; writes still go via P7. */
export class Session {
  private platform: BoundPlatform;
  private principal: Principal;
  private policy: MarkingResolver;
  constructor(platform: BoundPlatform, principal: Principal, policy: MarkingResolver) {
    this.platform = platform; this.principal = principal; this.policy = policy;
  }
  private store(): CanonicalStore { return this.platform.role('canonical-store'); }

  /** row-level filter + field-level redaction on a single read. */
  async getEntity(type: TypeName, id: EntityId): Promise<CanonicalEntity | null> {
    const e = await this.store().getEntity(type, id);
    if (!e) return null;
    if (!this.policy.visible(this.principal, e.markings ?? [])) return null;           // restricted view
    return { ...e, fields: this.policy.redactFields(this.principal, type, e.fields) }; // FLS
  }
  /** same enforcement applied to a list. */
  async listEntities(type: TypeName, q: EntityQuery): Promise<CanonicalEntity[]> {
    const page = await this.store().listEntities(type, q);
    return page.items
      .filter((e) => this.policy.visible(this.principal, e.markings ?? []))
      .map((e) => ({ ...e, fields: this.policy.redactFields(this.principal, type, e.fields) }));
  }
}

/** Lineage ref convention: `${type}/${id}` for entities, plain id for sources/observations. */
export function entityRef(type: TypeName, id: EntityId): string { return `${type}/${id}`; }
function parseRef(ref: string): { type: TypeName; id: EntityId } | null {
  const i = ref.indexOf('/'); return i === -1 ? null : { type: ref.slice(0, i), id: ref.slice(i + 1) };
}

/**
 * THE moat: apply `markings` at `ref` and propagate along the lineage closure, stamping every
 * downstream CANONICAL ENTITY's `markings` (union). Returns the entity refs actually re-stamped.
 */
export async function propagate(platform: BoundPlatform, ref: string, markings: MarkingId[]): Promise<string[]> {
  const lineage = platform.role('lineage');
  const store: CanonicalStore = platform.role('canonical-store');
  const closure = await lineage.propagateMarking(ref, markings);   // records propagation edges + returns downstream refs
  const stamped: string[] = [];
  for (const r of closure) {
    const parsed = parseRef(r);
    if (!parsed) continue;                                          // skip non-entity refs (sources/observations)
    const e = await store.getEntity(parsed.type, parsed.id);
    if (!e) continue;
    const next = [...new Set([...(e.markings ?? []), ...markings])];
    if (next.length !== (e.markings ?? []).length) {
      e.markings = next;
      await store.upsertEntity(e);                                 // re-project with the inherited marking
      stamped.push(r);
    }
  }
  return stamped;
}
