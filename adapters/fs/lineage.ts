// adapters/fs/lineage.ts — R12 provenance graph + the propagating-security seam (file-backed edge).
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Lineage, AdapterContext, AdapterCapabilities, LineageEdge } from '../../spine/ports.ts';
import type { HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

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
    const edges = this.all().filter((e) => e.kind !== 'marking');
    const seen = new Set<string>([ref]);
    const out: LineageEdge[] = [];
    let frontier = [ref];
    for (let h = 0; h < maxHops && frontier.length; h++) {
      const next: string[] = [];
      for (const e of edges) {
        const [a, b] = dir === 'down' ? [e.upstream, e.downstream] : [e.downstream, e.upstream];
        if (frontier.includes(a) && !seen.has(b)) { out.push(e); seen.add(b); next.push(b); }
      }
      frontier = next;
    }
    return out;
  }
  /** THE moat: apply `markings` at `ref` and return its downstream closure. Stamping the store
   *  rows is the spine's job (spine/system.ts); the propagation edges make the closure auditable. */
  async propagateMarking(ref: string, markings: string[]): Promise<string[]> {
    await this.applyMarking(ref, markings);
    const affected = [...new Set((await this.downstreamOf(ref)).map((e) => e.downstream))];
    for (const d of affected) await this.record({ upstream: ref, downstream: d, kind: 'field-derivation', markings });
    return affected;
  }
  async applyMarking(ref: string, markings: string[]): Promise<void> {
    if (markings.length) await this.record({ upstream: ref, downstream: ref, kind: 'marking', markings });
  }
  async effectiveMarkings(ref: string): Promise<string[]> {
    const at = new Set([ref, ...this.walk(ref, 64, 'up').map((e) => e.upstream)]);
    const out = new Set<string>();
    for (const e of this.all()) if (e.kind === 'marking' && at.has(e.upstream)) for (const m of e.markings ?? []) out.add(m);
    return [...out];
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 50 }; }
  async close(): Promise<void> {}
}

registerAdapter('lineage', 'fs', () => new FsLineage());
