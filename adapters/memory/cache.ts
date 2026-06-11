// adapters/memory/cache.ts — R2 in-process LRU-ish cache (zero-service default).
import type { Cache, AdapterContext, AdapterCapabilities } from '../../spine/ports.ts';
import type { Json, HealthStatus } from '../../spine/model.ts';
import { registerAdapter } from '../../spine/contracts.ts';

export class MemoryCache implements Cache {
  private m = new Map<string, { v: Json; exp: number }>();
  readonly capabilities: AdapterCapabilities = { consistency: 'eventual', durable: false, rebuildable: true, scale: 'single', p99TargetMs: 1 };
  async init(_ctx: AdapterContext): Promise<void> {}
  private live(k: string): boolean { const e = this.m.get(k); if (!e) return false; if (e.exp && e.exp < Date.now()) { this.m.delete(k); return false; } return true; }
  async get(k: string): Promise<Json | null> { return this.live(k) ? this.m.get(k)!.v : null; }
  async set(k: string, v: Json, ttlSec?: number): Promise<void> { this.m.set(k, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 }); }
  async del(k: string): Promise<void> { this.m.delete(k); }
  async incr(k: string, by = 1): Promise<number> { const cur = this.live(k) ? Number(this.m.get(k)!.v) : 0; const n = cur + by; this.m.set(k, { v: n, exp: 0 }); return n; }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 1 }; }
  async close(): Promise<void> { this.m.clear(); }
}

registerAdapter('hot-cache', 'in-process', () => new MemoryCache());
registerAdapter('hot-cache', 'memory', () => new MemoryCache());
