// spine/governed.ts — the read gate. platform.as(principal) returns a GovernedPlatform whose
// ports expose only the methods classified 'governed' or 'open' in GOVERNANCE_RULES, and every
// governed result is filtered against the canonical store's markings (the authority) before it
// leaves. An adapter bug can therefore hide rows, never reveal them. Anything the gate cannot
// resolve fails closed. Design: docs/specs/2026-10-06-governed-ports-design.md §4.3.
import type {
  RoleId, Adapter, PortByRole, GovernedPortByRole, Principal, CanonicalStore, AuditLog, AuditRecord, Lineage,
  LineageEdge, GraphNode, GraphEdge, TraversalSpec, ScoredId, Envelope,
} from './ports.ts';
import type { CanonicalEntity, EntityId, TypeName, FieldName, Json, MarkingId, TimeWindow } from './model.ts';
import type { GovernanceConfig } from './contracts.ts';
import { GovernanceError, parseRef } from './governance.ts';
import { jstr } from './json.ts';

type Bound = Partial<Record<RoleId, Adapter>>;

/** the result of checking a batch of entity ids against the canonical store */
interface Screen { ok: Set<EntityId>; hidden: Set<EntityId>; markings: MarkingId[] }

/** an object exposing only `keys` of `a`, bound to it */
function pick<T extends object, K extends keyof T>(a: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    const v = a[k];
    out[k] = (typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(a) : v) as T[K];
  }
  return out;
}

export class GovernedPlatform {
  #bound: Bound;
  #gov: GovernanceConfig;
  readonly principal: Principal;
  constructor(bound: Bound, principal: Principal, gov: GovernanceConfig) { this.#bound = bound; this.principal = principal; this.#gov = gov; }

  has(r: RoleId): boolean { return !!this.#bound[r]; }

  role<R extends RoleId>(r: R): GovernedPortByRole[R] {
    const ports: { [K in RoleId]: () => GovernedPortByRole[K] } = {
      'canonical-store': () => this.#canonical(),
      'hot-cache': () => this.#cache(),
      'stream': () => this.#stream(),
      'object-index': () => this.#index(),
      'graph': () => this.#graph(),
      'blob-cas': () => pick(this.#raw('blob-cas'), ['get', 'presignRead']),
      'vector': () => this.#vector(),
      'timeseries-geo': () => this.#tracks(),
      'analytics-olap': () => this.#olap(),
      'registry': () => pick(this.#raw('registry'), ['loadAll', 'get', 'versions']),
      'audit-log': () => this.#auditLog(),
      'lineage': () => this.#lineage(),
      'policy-identity': () => pick(this.#raw('policy-identity'), ['authenticate', 'authorize', 'members']),
      'work-queue': () => ({}),   // system-only until jobs carry markings (GOVERNANCE_RULES)
    };
    return ports[r]();
  }

  // ------------------------------------------------------------------ shared machinery

  #raw<R extends RoleId>(r: R): PortByRole[R] {
    const a = this.#bound[r];
    if (!a) throw new GovernanceError(`role ${r} is not bound in this client`);
    return a as PortByRole[R];
  }

  /** Split entity ids into those the principal may see and those it may not. An id the
   *  canonical store does not know is hidden: the gate fails closed. */
  async #screen(ids: EntityId[]): Promise<Screen> {
    const uniq = [...new Set(ids)];
    const store = this.#bound['canonical-store'] as CanonicalStore | undefined;
    const known = store && uniq.length ? await store.markingsOf(uniq) : {};
    const ok = new Set<EntityId>(), hidden = new Set<EntityId>(), all = new Set<MarkingId>();
    for (const id of uniq) {
      const marks = known[id];
      if (marks === undefined) { hidden.add(id); continue; }
      for (const m of marks) all.add(m);
      if (this.#gov.policy.visible(this.principal, marks)) ok.add(id); else hidden.add(id);
    }
    return { ok, hidden, markings: [...all] };
  }

  /** One read record per governed call. Its own markings cover returned AND withheld rows, so a
   *  principal cannot learn a withheld count from its own audit trail (spec §4.8). */
  async #audit(method: string, detail: Record<string, Json>, returned: number, withheld: number, markings: MarkingId[]): Promise<void> {
    const log = this.#bound['audit-log'] as AuditLog | undefined;
    const mode = this.#gov.auditReads;
    if (!log || mode === 'none') return;
    if (mode === 'marked' && withheld === 0 && markings.length === 0) return;
    await log.append({ ts: this.#gov.nowNs(), actor: this.principal.id, action: 'read', resource: method, detail: { ...detail, returned, withheld }, markings });
  }

  /** refuse to filter, sort or aggregate on a field the principal cannot read (it would be an oracle) */
  #needField(type: TypeName | undefined, field: FieldName): void {
    if (!this.#gov.policy.canUseField(this.principal, type, field)) throw new GovernanceError(`field '${field}' is protected: this principal cannot filter, sort or aggregate on it`);
  }

  /** A shared projection never holds a protected field (indexDocFor), so nobody may name one in
   *  a query against it: an engine that did hold the field would turn the filter into an oracle.
   *  `filter` may be an engine-specific JSON shape, so every key and every string in it is checked. */
  #noProtectedField(what: string, filter: Json | undefined): void {
    const policy = this.#gov.policy;
    const walk = (v: Json | undefined): void => {
      if (typeof v === 'string') {
        if (policy.protectsField(undefined, v)) throw new GovernanceError(`${what}: field '${v}' is protected and is not held in shared projections`);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') for (const [k, inner] of Object.entries(v)) { walk(k); walk(inner); }
    };
    walk(filter);
  }

  // ------------------------------------------------------------------ R1 canonical-store

  #canonical(): GovernedPortByRole['canonical-store'] {
    const store = this.#raw('canonical-store'), policy = this.#gov.policy, p = this.principal;
    const view = (e: CanonicalEntity): CanonicalEntity => ({ ...e, fields: policy.redactFields(p, e.type, e.fields) });
    return {
      getEntity: async (type, id) => {
        const e = await store.getEntity(type, id);
        const ok = e !== null && policy.visible(p, e.markings ?? []);
        await this.#audit('canonical-store.getEntity', { type, id }, ok ? 1 : 0, e !== null && !ok ? 1 : 0, e?.markings ?? []);
        return ok ? view(e) : null;
      },
      listEntities: async (type, q) => {
        for (const f of q.filter ?? []) this.#needField(type, f.field);
        for (const o of q.orderBy ?? []) this.#needField(type, o.field);
        const limit = q.limit ?? 50;
        const items: CanonicalEntity[] = []; const marks = new Set<MarkingId>(); let withheld = 0;
        let cursor = q.cursor;
        // refill: ask for exactly what is still missing, so a withheld row never shortens a page
        for (;;) {
          const page = await store.listEntities(type, { ...q, cursor, limit: limit - items.length });
          for (const e of page.items) {
            for (const m of e.markings ?? []) marks.add(m);
            if (policy.visible(p, e.markings ?? [])) items.push(view(e)); else withheld++;
          }
          cursor = page.cursor;
          if (!cursor || items.length >= limit) break;
        }
        await this.#audit('canonical-store.listEntities', { type }, items.length, withheld, [...marks]);
        return { items, cursor };
      },
      getLinks: async (type, id, linkType) => {
        const links = await store.getLinks(type, id, linkType);
        const s = await this.#screen([id, ...links.flatMap((l) => [l.from, l.to])]);
        const out = s.ok.has(id) ? links.filter((l) => s.ok.has(l.from) && s.ok.has(l.to)) : [];
        await this.#audit('canonical-store.getLinks', { type, id }, out.length, links.length - out.length, s.markings);
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ R4 object-index

  #index(): GovernedPortByRole['object-index'] {
    const ix = this.#raw('object-index'), policy = this.#gov.policy, p = this.principal;
    const enforcing = ix.capabilities.enforcesMarkings === true;
    // protected fields are never in a shared index (indexDocFor), so nobody may query on them
    const notIndexed = (type: TypeName | undefined, field: FieldName) => {
      if (policy.protectsField(type, field)) throw new GovernanceError(`field '${field}' is protected and is not indexed`);
    };
    return {
      search: async (q) => {
        for (const f of q.filter ?? []) notIndexed(q.type, f.field);
        for (const f of q.facets ?? []) notIndexed(q.type, f);
        for (const o of q.sort ?? []) notIndexed(q.type, o.field);
        const res = await ix.search({ ...q, principal: p });
        const s = await this.#screen(res.hits.map((h) => h.id));          // backstop, whatever the engine claims
        const hits = res.hits.filter((h) => s.ok.has(h.id));
        await this.#audit('object-index.search', { type: q.type ?? null, text: q.text ?? null }, hits.length, res.hits.length - hits.length, s.markings);
        return enforcing ? { hits, cursor: res.cursor, facets: res.facets, total: res.total } : { hits, cursor: res.cursor };
      },
      aggregate: async (q) => {
        if (!enforcing) throw new GovernanceError('object-index.aggregate needs an engine that enforces markings');
        for (const f of q.groupBy) notIndexed(q.type, f);
        for (const m of q.metrics) if (m.field) notIndexed(q.type, m.field);
        for (const f of q.filter ?? []) notIndexed(q.type, f.field);
        return ix.aggregate({ ...q, principal: p });
      },
    };
  }

  // ------------------------------------------------------------------ R5 graph

  /** Breadth-first walk of one-hop expansions that never steps onto or through a node the
   *  principal cannot see. Stops early once `target` is reached. */
  async #walk(start: EntityId, spec: TraversalSpec, hops: number, target?: EntityId) {
    const g = this.#raw('graph');
    const nodes = new Map<EntityId, GraphNode>(), edges = new Map<string, GraphEdge>(), prev = new Map<EntityId, EntityId>();
    const dist = new Map<EntityId, number>(), hidden = new Set<EntityId>(), marks = new Set<MarkingId>();
    const note = (s: Screen) => { for (const h of s.hidden) hidden.add(h); for (const m of s.markings) marks.add(m); };
    const first = await this.#screen([start]); note(first);
    let frontier: EntityId[] = first.ok.has(start) ? [start] : [];
    if (frontier.length) dist.set(start, 0);
    for (let h = 0; h < hops && frontier.length && !(target !== undefined && dist.has(target)); h++) {
      const next: EntityId[] = [];
      for (const id of frontier) {
        const sub = await g.neighbors(id, { ...spec, maxHops: 1 });
        const s = await this.#screen(sub.nodes.map((n) => n.id)); note(s);
        for (const n of sub.nodes) {
          if (!s.ok.has(n.id)) continue;
          nodes.set(n.id, n);
          if (!dist.has(n.id)) { dist.set(n.id, h + 1); prev.set(n.id, id); next.push(n.id); }
        }
        for (const e of sub.edges) if (s.ok.has(e.from) && s.ok.has(e.to)) edges.set(`${e.from}|${e.to}|${e.linkType}`, e);
      }
      frontier = next;
    }
    return { nodes, edges, prev, dist, hidden, marks };
  }

  #graph(): GovernedPortByRole['graph'] {
    return {
      neighbors: async (id, spec) => {
        this.#noProtectedField('graph.neighbors', (spec.filter ?? []).map((f) => f.field));
        const w = await this.#walk(id, spec, spec.maxHops ?? 2);
        await this.#audit('graph.neighbors', { id }, w.nodes.size, w.hidden.size, [...w.marks]);
        return { nodes: [...w.nodes.values()], edges: [...w.edges.values()] };
      },
      shortestPath: async (a, b, spec) => {
        this.#noProtectedField('graph.shortestPath', (spec.filter ?? []).map((f) => f.field));
        const w = await this.#walk(a, spec, spec.maxHops ?? 6, b);
        const length = w.dist.get(b);
        await this.#audit('graph.shortestPath', { from: a, to: b }, length === undefined ? 0 : 1, w.hidden.size, [...w.marks]);
        if (length === undefined) return null;
        const path: EntityId[] = [b];
        while (path[0] !== a) path.unshift(w.prev.get(path[0])!);
        return { nodes: path, edges: [], length };
      },
    };
  }

  // ------------------------------------------------------------------ R7 vector

  #vector(): GovernedPortByRole['vector'] {
    const v = this.#raw('vector');
    return {
      knn: async (vec, k, filter) => {
        this.#noProtectedField('vector.knn', filter);
        let out: ScoredId[] = []; let hidden = 0; let marks: MarkingId[] = [];
        // over-fetch, drop what is not visible, widen until k remain or the store is exhausted
        for (let want = k * 4, round = 0; round < 4; want *= 4, round++) {
          const got = await v.knn(vec, want, filter);
          const s = await this.#screen(got.map((r) => r.id));
          out = got.filter((r) => s.ok.has(r.id)).slice(0, k); hidden = s.hidden.size; marks = s.markings;
          if (out.length >= k || got.length < want) break;
        }
        await this.#audit('vector.knn', { k }, out.length, hidden, marks);
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ R8 timeseries-geo

  #tracks(): GovernedPortByRole['timeseries-geo'] {
    const ts = this.#raw('timeseries-geo');
    const one = async <T>(method: string, entityId: EntityId, read: () => Promise<T[]>): Promise<T[]> => {
      const s = await this.#screen([entityId]);
      const pts = s.ok.has(entityId) ? await read() : [];
      await this.#audit(`timeseries-geo.${method}`, { entityId }, pts.length, s.hidden.size, s.markings);
      return pts;
    };
    return {
      range: (entityId, w) => one('range', entityId, () => ts.range(entityId, w)),
      downsample: (entityId, w, bucketSec) => one('downsample', entityId, () => ts.downsample(entityId, w, bucketSec)),
      within: async (geo, w) => {
        const pts = await ts.within(geo, w);
        const s = await this.#screen(pts.map((pt) => pt.entityId));
        const out = pts.filter((pt) => s.ok.has(pt.entityId));
        await this.#audit('timeseries-geo.within', {}, out.length, pts.length - out.length, s.markings);
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ R9 analytics-olap

  #olap(): GovernedPortByRole['analytics-olap'] {
    const olap = this.#raw('analytics-olap'), p = this.principal;
    return {
      query: async (q) => {
        if (!olap.capabilities.enforcesMarkings) throw new GovernanceError('analytics-olap.query needs an engine that enforces markings');
        // For a principal `from` is a canonical type and every name a logical field of it. An
        // enforcing engine resolves them that way and can reach no storage column or other
        // table; a federated table reference has no such guarantee, so it is refused here.
        if (q.from.includes('://')) throw new GovernanceError('federated tables are not available to principals');
        for (const d of q.dimensions) this.#needField(q.from, d);
        for (const m of q.measures) if (m.field) this.#needField(q.from, m.field);
        for (const w of q.where ?? []) this.#needField(q.from, w.field);
        return olap.query({ ...q, principal: p });
      },
    };
  }

  // ------------------------------------------------------------------ R3 stream

  #stream(): GovernedPortByRole['stream'] {
    const stream = this.#raw('stream'), policy = this.#gov.policy, p = this.principal;
    return {
      subscribe: (topics, from) => {
        const src = stream.subscribe(topics, from);      // subscribe now, filter as envelopes arrive
        return { async *[Symbol.asyncIterator](): AsyncGenerator<Envelope> { for await (const env of src) if (policy.visible(p, env.markings ?? [])) yield env; } };
      },
    };
  }

  // ------------------------------------------------------------------ R11 audit-log

  #auditLog(): GovernedPortByRole['audit-log'] {
    const log = this.#raw('audit-log'), policy = this.#gov.policy, p = this.principal;
    const scan = (filter: { actor?: string; resource?: string; window?: TimeWindow }) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<AuditRecord> { for await (const rec of log.scan(filter)) if (policy.visible(p, rec.markings ?? [])) yield rec; },
    });
    return {
      scan,
      // formatted from the governed scan: the engine's own export cannot be filtered after the fact
      export: (window, format) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
          for await (const rec of scan({ window })) yield format === 'json' ? jstr(rec) : `${format.toUpperCase()}|${rec.actor}|${rec.action}|${rec.resource}`;
        },
      }),
    };
  }

  // ------------------------------------------------------------------ R12 lineage

  #lineage(): GovernedPortByRole['lineage'] {
    const lineage = this.#raw('lineage'), policy = this.#gov.policy, p = this.principal;
    const filter = async (method: string, edges: LineageEdge[]): Promise<LineageEdge[]> => {
      const refs = [...new Set(edges.flatMap((e) => [e.upstream, e.downstream]))];
      const s = await this.#screen(refs.flatMap((r) => parseRef(r)?.id ?? []));
      const marks = new Set(s.markings), ok = new Map<string, boolean>();
      for (const r of refs) {
        const ent = parseRef(r), eff = await (lineage as Lineage).effectiveMarkings(r);
        for (const m of eff) marks.add(m);
        ok.set(r, (!ent || s.ok.has(ent.id)) && policy.visible(p, eff));
      }
      const out = edges.filter((e) => ok.get(e.upstream) && ok.get(e.downstream) && policy.visible(p, e.markings ?? []));
      await this.#audit(`lineage.${method}`, {}, out.length, edges.length - out.length, [...marks]);
      return out;
    };
    return {
      upstreamOf: async (ref, maxHops) => filter('upstreamOf', await lineage.upstreamOf(ref, maxHops)),
      downstreamOf: async (ref, maxHops) => filter('downstreamOf', await lineage.downstreamOf(ref, maxHops)),
    };
  }

  // ------------------------------------------------------------------ R2 hot-cache

  #cache(): GovernedPortByRole['hot-cache'] {
    const c = this.#raw('hot-cache');
    // principals share an entry only if they hold exactly the same clearances
    const ns = `c[${[...this.principal.clearances].sort().join(',')}]:`;
    return {
      get: (k) => c.get(ns + k),
      set: (k, v, ttlSec) => c.set(ns + k, v, ttlSec),
      del: (k) => c.del(ns + k),
      incr: (k, by) => c.incr(ns + k, by),
      publish: c.publish ? (channel, msg) => c.publish!(ns + channel, msg) : undefined,
      subscribe: c.subscribe ? (channel) => c.subscribe!(ns + channel) : undefined,
    };
  }
}
