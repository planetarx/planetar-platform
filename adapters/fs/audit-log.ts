// adapters/fs/audit-log.ts — R11 append-only, hash-chained audit log (tamper-evident).
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditLog, AdapterContext, AdapterCapabilities, AuditRecord } from '../../spine/ports.ts';
import type { TimeWindow, HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

export class AppendWalAuditLog implements AuditLog {
  private path!: string;
  private prevHash = 'GENESIS';
  readonly capabilities: AdapterCapabilities = { consistency: 'append-only', durable: true, rebuildable: false, scale: 'single', p99TargetMs: 20 };

  async init(ctx: AdapterContext): Promise<void> {
    this.path = (ctx.manifest.config.path as string) ?? './audit/audit.log';
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      if (lines.length) this.prevHash = jparse<{ hash: string }>(lines[lines.length - 1]).hash;
    }
  }
  async append(rec: AuditRecord): Promise<void> {
    const body = jstr(rec);
    const hash = createHash('sha256').update(this.prevHash + body).digest('hex');
    appendFileSync(this.path, jstr({ prev: this.prevHash, hash, rec }) + '\n');
    this.prevHash = hash;
  }
  async *scan(filter: { actor?: string; resource?: string; window?: TimeWindow }): AsyncIterable<AuditRecord> {
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, 'utf8').split('\n').filter(Boolean)) {
      const rec = jparse<{ rec: AuditRecord }>(line).rec;
      if (filter.actor && rec.actor !== filter.actor) continue;
      if (filter.resource && rec.resource !== filter.resource) continue;
      yield rec;
    }
  }
  async *export(_window: TimeWindow, format: 'cef' | 'leef' | 'ocsf' | 'json'): AsyncIterable<string> {
    for await (const rec of this.scan({})) yield format === 'json' ? jstr(rec) : `${format.toUpperCase()}|${rec.actor}|${rec.action}|${rec.resource}`;
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 20 }; }
  async close(): Promise<void> {}
}

registerAdapter('audit-log', 'append-wal', () => new AppendWalAuditLog());
