// adapters/sqlite/work-queue.ts — R14 on node:sqlite (single-writer claim; edge tier).
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './_db.ts';
import type { WorkQueue, AdapterContext, AdapterCapabilities, Job, JobId } from '../../spine/ports.ts';
import type { Json, HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const DDL = `CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, payload TEXT, status TEXT DEFAULT 'pending', run_after INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, claimed_by TEXT);`;

export class SqliteWorkQueue implements WorkQueue {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: false, scale: 'single', p99TargetMs: 20 };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
    this.db.exec(DDL);
  }
  async enqueue(job: Job): Promise<JobId> {
    const r = this.db.prepare('INSERT INTO job(kind,payload,run_after) VALUES(?,?,?)').run(job.kind, jstr(job.payload), Number(job.runAfter ?? 0n));
    return String(r.lastInsertRowid);
  }
  async claim(worker: string, max: number): Promise<(Job & { id: JobId })[]> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT id,kind,payload FROM job WHERE status='pending' ORDER BY id LIMIT ?").all(max) as { id: number; kind: string; payload: string }[];
      for (const r of rows) this.db.prepare("UPDATE job SET status='claimed', claimed_by=?, attempts=attempts+1 WHERE id=?").run(worker, r.id);
      this.db.exec('COMMIT');
      return rows.map((r) => ({ id: String(r.id), kind: r.kind, payload: jparse<Json>(r.payload) }));
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async complete(id: JobId): Promise<void> { this.db.prepare("UPDATE job SET status='done' WHERE id=?").run(Number(id)); }
  async fail(id: JobId, retryInSec = 0): Promise<void> {
    this.db.prepare("UPDATE job SET status='pending', run_after=? WHERE id=?").run(Date.now() + retryInSec * 1000, Number(id));
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 20 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('work-queue', 'sqlite', () => new SqliteWorkQueue());
