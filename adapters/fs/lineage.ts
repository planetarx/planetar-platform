// adapters/fs/lineage.ts — R12 provenance graph + the propagating-security seam (file-backed edge).
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Lineage, AdapterContext, AdapterCapabilities, LineageEdge } from '../../spine/ports.ts';
import { isFlowEdge } from '../../spine/ports.ts';
import type { HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const MAX_HOPS = 64;
const blockKey = (up: string, down: string, m: string) => `${up}\u0000${down}\u0000${m}`;

/** Edges reached from `ref` walking toward `dir`, skipping the edges `skip` rejects. */
function reach(edges: LineageEdge[], ref: string, dir: 'up' | 'down', maxHops: number, skip?: (e: LineageEdge) => boolean): LineageEdge[] {
  const seen = new Set<string>([ref]);
  const out: LineageEdge[] = [];
  let frontier = new Set([ref]);
  for (let h = 0; h < maxHops && frontier.size; h++) {
    const next = new Set<string>();
    for (const e of edges) {
      if (skip?.(e)) continue;
      const [a, b] = dir === 'down' ? [e.upstream, e.downstream] : [e.downstream, e.upstream];
      if (frontier.has(a) && !seen.has(b)) { out.push(e); seen.add(b); next.add(b); }
    }
    frontier = next;
  }
  return out;
}

export class FsLineage implements Lineage {
  private path!: string;
  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 50 };

  async init(ctx: AdapterContext): Promise<void> {
    this.path = (ctx.manifest.config.path as string) ?? './lineage/edges.jsonl';
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) appendFileSync(this.path, '');
  }
  private all(): LineageEdge[] {
    return existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => jparse<LineageEdge>(l)) : [];
  }
  async record(edge: LineageEdge): Promise<void> { appendFileSync(this.path, jstr(edge) + '\n'); }
  async upstreamOf(ref: string, maxHops = 8): Promise<LineageEdge[]> { return this.walk(ref, maxHops, 'up'); }
  async downstreamOf(ref: string, maxHops = 8): Promise<LineageEdge[]> { return this.walk(ref, maxHops, 'down'); }
  private walk(ref: string, maxHops: number, dir: 'up' | 'down'): LineageEdge[] {
    return reach(this.all().filter(isFlowEdge), ref, dir, maxHops);
  }
  /** THE moat: apply `markings` at `ref` and return its downstream closure. Stamping the store
   *  rows is the spine's job (spine/system.ts). The closure records make the act auditable; they
   *  are not data-flow edges, so they never carry a marking around a blocked edge. */
  async propagateMarking(ref: string, markings: string[]): Promise<string[]> {
    await this.applyMarking(ref, markings);
    const affected = [...new Set((await this.downstreamOf(ref, MAX_HOPS)).map((e) => e.downstream))];
    for (const d of affected) await this.record({ upstream: ref, downstream: d, kind: 'marking-closure', markings });
    return affected;
  }
  async applyMarking(ref: string, markings: string[]): Promise<void> {
    if (markings.length) await this.record({ upstream: ref, downstream: ref, kind: 'marking', markings });
  }
  /** A marking reaches `ref` if some path from a ref where it is applied crosses no edge that an
   *  approved 'unmark' record blocks for that marking. A marking applied AT `ref` always counts. */
  async effectiveMarkings(ref: string): Promise<string[]> {
    const all = this.all(), flow = all.filter(isFlowEdge);
    const applied = new Map<string, Set<string>>();
    for (const e of all) {
      if (e.kind !== 'marking') continue;
      const set = applied.get(e.upstream) ?? new Set<string>();
      for (const m of e.markings ?? []) set.add(m);
      applied.set(e.upstream, set);
    }
    const blocked = new Set(all.filter((e) => e.kind === 'unmark').flatMap((e) => (e.markings ?? []).map((m) => blockKey(e.upstream, e.downstream, m))));
    const ancestors = [ref, ...reach(flow, ref, 'up', MAX_HOPS).map((e) => e.upstream)];
    const candidates = new Set(ancestors.flatMap((r) => [...(applied.get(r) ?? [])]));
    const out: string[] = [];
    for (const m of candidates) {
      if (applied.get(ref)?.has(m)) { out.push(m); continue; }
      const path = reach(flow, ref, 'up', MAX_HOPS, (e) => blocked.has(blockKey(e.upstream, e.downstream, m)));
      if (path.some((e) => applied.get(e.upstream)?.has(m))) out.push(m);
    }
    return out;
  }
  async releasedMarkings(ref: string): Promise<string[]> {
    const all = this.all();
    const at = new Set([ref, ...reach(all.filter(isFlowEdge), ref, 'up', MAX_HOPS).map((e) => e.upstream)]);
    return [...new Set(all.filter((e) => e.kind === 'unmark' && at.has(e.downstream)).flatMap((e) => e.markings ?? []))];
  }
  async declassifications(id?: string): Promise<LineageEdge[]> {
    return this.all().filter((e) => (e.kind === 'unmark-request' || e.kind === 'unmark') && (id === undefined || e.declass?.id === id));
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 50 }; }
  async close(): Promise<void> {}
}

registerAdapter('lineage', 'fs', () => new FsLineage());
