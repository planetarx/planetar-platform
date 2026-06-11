// adapters/file/stream.ts — R3 durable WAL-file bus (zero-service edge binding for the broker).
// Real edge deploys bind engine 'broker' (the ns C bus); this 'file' engine needs no process.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Stream, AdapterContext, AdapterCapabilities, Envelope, TopicPattern, Offset } from '../../spine/ports.ts';
import type { HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { AsyncQueue } from '../../spine/asyncqueue.ts';
import { registerAdapter } from '../../spine/contracts.ts';

function matches(topic: string, patterns: TopicPattern[]): boolean {
  return patterns.some((p) => {
    if (p === '**') return true;
    // segment-wise: '**' -> '.*' (spans dots), '*' -> one segment, literal otherwise
    const rx = '^' + p.split('.').map((seg) =>
      seg === '**' ? '.*' : seg === '*' ? '[^.]*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('\\.') + '$';
    return new RegExp(rx).test(topic);
  });
}

export class FileStream implements Stream {
  private path!: string;
  private subs: { patterns: TopicPattern[]; q: AsyncQueue<Envelope> }[] = [];
  readonly capabilities: AdapterCapabilities = { consistency: 'append-only', durable: true, rebuildable: false, scale: 'single', p99TargetMs: 3 };

  async init(ctx: AdapterContext): Promise<void> {
    this.path = (ctx.manifest.config.path as string) ?? './data/stream.wal';
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) appendFileSync(this.path, '');
  }
  async publish(env: Envelope): Promise<void> {
    const rec = { meta: { ...env, payload: undefined }, payloadB64: Buffer.from(env.payload).toString('base64') };
    appendFileSync(this.path, jstr(rec) + '\n');                 // durable WAL append
    for (const s of this.subs) if (matches(env.topic, s.patterns)) s.q.push(env);   // live fan-out
  }
  subscribe(topics: TopicPattern[], from: Offset | 'latest'): AsyncIterable<Envelope> {
    const q = new AsyncQueue<Envelope>();
    if (from !== 'latest' && existsSync(this.path)) {            // replay history first
      for (const line of readFileSync(this.path, 'utf8').split('\n').filter(Boolean)) {
        const rec = jparse<{ meta: Omit<Envelope, 'payload'>; payloadB64: string }>(line);
        const env: Envelope = { ...rec.meta, payload: new Uint8Array(Buffer.from(rec.payloadB64, 'base64')) };
        if (matches(env.topic, topics)) q.push(env);
      }
    }
    this.subs.push({ patterns: topics, q });
    return q;
  }
  async ack(): Promise<void> { /* WAL-durable; projector checkpoints its own offset (R1) */ }
  async health(): Promise<HealthStatus> { return { ok: existsSync(this.path), p99Ms: 3 }; }
  async close(): Promise<void> { for (const s of this.subs) s.q.close(); }
}

registerAdapter('stream', 'file', () => new FileStream());
