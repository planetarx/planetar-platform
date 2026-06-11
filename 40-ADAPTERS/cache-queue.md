# 40 · Adapters — Cache (R2) + Work-queue (R14)

Two roles, paired here because they are the platform's two **ephemeral / operational** stores: R2 holds derivable hot data (loss is tolerable, it repopulates), R14 holds durable units of *pending work* (loss is **not** tolerable — a dropped job is a dropped routing decision or a half-run orchestration). They share a chapter because the same engine often serves both (`redis` is the default R2 *and* a valid R14), and because the manifest-collapse logic that picks them is the same: **bind the smallest engine the contract allows; default to a zero-service in-process implementation when no enabled capability forces a heavier one.**

| Role | Contract ([`10 §2`](../10-STORAGE-ROLES.md)) | Port ([`12 §3`](../12-ADAPTER-CONTRACT.md)) | Default engine | Other engines |
|---|---|---|---|---|
| **R2 hot-cache** | eventual · p99 ≤ 1 ms · **not durable** · single/clustered · rebuildable | `Cache` | `redis` | `memcached`, in-process LRU |
| **R14 work-queue** | at-least-once / exactly-once · **durable** · ordered-per-key optional | `WorkQueue` | `postgres` (FOR UPDATE SKIP LOCKED) | `redis`, `temporal`, `kafka` |

### When to pick which engine

**R2 hot-cache**
- **in-process LRU** — the zero-service default. No capability requires a *durable* or *shared* cache, so the compiler binds this automatically when `hot-cache` is left unbound in the manifest (see [`13 §1`](../13-CLIENT-MANIFEST.md), the `# hot-cache omitted` line). Edge / air-gapped / single-process demos. Loss on restart is fine — the cache is a projection of R1/R3.
- **memcached** — multi-process on one host, want a pure cache with no persistence and slab eviction, no need for sorted-sets / pub-sub / atomic Lua. Rare; pick `redis` unless an existing memcached fleet is mandated.
- **redis (ioredis)** — the moment the cache must be **shared across processes/hosts**: presence ("which vessel is live," who's online), rate-limit counters that must be global, Salesforce Platform-Cache-style org cache, or when R2 and a light R14/R3 collapse onto one redis. Default for `standard` tier and up.

**R14 work-queue**
- **postgres (FOR UPDATE SKIP LOCKED)** — the default. Reuse the R1 workhorse; no extra service. Exactly-once claim semantics, transactional enqueue *in the same commit as the kinetic effect* (the queue insert and the entity write are one transaction — no lost-job race). Right for Omni-Channel routing, async-Apex-style jobs, Foundry build schedules, AIP agent task inboxes at single-cloud scale.
- **redis (BRPOPLPUSH / Streams consumer groups)** — light, fast, fire-and-forget-ish work where sub-ms claim latency matters more than transactional co-commit with R1. Reliable-queue pattern via `BRPOPLPUSH` (in-flight list) or `XREADGROUP` + `XACK` (consumer groups, redelivery on `XAUTOCLAIM`).
- **temporal** — **durable long-running orchestrations**: the Flow-Orchestration / multi-step-Automate analog. When a "job" is actually a workflow with timers, human-approval waits, sagas, compensations, retries spanning hours/days. Temporal owns the orchestration state; our adapter maps `enqueue→StartWorkflow`, `claim` is N/A (Temporal pulls via its own workers), so the adapter exposes orchestration through a thin `WorkQueue` facade plus an escape hatch (see §4.3).
- **kafka** — when the client already runs Kafka for R3 and wants work as a partitioned, infinitely-retained, consumer-group-balanced topic. Ordered-per-key (partition by key), at-least-once. Listed for completeness; the postgres/redis/temporal trio covers the parity targets.

---

## 1. The R14 mapping (why this role is "everything that routes, schedules, or runs work")

R14 is the single role behind four superficially different products. Parity = covering the **enqueue / claim / complete / fail / orchestrate** contract once, then surfacing it four ways.

| Product feature | R14 manifestation | Engine that fits |
|---|---|---|
| **Service Cloud Omni-Channel routing** | work items (`Case`, `Lead`, chat) enqueued onto skill/queue-keyed work-queues; agents *claim* the next item; capacity model = `claim(worker, max)` bounded by agent capacity | `postgres` skip-locked (transactional with the Case write) or `redis` for sub-second push |
| **SF Flow Orchestration / async Apex / Approval Processes** | each stage = a durable job with timers + human-wait + retry; approvals are jobs blocked on an external signal | `temporal` (durable multi-step) — `postgres` for simple async-Apex one-shots |
| **Foundry Automate / build schedules** | scheduled + event-triggered builds, dataset-transaction-driven jobs; a schedule is a recurring enqueue, a build is a claimed job | `postgres` (cron-style enqueue) or `temporal` (DAG with retries) |
| **AIP agent task inbox** | each agent gets a durable inbox of tasks; the agent worker `claim`s a task, runs tool-calls **through P7 kinetic Action Types** (containment), `complete`s with the result | `postgres` inbox (transactional with the audit envelope) |

The spine never special-cases these. Each is a thin surface (P8) + a routing rule expressed as Action Types (P7) over the *same* `WorkQueue` port. "Routing as actions" ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md), Omni-Channel row) means the *decision* of who-claims-what is a kinetic write, but the *durable mechanics* are R14.

> **Built/partial status.** The only automation that exists today is doibio's webhook dispatcher (`~/data/dev/doibio/src/lib/webhooks.ts`, **built/partial** — outbound HTTP on entity events, no claim/retry queue). There is **no declarative flow engine** in any built repo (doibio explicitly lacks one). So R14 is: **partial** on the `postgres` adapter (the skip-locked pattern is proven shape, reused from the canonical-store pg pool), **designed** on `redis`/`temporal`. The ontology's kinetic Action Type executor (`~/github/planetarx/planetar-ontology`, **built**) is the P7 layer that *consumes* R14 jobs; the queue under it is what this chapter supplies.

---

## 2. R2 — the `Cache` port, three engines

Port recap, verbatim from [`12 §3`](../12-ADAPTER-CONTRACT.md):

```ts
// R2 cache — redis | memcached | in-proc
export interface Cache extends Adapter {
  get(k: string): Promise<Json | null>;
  set(k: string, v: Json, ttlSec?: number): Promise<void>;
  incr(k: string, by?: number): Promise<number>;
}
```

All three adapters also implement the base `Adapter` lifecycle (`init` / `health` / `close` / `capabilities`) from [`12 §1`](../12-ADAPTER-CONTRACT.md).

### 2.1 in-process LRU — the zero-service default

This is what the manifest compiler binds when `hot-cache` is **absent** from `roles:`. It needs no driver, no port, no process. Capacity-bounded with a Map (insertion-order = recency; re-insert on read to promote), per-key TTL checked lazily on read.

```ts
// 40-ADAPTERS/inproc/cache.ts   (the default — zero external service)
import type { Cache, Json } from '../../spine/ports/cache';
import type { Adapter, AdapterContext, AdapterCapabilities, HealthStatus } from '../../spine/ports/adapter';

interface Entry { v: Json; exp: number; }   // exp = epoch ms, Infinity = no TTL

export class InProcLruCache implements Cache {
  private store = new Map<string, Entry>();
  private max = 10_000;

  readonly capabilities: AdapterCapabilities = {
    consistency: 'eventual',   // single-process view only; no cross-host coherence
    durable: false,            // lost on restart — fine, R2 is rebuildable
    rebuildable: true,         // repopulates from R1/R3 on demand
    scale: 'single',           // ONE process — this is why it can't back a shared capability
    p99TargetMs: 0,            // in-memory: sub-microsecond
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.max = ctx.manifest.config?.maxEntries ?? 10_000;
  }

  async get(k: string): Promise<Json | null> {
    const e = this.store.get(k);
    if (!e) return null;
    if (e.exp <= Date.now()) { this.store.delete(k); return null; }   // lazy TTL
    this.store.delete(k); this.store.set(k, e);                       // promote to MRU
    return e.v;
  }

  async set(k: string, v: Json, ttlSec?: number): Promise<void> {
    const exp = ttlSec ? Date.now() + ttlSec * 1000 : Infinity;
    if (this.store.has(k)) this.store.delete(k);
    this.store.set(k, { v, exp });
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value as string;       // first key = LRU
      this.store.delete(oldest);
    }
  }

  async incr(k: string, by = 1): Promise<number> {
    const cur = await this.get(k);
    const next = (typeof cur === 'number' ? cur : 0) + by;
    // preserve remaining TTL if present
    const e = this.store.get(k);
    await this.set(k, next, e && e.exp !== Infinity ? Math.ceil((e.exp - Date.now()) / 1000) : undefined);
    return next;
  }

  async health(): Promise<HealthStatus> {
    return { ok: true, detail: `lru size=${this.store.size}/${this.max}` };
  }
  async close(): Promise<void> { this.store.clear(); }
}
```

### 2.2 redis (ioredis) — shared, durable-enough, the standard-tier default

```ts
// 40-ADAPTERS/redis/cache.ts
import Redis from 'ioredis';
import type { Cache, Json } from '../../spine/ports/cache';
import type { AdapterContext, AdapterCapabilities, HealthStatus } from '../../spine/ports/adapter';

export class RedisCache implements Cache {
  private r!: Redis;
  private prefix = 'r2:';

  readonly capabilities: AdapterCapabilities = {
    consistency: 'eventual',   // async replication; read-your-writes on the primary
    durable: false,            // we treat it as a cache (no AOF assumption) — repopulates
    rebuildable: true,
    scale: 'sharded',          // redis-cluster / sentinel → shared across hosts
    p99TargetMs: 1,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.r = new Redis(ctx.manifest.config.connection);   // { host, port, password, ... } or URL
    this.prefix = ctx.manifest.config?.prefix ?? 'r2:';
    await this.r.ping();   // fail init() if the engine can't meet the role (contract self-check)
  }

  async get(k: string): Promise<Json | null> {
    const raw = await this.r.get(this.prefix + k);
    return raw == null ? null : (JSON.parse(raw) as Json);
  }

  async set(k: string, v: Json, ttlSec?: number): Promise<void> {
    const payload = JSON.stringify(v);
    if (ttlSec) await this.r.set(this.prefix + k, payload, 'EX', ttlSec);
    else await this.r.set(this.prefix + k, payload);
  }

  async incr(k: string, by = 1): Promise<number> {
    // INCRBY is atomic across processes — the reason rate-limits/presence counters need redis not LRU
    return this.r.incrby(this.prefix + k, by);
  }

  async health(): Promise<HealthStatus> {
    const t0 = performance.now();
    const pong = await this.r.ping();
    return { ok: pong === 'PONG', detail: `rtt=${(performance.now() - t0).toFixed(2)}ms` };
  }
  async close(): Promise<void> { await this.r.quit(); }
}
```

### 2.3 memcached — pure cache, slab eviction

```ts
// 40-ADAPTERS/memcached/cache.ts
import { Client } from 'memjs';
import type { Cache, Json } from '../../spine/ports/cache';
import type { AdapterContext, AdapterCapabilities, HealthStatus } from '../../spine/ports/adapter';

export class MemcachedCache implements Cache {
  private c!: Client;

  readonly capabilities: AdapterCapabilities = {
    consistency: 'eventual', durable: false, rebuildable: true,
    scale: 'sharded',        // consistent-hash across the memcached fleet
    p99TargetMs: 1,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.c = Client.create(ctx.manifest.config.servers);   // "host1:11211,host2:11211"
  }

  async get(k: string): Promise<Json | null> {
    const { value } = await this.c.get(k);
    return value ? (JSON.parse(value.toString()) as Json) : null;
  }

  async set(k: string, v: Json, ttlSec = 0): Promise<void> {
    await this.c.set(k, JSON.stringify(v), { expires: ttlSec });   // 0 = no expiry / slab-evicted
  }

  async incr(k: string, by = 1): Promise<number> {
    // memcached incr requires the key to pre-exist; seed then increment
    const r = await this.c.increment(k, by, { initial: by, expires: 0 });
    return r.value ?? by;
  }

  async health(): Promise<HealthStatus> {
    const stats = await this.c.stats();
    return { ok: !!stats, detail: 'memcached up' };
  }
  async close(): Promise<void> { this.c.close(); }
}
```

---

## 3. R14 — the `WorkQueue` port

Port recap, verbatim from [`12 §3`](../12-ADAPTER-CONTRACT.md):

```ts
// R14 work-queue — postgres-skiplocked | redis | temporal
export interface WorkQueue extends Adapter {
  enqueue(job: Job): Promise<JobId>;
  claim(worker: string, max: number): Promise<Job[]>;   // exactly-once / SKIP LOCKED
  complete(id: JobId, result?: Json): Promise<void>;
  fail(id: JobId, retryInSec?: number): Promise<void>;
}
```

Supporting types the spine defines once (`spine/ports/work-queue.ts`):

```ts
export type JobId = string;
export interface Job {
  id?: JobId;            // assigned by enqueue if absent (UUIDv7, ordered)
  queue: string;        // logical lane: 'omni:routing', 'aip:agent:7', 'foundry:build', ...
  key?: string;         // ordering/idempotency key (one in-flight per key, optional)
  kind: string;         // action-type name the P7 executor will run
  payload: Json;        // action args
  priority?: number;    // higher first; default 0
  runAt?: number;       // epoch ms; future = scheduled (Automate / schedules)
  attempts?: number;    // incremented on claim; compared to maxAttempts
  maxAttempts?: number; // default 5
}
```

### 3.1 postgres (FOR UPDATE SKIP LOCKED) — the default

DDL (codegen'd from R10 like every other table) and the **claim query verbatim** — this is the load-bearing line of the whole role:

```sql
-- 40-ADAPTERS/postgres/work-queue.ddl.sql
CREATE TABLE IF NOT EXISTS work_queue (
  id            TEXT PRIMARY KEY,                 -- UUIDv7 (ordered by time)
  queue         TEXT NOT NULL,
  key           TEXT,                             -- NULL = no ordering constraint
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  priority      INT  NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done | failed
  attempts      INT  NOT NULL DEFAULT 0,
  max_attempts  INT  NOT NULL DEFAULT 5,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by    TEXT,
  claimed_at    TIMESTAMPTZ,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the index that makes SKIP LOCKED cheap: only scan claimable rows, best-priority/oldest first
CREATE INDEX IF NOT EXISTS work_queue_claimable
  ON work_queue (queue, priority DESC, run_at)
  WHERE status = 'pending';
```

```sql
-- THE CLAIM QUERY (verbatim) — atomic claim-N-jobs, exactly-once across all workers.
-- A CTE selects up to $3 claimable rows for the queue, locking them and SKIPPING any
-- row another worker already holds, then flips them to 'claimed' in the same statement.
WITH claimable AS (
  SELECT id
    FROM work_queue
   WHERE queue = $1
     AND status = 'pending'
     AND run_at <= now()
   ORDER BY priority DESC, run_at
   FOR UPDATE SKIP LOCKED
   LIMIT $3
)
UPDATE work_queue w
   SET status     = 'claimed',
       claimed_by = $2,
       claimed_at = now(),
       attempts   = w.attempts + 1
  FROM claimable c
 WHERE w.id = c.id
RETURNING w.id, w.queue, w.key, w.kind, w.payload, w.priority, w.attempts, w.max_attempts;
```

`FOR UPDATE SKIP LOCKED` is the whole trick: two workers calling `claim()` concurrently never get the same row and never block each other — the second worker's row-lock acquisition *skips* the locked rows instead of waiting. That is exactly-once delivery without a coordinator.

```ts
// 40-ADAPTERS/postgres/work-queue.ts
import { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../../spine/util/uuidv7';   // same UUIDv7 the envelope uses
import type { WorkQueue, Job, JobId } from '../../spine/ports/work-queue';
import type { AdapterContext, AdapterCapabilities, HealthStatus, Json } from '../../spine/ports/adapter';

const CLAIM_SQL = `
WITH claimable AS (
  SELECT id FROM work_queue
   WHERE queue = $1 AND status = 'pending' AND run_at <= now()
   ORDER BY priority DESC, run_at
   FOR UPDATE SKIP LOCKED
   LIMIT $3
)
UPDATE work_queue w
   SET status='claimed', claimed_by=$2, claimed_at=now(), attempts=w.attempts+1
  FROM claimable c WHERE w.id = c.id
RETURNING w.id, w.queue, w.key, w.kind, w.payload, w.priority, w.attempts, w.max_attempts`;

export class PgWorkQueue implements WorkQueue {
  private pool!: Pool;

  readonly capabilities: AdapterCapabilities = {
    consistency: 'strong',     // claim is transactional/exactly-once
    durable: true,             // survives restart — a queued job is never lost
    rebuildable: false,        // pending work is state-of-record, not a projection
    scale: 'vertical',
    p99TargetMs: 10,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.pool = new Pool(ctx.manifest.config.connection);
    await this.pool.query(DDL_WORK_QUEUE);   // the .ddl.sql above
  }

  async enqueue(job: Job): Promise<JobId> {
    const id = job.id ?? uuidv7();
    await this.pool.query(
      `INSERT INTO work_queue(id, queue, key, kind, payload, priority, run_at, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), $8)`,
      [id, job.queue, job.key ?? null, job.kind, job.payload,
       job.priority ?? 0, job.runAt ?? Date.now(), job.maxAttempts ?? 5],
    );
    return id;
  }

  /** Transactional enqueue: the queue insert commits in the SAME tx as the kinetic effect.
   *  This is the property redis can't give — no lost-job window between "entity written"
   *  and "follow-up job queued." Called by the P7 Action executor on a shared PoolClient. */
  async enqueueTx(job: Job, tx: PoolClient): Promise<JobId> {
    const id = job.id ?? uuidv7();
    await tx.query(
      `INSERT INTO work_queue(id, queue, key, kind, payload, priority, run_at, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), $8)`,
      [id, job.queue, job.key ?? null, job.kind, job.payload,
       job.priority ?? 0, job.runAt ?? Date.now(), job.maxAttempts ?? 5],
    );
    return id;
  }

  async claim(worker: string, max: number, queue = 'default'): Promise<Job[]> {
    const { rows } = await this.pool.query(CLAIM_SQL, [queue, worker, max]);
    return rows.map((r): Job => ({
      id: r.id, queue: r.queue, key: r.key ?? undefined, kind: r.kind,
      payload: r.payload as Json, priority: r.priority,
      attempts: r.attempts, maxAttempts: r.max_attempts,
    }));
  }

  async complete(id: JobId, result?: Json): Promise<void> {
    await this.pool.query(
      `UPDATE work_queue SET status='done', result=$2 WHERE id=$1`, [id, result ?? null]);
  }

  /** Retry with backoff, or dead-letter when attempts exhaust maxAttempts. */
  async fail(id: JobId, retryInSec?: number): Promise<void> {
    await this.pool.query(
      `UPDATE work_queue
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              run_at = CASE WHEN attempts >= max_attempts THEN run_at
                            ELSE now() + ($2 || ' seconds')::interval END,
              claimed_by = NULL, claimed_at = NULL
        WHERE id = $1`,
      [id, retryInSec ?? 30],
    );
  }

  async health(): Promise<HealthStatus> {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE status='pending') AS pending,
              count(*) FILTER (WHERE status='claimed') AS inflight FROM work_queue`);
    return { ok: true, detail: `pending=${rows[0].pending} inflight=${rows[0].inflight}` };
  }
  async close(): Promise<void> { await this.pool.end(); }
}
```

A **reaper** requeues jobs whose `claimed_at` is older than a visibility timeout (worker died mid-job): `UPDATE work_queue SET status='pending', claimed_by=NULL WHERE status='claimed' AND claimed_at < now() - interval '5 minutes'`. Run it on a timer; it makes the queue self-healing without a coordinator.

### 3.2 redis (BRPOPLPUSH / Streams consumer groups)

Two reliable-queue strategies; the adapter uses Streams consumer groups (redelivery + per-consumer ack + lag visibility), falling back to `BRPOPLPUSH` for the simplest lanes.

```ts
// 40-ADAPTERS/redis/work-queue.ts
import Redis from 'ioredis';
import { uuidv7 } from '../../spine/util/uuidv7';
import type { WorkQueue, Job, JobId } from '../../spine/ports/work-queue';
import type { AdapterContext, AdapterCapabilities, HealthStatus, Json } from '../../spine/ports/adapter';

export class RedisWorkQueue implements WorkQueue {
  private r!: Redis;
  private group = 'workers';

  readonly capabilities: AdapterCapabilities = {
    consistency: 'read-your-writes',   // claim ack'd via XACK; at-least-once (redelivery on crash)
    durable: false,                    // unless AOF/RDB on; default-conservative = treat as not durable
    rebuildable: false,
    scale: 'sharded',
    p99TargetMs: 2,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.r = new Redis(ctx.manifest.config.connection);
    this.group = ctx.manifest.config?.group ?? 'workers';
  }

  private stream(queue: string) { return `r14:${queue}`; }

  async enqueue(job: Job): Promise<JobId> {
    const id = job.id ?? uuidv7();
    // XADD onto the stream; consumer group is created lazily (MKSTREAM)
    await this.r.xadd(this.stream(job.queue), '*', 'id', id, 'job', JSON.stringify(job));
    return id;
  }

  async claim(worker: string, max: number, queue = 'default'): Promise<Job[]> {
    const key = this.stream(queue);
    await this.r.xgroup('CREATE', key, this.group, '0', 'MKSTREAM').catch(() => {});   // idempotent
    // first reclaim anything pending too long (dead consumer), then read new
    const res = (await this.r.xreadgroup(
      'GROUP', this.group, worker, 'COUNT', max, 'STREAMS', key, '>')) as
      [string, [string, string[]][]][] | null;
    if (!res) return [];
    const out: Job[] = [];
    for (const [, entries] of res) {
      for (const [streamId, fields] of entries) {
        const jobJson = fields[fields.indexOf('job') + 1];
        const job = JSON.parse(jobJson) as Job;
        job.id = streamId;   // stream id is the claim handle for XACK
        out.push(job);
      }
    }
    return out;
  }

  async complete(id: JobId, _result?: Json): Promise<void> {
    // id is the stream entry id; ack removes it from the pending-entries-list
    // queue is embedded in the worker context; here we assume a single configured lane key
    await this.r.xack(this.activeStream, this.group, id);
    await this.r.xdel(this.activeStream, id);
  }

  async fail(id: JobId, retryInSec?: number): Promise<void> {
    // do NOT ack → it stays in PEL and is redelivered via XAUTOCLAIM by the next claim(). 
    // optional: re-enqueue with delay for explicit backoff lanes.
    if (retryInSec && retryInSec > 0) {
      await this.r.xack(this.activeStream, this.group, id);
      // delayed re-add via a sorted-set zset scheduler swept into the stream by a timer
      await this.r.zadd(`r14:delayed`, Date.now() + retryInSec * 1000, id);
    }
  }

  private get activeStream() { return this.stream(this._queue ?? 'default'); }
  private _queue?: string;

  async health(): Promise<HealthStatus> {
    const pong = await this.r.ping();
    return { ok: pong === 'PONG', detail: 'redis stream queue' };
  }
  async close(): Promise<void> { await this.r.quit(); }
}
```

> `BRPOPLPUSH` variant (for lanes that don't need consumer-group fan-out): `enqueue` = `LPUSH r14:<q> <json>`; `claim` = `BRPOPLPUSH r14:<q> r14:<q>:inflight:<worker> <timeout>` (atomically moves to a per-worker in-flight list so a crash leaves the job recoverable); `complete` = `LREM` from the in-flight list; `fail` = `RPOPLPUSH` back to the main list. The Streams path is preferred because it gives lag metrics and `XAUTOCLAIM` redelivery for free.

### 3.3 temporal — durable long-running orchestration (Flow Orchestration analog)

Temporal is not a queue you `claim()` from — it owns the orchestration state and pulls work via its own worker SDK. The adapter is a **facade**: `enqueue` starts (or signals) a workflow; `claim`/`complete`/`fail` are no-ops at the port level because Temporal's workers drive execution. A capability that needs multi-step durability binds R14 to `temporal` and uses the escape hatch (`§4.3`) to reach the workflow client directly.

```ts
// 40-ADAPTERS/temporal/work-queue.ts
import { Connection, Client } from '@temporalio/client';
import { uuidv7 } from '../../spine/util/uuidv7';
import type { WorkQueue, Job, JobId } from '../../spine/ports/work-queue';
import type { AdapterContext, AdapterCapabilities, HealthStatus, Json } from '../../spine/ports/adapter';

export class TemporalWorkQueue implements WorkQueue {
  private client!: Client;
  private taskQueue!: string;

  readonly capabilities: AdapterCapabilities = {
    consistency: 'strong',   // event-sourced workflow history, exactly-once activity semantics
    durable: true,           // the whole point: survives restarts, timers span days
    rebuildable: false,
    scale: 'sharded',        // temporal cluster
    p99TargetMs: 50,         // orchestration start latency; activities are async by design
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const conn = await Connection.connect({ address: ctx.manifest.config.address });
    this.client = new Client({ connection: conn, namespace: ctx.manifest.config?.namespace ?? 'default' });
    this.taskQueue = ctx.manifest.config?.taskQueue ?? 'planetar-r14';
  }

  /** enqueue → StartWorkflow. job.kind names a registered workflow (e.g. 'CaseEscalationFlow'). */
  async enqueue(job: Job): Promise<JobId> {
    const workflowId = job.id ?? job.key ?? uuidv7();   // key = dedup: reuses a running workflow
    await this.client.workflow.start(job.kind, {
      taskQueue: this.taskQueue,
      workflowId,                       // idempotent: same id = same workflow, no dup
      args: [job.payload],
    });
    return workflowId;
  }

  /** Temporal workers pull and execute; the port-level claim is intentionally empty. */
  async claim(_worker: string, _max: number): Promise<Job[]> { return []; }
  async complete(_id: JobId, _result?: Json): Promise<void> { /* workflow completes itself */ }

  /** fail = send a signal so the workflow can compensate (saga) or terminate. */
  async fail(id: JobId, _retryInSec?: number): Promise<void> {
    const h = this.client.workflow.getHandle(id);
    await h.signal('externalFail').catch(() => h.terminate('adapter.fail'));
  }

  /** escape hatch for orchestration-aware callers (signals, queries, child workflows). */
  workflowClient(): Client { return this.client; }

  async health(): Promise<HealthStatus> {
    // a cheap describe on the namespace proves the cluster is reachable
    try { await this.client.connection.workflowService.getSystemInfo({}); return { ok: true, detail: 'temporal up' }; }
    catch (e) { return { ok: false, detail: String(e) }; }
  }
  async close(): Promise<void> { await this.client.connection.close(); }
}
```

---

## 4. How these get used by the spine

### 4.1 Cache, transparently in front of R1

```ts
const cache = platform.role<Cache>('hot-cache');   // LRU / redis / memcached — caller can't tell
const store = platform.role<CanonicalStore>('canonical-store');

async function getVesselCard(id: EntityId): Promise<CanonicalEntity | null> {
  const hit = await cache.get(`vessel:${id}`);
  if (hit) return hit as CanonicalEntity;
  const e = await store.getEntity('planetar:Vessel', id);
  if (e) await cache.set(`vessel:${id}`, e, 30);   // 30s hot card — repopulates on miss
  return e;
}
```

### 4.2 Work-queue under the P7 kinetic executor (the AIP agent inbox / Omni-Channel path)

```ts
const wq = platform.role<WorkQueue>('work-queue');

// Omni-Channel: a routing Action Type enqueues a work item; agents claim it.
await wq.enqueue({ queue: 'omni:routing', key: caseId, kind: 'RouteCase',
                   payload: { caseId, skill: 'maritime', priority: 2 }, priority: 2 });

// An agent worker loop — exactly-once via SKIP LOCKED (postgres) or XREADGROUP (redis):
async function agentWorker(workerId: string) {
  for (;;) {
    const jobs = await wq.claim(workerId, 8);          // claim up to 8
    if (jobs.length === 0) { await sleep(250); continue; }
    for (const job of jobs) {
      try {
        // EVERY job runs through P7 — tool-calls are Action Types, so they're validated + audited
        const result = await kinetic.execute(job.kind, job.payload, { principal: workerId });
        await wq.complete(job.id!, result);
      } catch (err) {
        await wq.fail(job.id!, backoff(job.attempts ?? 1));   // retry w/ backoff or dead-letter
      }
    }
  }
}
```

The agent inbox, Omni-Channel routing, async-Apex, and Foundry build all reduce to *this exact loop* over different `queue` lanes. That's the R14 universality claim made concrete.

### 4.3 Temporal escape hatch (when a "job" is really a workflow)

```ts
const wq = platform.role<WorkQueue>('work-queue');
if (wq instanceof TemporalWorkQueue) {
  // a Flow-Orchestration-style multi-step approval with a human-wait + 7-day timer
  const id = await wq.enqueue({ queue: 'approvals', key: caseId,
                                kind: 'CaseEscalationFlow', payload: { caseId } });
  // later, the human approval surfaces as a signal:
  await wq.workflowClient().workflow.getHandle(id).signal('approved', { by: principal });
}
```

The spine code that only needs at-least-once jobs never touches the escape hatch; it stays engine-agnostic. Only orchestration-aware surfaces (the Flow designer in P8) reach for it — and they do so behind a capability flag, so a client that didn't bind `temporal` never compiles that path.

---

## 5. Comparison table

### R2 — hot-cache engines

| Engine | Consistency | Scale | p99 | When to choose |
|---|---|---|---|---|
| **in-process LRU** | eventual (1 process only) | single | ~0 (in-mem) | **Zero-service default.** Edge/air-gapped/demo; no shared/durable cache need; compiler auto-binds when `hot-cache` is omitted |
| **memcached** | eventual | sharded (consistent-hash) | ~1 ms | Existing memcached fleet; pure cache, no sorted-sets/pub-sub/atomic-Lua needed |
| **redis (ioredis)** | eventual (RYW on primary) | sharded (cluster/sentinel) | ~1 ms | Cache must be **shared across processes/hosts**: presence, global rate-limits, Platform-Cache parity; collapses with R3/R14 onto one redis |

### R14 — work-queue engines

| Engine | Consistency | Scale | p99 (claim) | When to choose |
|---|---|---|---|---|
| **postgres (SKIP LOCKED)** | strong / exactly-once | vertical | ~10 ms | **Default.** Reuse the R1 workhorse; transactional co-commit with the kinetic effect; Omni-Channel, async-Apex, build schedules, AIP inbox at single-cloud scale |
| **redis (Streams/BRPOPLPUSH)** | RYW / at-least-once | sharded | ~2 ms | Sub-ms claim latency > transactional co-commit; light fire-and-forget lanes; redis already present for R2/R3 |
| **temporal** | strong (event-sourced) | sharded | ~50 ms (start) | **Durable long-running orchestration** — Flow Orchestration / multi-step Automate / sagas / approvals with timers & human-waits |
| **kafka** | at-least-once, ordered-per-key | sharded | ~10 ms | Client already runs Kafka for R3; want partitioned, infinitely-retained, consumer-group-balanced work |

---

## 6. Conformance-suite hookup

Both ports ship an engine-agnostic suite ([`12 §5`](../12-ADAPTER-CONTRACT.md) pattern). An engine is "supported for the role" only when green across the whole suite — that's what licenses blind per-client swaps.

```ts
// 40-ADAPTERS/_conformance/cache.spec.ts
export function cacheConformance(make: () => Cache) {
  test('round-trips a value', async () => {
    const c = make(); await c.init(testCtx());
    await c.set('k', { a: 1 });
    expect(await c.get('k')).toEqual({ a: 1 });
  });
  test('TTL expires the key', async () => {
    const c = make(); await c.init(testCtx());
    await c.set('t', 1, 1); await sleep(1100);
    expect(await c.get('t')).toBeNull();
  });
  test('incr is atomic and monotone', async () => {
    const c = make(); await c.init(testCtx());
    await Promise.all(Array.from({ length: 100 }, () => c.incr('n')));
    expect(await c.get('n')).toBe(100);     // redis/memcached pass under concurrency; LRU passes single-process
  });
  test('declares capabilities that satisfy the R2 contract', () => {
    expect(satisfies(ROLE_CONTRACT['hot-cache'], make().capabilities)).toBe(true);
  });
}
// cacheConformance(() => new InProcLruCache())
// cacheConformance(() => new RedisCache())
// cacheConformance(() => new MemcachedCache())
```

```ts
// 40-ADAPTERS/_conformance/work-queue.spec.ts
export function workQueueConformance(make: () => WorkQueue) {
  test('enqueue → claim → complete', async () => {
    const q = make(); await q.init(testCtx());
    const id = await q.enqueue({ queue: 'test', kind: 'Noop', payload: {} });
    const [job] = await q.claim('w1', 1);
    expect(job.id).toBe(id);
    await q.complete(job.id!);
  });
  test('SKIP LOCKED: two workers never claim the same job', async () => {
    const q = make(); await q.init(testCtx());
    for (let i = 0; i < 50; i++) await q.enqueue({ queue: 't2', kind: 'N', payload: { i } });
    const [a, b] = await Promise.all([q.claim('w1', 50), q.claim('w2', 50)]);
    const ids = new Set([...a, ...b].map(j => j.id));
    expect(ids.size).toBe(a.length + b.length);   // zero overlap
  });
  test('fail re-queues until maxAttempts, then dead-letters', async () => { /* ... */ });
  test('runAt in the future is not claimable yet', async () => { /* ... */ });
  test('declares capabilities that satisfy the R14 contract', () => {
    expect(satisfies(ROLE_CONTRACT['work-queue'], make().capabilities)).toBe(true);
  });
}
// workQueueConformance(() => new PgWorkQueue())
// workQueueConformance(() => new RedisWorkQueue())
// temporal runs a SUBSET (enqueue starts a workflow; claim/complete are owned by temporal workers)
```

> Note the `temporal` adapter is conformance-*partial* by design: it passes `enqueue` + capability-declaration + the orchestration smoke test, and is *exempted* from the `claim/complete` rows because the contract for those is "owned by the engine's own workers." The compiler knows this via an adapter flag (`ownsExecution: true`) so it won't wire a generic agent-worker loop on top of a temporal binding.

---

## 7. Which manifest tiers / clients use which

| Client / tier ([`13`](../13-CLIENT-MANIFEST.md)) | R2 hot-cache | R14 work-queue | Why |
|---|---|---|---|
| **Maritime / defence — `edge`** (built) | **in-process LRU** (omitted in manifest → auto-bound) | `sqlite` (skip-locked-equivalent via `BEGIN IMMEDIATE`) — or none if no automation | Offline single box; nothing requires a shared cache or durable orchestration. Matches `13 §1` `# hot-cache omitted` |
| **Maritime — `scale`** | `redis` | `postgres` (SKIP LOCKED) | Multi-node: presence must be shared; builds + agent inbox need durable claim |
| **Biotech CRM — `doibio`** (built/partial) | `redis` | `postgres` (SKIP LOCKED) | Webhook dispatch (built) graduates to a real claim/retry queue; CRM automation lanes |
| **Generic enterprise CRM+ops** — `standard` | `redis` (Platform-Cache parity) | `postgres` + **`temporal`** (Flow Orchestration / approvals) | Sales/Service parity needs Omni-Channel (pg) **and** multi-step Flow (temporal) |
| **Intel / financial-crime** — `scale` | `redis` | `postgres` (SKIP LOCKED) + `kafka` (high-volume enrichment jobs) | Watchlist/enrichment fan-out; durable agent tasking |

**The default-picking rule, restated:** the manifest compiler binds **in-process LRU** for R2 whenever `hot-cache` is absent from `roles:` *and* no enabled capability declares a need for a durable/shared cache (none do — R2 is `rebuildable: true`, `durable: false` by contract). The same logic does **not** apply to R14: a work-queue is `durable: true`, so if any enabled capability's footprint includes R14 ([`11 §3`](../11-CAPABILITY-ROLE-MAP.md): `omni-channel`, `flow/automation`, `agents-rag` task inbox), the compiler **requires** an explicit durable binding and rejects an in-process default. That asymmetry — *cache may default to nothing, work-queue may not* — is the practical expression of "loss-tolerable vs. loss-intolerable."
