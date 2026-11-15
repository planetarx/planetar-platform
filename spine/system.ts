// spine/system.ts — the raw-port handle for spine internals, ingest and seeding.
// Everything here is the adapter itself, except five methods that are wrapped so that NO
// in-process writer can break the marking invariants (spec §4.1, §4.6):
//   I1  an entity's stored markings include every marking effective at its lineage ref
//   I2  stored markings never shrink, except on re-derivation under an approved declassification
//       (docs/specs/2026-11-15-governed-declassification-design.md)
// Lineage is the record of what must flow down; entity rows and projections are the result.
import type { RoleId, Adapter, PortByRole, CanonicalStore, Lineage, ObjectIndex, LineageEdge, IndexDoc, AuditLog } from './ports.ts';
import type { CanonicalEntity, MarkingId, TypeName, EntityId, Tx } from './model.ts';
import type { GovernanceConfig } from './contracts.ts';
import { GovernanceError, entityRef, parseRef, union } from './governance.ts';

type Bound = Partial<Record<RoleId, Adapter>>;

/** A view of `target` with some methods replaced; every other method stays bound to the adapter. */
function wrap<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const v: unknown = Reflect.get(t, prop, t);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

export class SystemPlatform {
  #bound: Bound;
  #gov: GovernanceConfig;
  /** who is holding the raw ports — every call site names itself (the suite checks the list). */
  readonly component: string;
  constructor(bound: Bound, component: string, gov: GovernanceConfig) { this.#bound = bound; this.component = component; this.#gov = gov; }

  has(r: RoleId): boolean { return !!this.#bound[r]; }

  role<R extends RoleId>(r: R): PortByRole[R] {
    const a = this.#bound[r];
    if (!a) throw new GovernanceError(`role ${r} is not bound in this client`);
    if (r === 'canonical-store') return wrap(a, {
      upsertEntity: (e: CanonicalEntity, tx?: Tx) => this.#upsertEntity(e, tx),
      removeMarkings: async () => { throw new GovernanceError('markings are removed only by re-derivation under an approved declassification (spine/declassify.ts)'); },
    }) as PortByRole[R];
    if (r === 'lineage') return wrap(a, {
      record: (edge: LineageEdge) => this.#record(edge),
      applyMarking: async (ref: string, markings: MarkingId[]) => { await this.applyMarking(ref, markings); },
      propagateMarking: async (ref: string, markings: MarkingId[]) => {
        const affected = await (a as Lineage).propagateMarking(ref, markings);   // persists at ref + records the closure
        await this.#stampDown(ref, markings);
        return affected;
      },
    }) as PortByRole[R];
    if (r === 'object-index') return wrap(a, {
      index: (type: TypeName, id: EntityId, doc: IndexDoc) => this.#index(type, id, doc),
    }) as PortByRole[R];
    return a as PortByRole[R];
  }

  /** Write a declassification request or approval. Only spine/declassify.ts may, after it has
   *  checked the requester, the approver and the policy decision. */
  async recordDeclassification(edge: LineageEdge): Promise<void> {
    if (this.component !== 'governance.declassify') throw new GovernanceError(`${this.component} may not write declassification records`);
    if (edge.kind !== 'unmark-request' && edge.kind !== 'unmark') throw new GovernanceError(`not a declassification record: ${edge.kind}`);
    const lineage = this.#bound['lineage'] as Lineage | undefined;
    if (!lineage) throw new GovernanceError('role lineage is not bound in this client');
    await lineage.record(edge);
  }

  /** Apply `markings` at `ref`: persist them there, then stamp `ref` (if it is an entity) and
   *  every entity downstream of it. Returns the entity refs whose markings grew. */
  async applyMarking(ref: string, markings: MarkingId[]): Promise<string[]> {
    const lineage = this.#bound['lineage'] as Lineage | undefined;
    if (lineage) await lineage.applyMarking(ref, markings);
    return this.#stampDown(ref, markings);
  }

  async #stampDown(ref: string, markings: MarkingId[]): Promise<string[]> {
    const lineage = this.#bound['lineage'] as Lineage | undefined;
    const refs = [ref, ...(lineage ? (await lineage.downstreamOf(ref, 64)).map((e) => e.downstream) : [])];
    const stamped: string[] = [];
    for (const r of new Set(refs)) {
      const ent = parseRef(r);
      if (!ent) continue;
      // a marking reaches a downstream ref only if it is effective there: an approved
      // declassification blocks it on one edge, and stamping must not jump that edge
      const reach = r === ref || !lineage ? markings : (await lineage.effectiveMarkings(r)).filter((m) => markings.includes(m));
      if (reach.length && await this.#stamp(ent.type, ent.id, reach)) stamped.push(r);
    }
    return stamped;
  }

  /** union `markings` into an existing entity and its projections; true if the set grew. The
   *  engine does it in one statement without touching fields, so a concurrent field write survives. */
  async #stamp(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<boolean> {
    const store = this.#bound['canonical-store'] as CanonicalStore | undefined;
    if (!store || !await store.addMarkings(type, id, markings)) return false;
    await this.#restamp(type, id, (await store.markingsOf([id]))[id] ?? markings);
    return true;
  }

  /** push an entity's markings to every projection that keeps its own copy for in-engine filtering. */
  async #restamp(type: TypeName, id: EntityId, markings: MarkingId[]): Promise<void> {
    const ix = this.#bound['object-index'] as ObjectIndex | undefined;
    if (ix?.capabilities.enforcesMarkings) await ix.setMarkings(type, id, markings);
  }

  /** I1 + I2 on every entity write: stored = given ∪ what its lineage demands ∪ what it already
   *  had, less any marking an approved declassification released at its ref that no longer
   *  reaches it and the writer did not give (re-derivation; the drop is audited). */
  async #upsertEntity(e: CanonicalEntity, tx?: Tx): Promise<void> {
    const store = this.#bound['canonical-store'] as CanonicalStore;
    const lineage = this.#bound['lineage'] as Lineage | undefined;
    const ref = entityRef(e.type, e.id);
    const existing = await store.getEntity(e.type, e.id);
    const inherited = lineage ? await lineage.effectiveMarkings(ref) : [];
    const released = lineage && existing?.markings?.length ? await lineage.releasedMarkings(ref) : [];
    const given = e.markings ?? [];
    const dropped = (existing?.markings ?? []).filter((m) => released.includes(m) && !inherited.includes(m) && !given.includes(m));
    const markings = union(given, (existing?.markings ?? []).filter((m) => !dropped.includes(m)), inherited);
    await store.upsertEntity(markings.length ? { ...e, markings } : e, tx);   // unions with the stored row: fail closed
    if (dropped.length) {
      await store.removeMarkings(e.type, e.id, dropped);
      await this.#restamp(e.type, e.id, markings);
      const audit = this.#bound['audit-log'] as AuditLog | undefined;
      if (audit) await audit.append({ ts: BigInt(Date.now()) * 1_000_000n, actor: this.component, action: 'admin', resource: ref, detail: { released: dropped, remaining: markings }, markings: union(dropped, markings) });
    }
    const fresh = markings.filter((m) => !(existing?.markings ?? []).includes(m));
    if (!fresh.length) return;
    if (!dropped.length) await this.#restamp(e.type, e.id, markings);
    // markings set directly on this entity must reach what is, or will be, derived from it
    const direct = fresh.filter((m) => !inherited.includes(m));
    if (lineage && direct.length) await this.applyMarking(ref, direct);
  }

  /** I1 when an edge arrives after the entities below it: everything downstream catches up at
   *  once, whether the new edge points at an entity or at a ref further up its chain. */
  async #record(edge: LineageEdge): Promise<void> {
    const lineage = this.#bound['lineage'] as Lineage;
    if (edge.kind === 'unmark' || edge.kind === 'unmark-request' || edge.kind === 'marking-closure') throw new GovernanceError(`${edge.kind} records are written only by the spine (spine/declassify.ts, propagateMarking)`);
    await lineage.record(edge);
    const inherited = await lineage.effectiveMarkings(edge.downstream);
    if (inherited.length) await this.#stampDown(edge.downstream, inherited);
  }

  /** I2 for projections: an index row never carries fewer markings than its canonical row — and
   *  never holds a protected field, whatever the caller passed (spec §4.7). `text` is the
   *  caller's own; indexDocFor() builds it from public fields only. */
  async #index(type: TypeName, id: EntityId, doc: IndexDoc): Promise<void> {
    const ix = this.#bound['object-index'] as ObjectIndex;
    const store = this.#bound['canonical-store'] as CanonicalStore | undefined;
    const canon = store ? (await store.markingsOf([id]))[id] : undefined;
    await ix.index(type, id, { ...doc, fields: this.#gov.policy.publicFields(type, doc.fields), markings: union(doc.markings, canon) });
  }
}
