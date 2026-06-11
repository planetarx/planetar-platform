// adapters/file/vector.ts — R7 durable brute-force vector store (zero-service edge/standard).
// Real scale binds pgvector/qdrant (see 40-ADAPTERS/blob-vector.md); same VectorStore port.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VectorStore, AdapterContext, AdapterCapabilities, ScoredId } from '../../spine/ports.ts';
import type { Json, HealthStatus } from '../../spine/model.ts';
import { registerAdapter } from '../../spine/contracts.ts';

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export class FileVectorStore implements VectorStore {
  private path!: string;
  private store = new Map<string, { vec: number[]; meta: Json }>();
  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 50 };

  async init(ctx: AdapterContext): Promise<void> {
    this.path = (ctx.manifest.config.path as string) ?? './data/vectors.json';
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) for (const [id, rec] of Object.entries(JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, { vec: number[]; meta: Json }>)) this.store.set(id, rec);
  }
  private flush(): void { writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.store))); }
  async upsert(id: string, vec: Float32Array, meta: Json): Promise<void> { this.store.set(id, { vec: Array.from(vec), meta }); this.flush(); }
  async knn(vec: Float32Array, k: number): Promise<ScoredId[]> {
    const q = Array.from(vec);
    return [...this.store.entries()].map(([id, r]) => ({ id, score: cosine(q, r.vec) })).sort((a, b) => b.score - a.score).slice(0, k);
  }
  async remove(id: string): Promise<void> { this.store.delete(id); this.flush(); }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 50 }; }
  async close(): Promise<void> {}
}

registerAdapter('vector', 'file', () => new FileVectorStore());
