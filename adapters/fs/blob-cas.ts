// adapters/fs/blob-cas.ts — R6 content-addressed blob store on the local filesystem (edge).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobCas, AdapterContext, AdapterCapabilities } from '../../spine/ports.ts';
import type { BlobHandle, HealthStatus } from '../../spine/model.ts';
import { registerAdapter } from '../../spine/contracts.ts';

export class FsBlobCas implements BlobCas {
  private root!: string;
  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: true, rebuildable: false, scale: 'single', p99TargetMs: 50 };

  async init(ctx: AdapterContext): Promise<void> {
    this.root = (ctx.manifest.config.root as string) ?? './blobs';
    mkdirSync(this.root, { recursive: true });
  }
  private pathFor(sha: string): string { return join(this.root, sha.slice(0, 2), sha); }
  async put(bytes: Uint8Array, mime: string): Promise<BlobHandle> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const p = this.pathFor(sha256);
    mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
    if (!existsSync(p)) { writeFileSync(p, bytes); writeFileSync(p + '.json', JSON.stringify({ mime, size: bytes.length })); }
    return { sha256, size: bytes.length, mime };
  }
  async get(handle: BlobHandle): Promise<Uint8Array> { return new Uint8Array(readFileSync(this.pathFor(handle.sha256))); }
  async presignRead(handle: BlobHandle): Promise<string> { return 'file://' + this.pathFor(handle.sha256); }
  async health(): Promise<HealthStatus> { return { ok: existsSync(this.root), p99Ms: 50 }; }
  async close(): Promise<void> {}
}

registerAdapter('blob-cas', 'filesystem', () => new FsBlobCas());
