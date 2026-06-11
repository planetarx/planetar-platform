# 40-ADAPTERS · Governance — Registry (R10) + Audit (R11) + Lineage (R12) + Policy-Identity (R13)

**Roles:** R10 · registry, R11 · audit-log, R12 · lineage, R13 · policy-identity — the four roles that make up the cross-cutting **P1 Governance** plane (plus R10, which is P0/P1-adjacent: the SSOT every plane reads at boot).
**Engines:** R10 → `git-fs` (default) · `sqlite` · `postgres`. R11 → `append-wal` (default) · `clickhouse` · `kafka` · `postgres`. R12 → `marquez`/OpenLineage (default) · the R5 `graph` engine · `postgres`. R13 → `keycloak` (authn/SSO/SCIM) + `OPA` (authz PDP) default · `postgres` · `internal` (edge).
**Status:** **partial → designed.** R10 is **built** as a vertical slice (`~/github/planetarx/planetar-registry`; `planetar-ontology/registry/types.json` is the loaded SSOT, codegen toolchain green). R11 is **partial** — an immutable, ULID-ordered, append-only event log exists in two repos (doibio `src/lib/event-log.ts`; the broker's WAL+CRC32 is an audit substrate) but tamper-evidence hash-chaining and SIEM export are **designed** here, not yet built. R12 is **designed** — the canonical model already carries per-field `provenance` (`planetar-ontology/src/store/schema.sql`, `entity.provenance TEXT NOT NULL`), so the field-level substrate exists; the OpenLineage emit + impact traversal are designed. R13 is **designed** (Keycloak+OPA wiring) with a **built** edge fallback (the ontology's in-process principal check + kinetic gate). **Marking propagation along R12 — the roadmap's "propagating security" — is the new design this file pins down concretely.**

> This is the **hardest-to-clone** piece. Foundry's moat isn't its object storage; it's that a *marking applied once at ingest* follows the data through every transform to every derived store, object, and surface, and every read is checked against it. Salesforce re-implements security per object (OWD + sharing + FLS + Shield). We do it **once**, in the governance plane, and the lineage graph (R12) is the carrier. §4 designs the propagation; everything else is the plumbing that makes it enforceable.

---

## 1. Intro — which roles, which engines, when to pick each

The four governance roles are different in kind from the storage roles (R1–R9): they don't hold *the data*, they hold *the rules and the record about the data*. But they obey the same discipline — each is a **port** ([`12`](../12-ADAPTER-CONTRACT.md)); the spine depends on the port, the manifest binds the engine, and one conformance suite (§6) guarantees the swap is safe.

| Role | Holds | Default | Pick the alt when… |
|---|---|---|---|
| **R10 registry** | SSOT for schema/object/link/action/manifest defs; loaded into a compiled in-memory copy at boot (no I/O on the data path) | `git-fs` (matches the canonical model's git-vault SSOT; PR-reviewed, SemVer-tagged, diffable) | `sqlite`/`postgres` when a *running registry service* with a write API is wanted (multi-author live edits, no git workflow) |
| **R11 audit-log** | Immutable record of every read/write/export/admin/AI action; exportable to a client SIEM | `append-wal` (broker-style, zero external deps, edge-friendly) | `clickhouse` when you must *query* audit at scale (Shield-style Event Monitoring dashboards); `kafka` when you stream straight to a SIEM; `postgres` when one engine must cover it all |
| **R12 lineage** | Provenance graph: source→observation→entity→derivation edges; field-level provenance; impact analysis. **The carrier for marking propagation.** | `marquez` (OpenLineage standard, postgres-backed, mature UI = Foundry Monocle parity) | reuse the **R5 graph engine** (falkordb/neo4j) when lineage queries are graph-shaped and you already run a graph; `postgres` (recursive CTE) at small scale |
| **R13 policy-identity** | Principals (users, service accounts, AI agents), roles, group/territory membership, markings, and the **PDP** that answers `can principal do action on resource under marking?` | `keycloak` (authn/SSO/SAML/OIDC/SCIM) **+** `OPA` (authz decisions, default-deny Rego) | `postgres` for a single-store internal IdP; `internal` for edge/air-gapped (local principals + an *embedded* OPA bundle, no network) |

**The collapse rule still applies.** A minimal edge box ([`10 §3`](../10-STORAGE-ROLES.md)) binds R10→`git-fs`, R11→`append-wal` (the broker WAL *is* the audit substrate), R12→`postgres` (or the same sqlite, recursive-CTE lineage), R13→`internal` — **zero external governance services**, yet markings still propagate (the propagation engine is spine code; the *store* under it is swappable). A regulated cloud binds `marquez` + `keycloak` + `OPA` + `clickhouse` and gets Monocle-class lineage, SSO, a queryable SIEM feed, and a default-deny PDP — **same spine, same propagation rules, same audit envelopes.**

### 1.1 The PEP/PDP split (load-bearing for R13)

R13 is **two halves**: a **PDP** (Policy Decision Point — "may this happen?") and many **PEPs** (Policy Enforcement Points — the code that *asks* and obeys). In this platform **the PDP is OPA** (or the embedded bundle at the edge), and **every storage adapter is a PEP**: the base `Adapter` receives a `MarkingResolver` in its `AdapterContext` ([`12 §1`](../12-ADAPTER-CONTRACT.md)). That is not decoration — it means the Postgres canonical-store, the OpenSearch index, the falkordb graph, and the blob-CAS *each* call the PDP before returning rows, and each filters its own result set. There is no "security service" the application must remember to call; enforcement is woven into the role adapters, exactly as principle 4 in [`00 §3`](../00-ARCHITECTURE-OVERVIEW.md) demands.

### 1.2 Foundry / Salesforce mapping

| This platform | Palantir Foundry/Gotham | Salesforce |
|---|---|---|
| R10 registry (`git-fs`) | Ontology Manager, branch/merge of ontology | Metadata API, Custom Metadata Types, change sets |
| R11 audit-log (`append-wal`/`clickhouse`) | Comprehensive Audit, usage observability | Shield **Event Monitoring**, **Setup Audit Trail**, **Field Audit Trail** |
| R12 lineage (`marquez`) | **Data Lineage / Monocle**, Markings *propagation* | Data Cloud lineage-to-source (no field-level marking propagation — the gap we close) |
| R13 policy-identity (`keycloak`+`OPA`) | **Markings**, orgs/spaces, RBAC, **purpose-based access**, Control Panel | profiles, **permission sets**, **OWD**, **sharing rules**, **FLS**, Shield, roles/territories |
| Marking propagation (§4, spine) | The Foundry differentiator | **No equivalent** — SF security is re-declared per object; this is the clone-resistant piece |

---

## 2. R10 · Registry — `Registry` port

The registry is read-all-at-boot, versioned (SemVer per type), and governed-write. Its port:

```ts
// spine/ports/registry.ts
import type { Adapter } from './adapter';

export type SemVer = `${number}.${number}.${number}`;
export type DefnKind = 'schema' | 'object-type' | 'link-type' | 'action-type' | 'manifest' | 'marking';

export interface Definition {
  kind: DefnKind;
  id: string;                 // e.g. 'planetar:Vessel'
  version: SemVer;            // bumped on every governed write
  body: Json;                 // the JSON-Schema / ontology def / manifest
  hash: string;               // sha256(canonical-json(body)) — content address
  author: string;             // principal id (from R13)
  ts: number;                 // ns
}

export interface Registry extends Adapter {
  /** Load every definition into a compiled in-memory snapshot (called once at boot). */
  loadAll(): Promise<Map<string, Definition>>;
  /** Point read of the latest (or a pinned) version. */
  get(id: string, version?: SemVer): Promise<Definition | null>;
  /** Governed write: validates, SemVer-bumps, records author; returns the new version. */
  put(def: Omit<Definition, 'version' | 'hash' | 'ts'>, bump: 'major' | 'minor' | 'patch'): Promise<Definition>;
  /** Version history (for diff/rollback/sandbox-branching, 11 §2). */
  history(id: string): Promise<Definition[]>;
  /** Structural diff between two versions (drives the manifest-change preview). */
  diff(id: string, from: SemVer, to: SemVer): Promise<DefnDiff>;
}
```

### 2.1 `GitFsRegistry` (default — `git` + filesystem, zero-dep, PR-reviewed)

The git-vault *is* the SSOT (matches `ARCH-canonical-data-model.md`). Versions are git history; SemVer lives in the file; a write is a commit. No daemon, no DB, air-gap-trivial.

```ts
// 40-ADAPTERS/governance/git-fs-registry.ts
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Registry, Definition, DefnDiff, SemVer, AdapterContext, HealthStatus,
} from '../../spine/ports/registry';

const git = promisify(execFile);
const canon = (b: unknown) => JSON.stringify(b, Object.keys(b as object).sort());
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
function bumpVer(v: SemVer, k: 'major' | 'minor' | 'patch'): SemVer {
  const [maj, min, pat] = v.split('.').map(Number);
  return (k === 'major' ? `${maj + 1}.0.0` : k === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`) as SemVer;
}

export class GitFsRegistry implements Registry {
  private root!: string;                       // e.g. ./registry
  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: false,   // it IS the source
    scale: 'single', p99TargetMs: 1,           // in-memory after loadAll; disk only on write
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.root = (ctx.manifest.config as { path: string }).path;
    await mkdir(this.root, { recursive: true });
    // contract self-check: must be a git repo (history = versioning)
    await git('git', ['-C', this.root, 'rev-parse', '--git-dir']).catch(() => {
      throw new Error(`registry path ${this.root} is not a git repo`);
    });
  }

  async loadAll(): Promise<Map<string, Definition>> {
    const out = new Map<string, Definition>();
    for (const f of await readdir(this.root, { recursive: true })) {
      if (!f.endsWith('.json')) continue;
      const def = JSON.parse(await readFile(join(this.root, f), 'utf8')) as Definition;
      // verify content address — a tampered registry file fails the boot, not silently
      if (def.hash !== sha256(canon(def.body))) throw new Error(`registry hash mismatch: ${def.id}`);
      out.set(def.id, def);                    // last write wins; history() walks git for prior versions
    }
    return out;
  }

  async get(id: string, version?: SemVer): Promise<Definition | null> {
    const file = join(this.root, `${id.replace(':', '/')}.json`);
    if (!version) return JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
    // pinned version → read that file content at the tagged commit
    const { stdout } = await git('git', ['-C', this.root, 'show', `${id}@${version}:${file}`]).catch(() => ({ stdout: 'null' }));
    return JSON.parse(stdout);
  }

  async put(d: Omit<Definition, 'version' | 'hash' | 'ts'>, bump: 'major' | 'minor' | 'patch'): Promise<Definition> {
    const prev = await this.get(d.id);
    const version = bumpVer((prev?.version ?? '0.0.0') as SemVer, prev ? bump : 'patch');
    const def: Definition = { ...d, version, hash: sha256(canon(d.body)), ts: Date.now() * 1e6 };
    const file = join(this.root, `${d.id.replace(':', '/')}.json`);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(def, null, 2));
    // a governed write = a reviewed commit tagged with the SemVer (audit trail = git log)
    await git('git', ['-C', this.root, 'add', file]);
    await git('git', ['-C', this.root, 'commit', '-m', `${d.kind} ${d.id} → ${version} (by ${d.author})`]);
    await git('git', ['-C', this.root, 'tag', '-f', `${d.id}@${version}`]);
    return def;
  }

  async history(id: string): Promise<Definition[]> {
    const file = join(this.root, `${id.replace(':', '/')}.json`);
    const { stdout } = await git('git', ['-C', this.root, 'log', '--format=%H', '--', file]);
    const defs: Definition[] = [];
    for (const sha of stdout.trim().split('\n').filter(Boolean)) {
      const { stdout: body } = await git('git', ['-C', this.root, 'show', `${sha}:${file}`]);
      defs.push(JSON.parse(body));
    }
    return defs;
  }

  async diff(id: string, from: SemVer, to: SemVer): Promise<DefnDiff> {
    const a = await this.get(id, from), b = await this.get(id, to);
    return structuralDiff(a?.body, b?.body);   // shared util: added/removed/changed field paths
  }

  async health(): Promise<HealthStatus> {
    await git('git', ['-C', this.root, 'status', '--porcelain']);
    return { ok: true };
  }
  async close(): Promise<void> {}
}
```

### 2.2 `SqlRegistry` (`sqlite`/`postgres` — running registry service variant)

When live multi-author edits beat the git workflow, the same port over a table. SemVer is a column; `history` is a `SELECT … ORDER BY ts`. The spine cannot tell which one is bound.

```ts
// 40-ADAPTERS/governance/sql-registry.ts
export class SqlRegistry implements Registry {
  private sql!: SqlClient;                      // sqlite (node:sqlite) or pg, dialect-parameterized
  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: false, scale: 'vertical', p99TargetMs: 2,
  } as const;

  async init(ctx: AdapterContext) {
    this.sql = openSql(ctx.manifest.config);    // shared helper; abstracts sqlite vs pg
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS registry(
      id TEXT, version TEXT, kind TEXT, body TEXT, hash TEXT, author TEXT, ts INTEGER,
      PRIMARY KEY(id, version))`);
  }
  async loadAll() {
    const rows = await this.sql.all(
      `SELECT r.* FROM registry r JOIN (SELECT id, MAX(ts) t FROM registry GROUP BY id) m
       ON r.id=m.id AND r.ts=m.t`);
    return new Map(rows.map(r => [r.id, { ...r, body: JSON.parse(r.body) } as Definition]));
  }
  async put(d, bump) {
    const prev = await this.get(d.id);
    const version = bumpVer((prev?.version ?? '0.0.0') as SemVer, prev ? bump : 'patch');
    const def: Definition = { ...d, version, hash: sha256(canon(d.body)), ts: Date.now() * 1e6 };
    await this.sql.run(`INSERT INTO registry(id,version,kind,body,hash,author,ts) VALUES(?,?,?,?,?,?,?)`,
      [def.id, version, def.kind, JSON.stringify(def.body), def.hash, def.author, def.ts]);
    return def;
  }
  /* get/history/diff/health/close as expected; history = SELECT ... WHERE id=? ORDER BY ts */
}
```

---

## 3. R11 · Audit-Log + R12 · Lineage + R13 · Policy-Identity — the three other ports

```ts
// spine/ports/audit-log.ts  (R11)
export interface AuditRecord {
  id: string;                 // ULID — k-sortable, monotone
  ts: number;                 // ns
  principal: string;          // who (user / service / AI agent), from R13
  action: 'read' | 'write' | 'export' | 'admin' | 'ai-invoke' | 'action-type';
  resourceType: string; resourceId: string;
  markings: string[];         // markings in effect on the touched resource (carried from R12)
  purpose?: string;           // purpose-based-access tag (Foundry purpose)
  outcome: 'allow' | 'deny';
  detail?: Json;
  prevHash?: string;          // hash-chain link to the previous record (tamper-evidence)
  hash?: string;              // sha256(canon(this record sans hash) + prevHash)
}
export interface AuditLog extends Adapter {
  append(rec: Omit<AuditRecord, 'hash' | 'prevHash'>): Promise<AuditRecord>;  // chains + persists
  scan(q: AuditQuery): Promise<AuditRecord[]>;          // time/principal/resource filter
  verify(from?: string, to?: string): Promise<{ ok: boolean; brokenAt?: string }>; // re-walk the chain
  export(q: AuditQuery, fmt: 'cef' | 'leef' | 'ocsf' | 'jsonl'): AsyncIterable<string>; // SIEM
}

// spine/ports/lineage.ts  (R12)
export type LineageNodeKind = 'source' | 'observation' | 'entity' | 'dataset' | 'derivation' | 'field';
export interface LineageNode { id: string; kind: LineageNodeKind; ref: string; markings: string[]; }
export interface LineageEdge { from: string; to: string; transform: string; fields?: string[]; ts: number; }
export interface Lineage extends Adapter {
  recordNode(n: LineageNode): Promise<void>;
  recordEdge(e: LineageEdge): Promise<void>;
  upstream(id: string, depth?: number): Promise<Subgraph>;     // where did this come from?
  downstream(id: string, depth?: number): Promise<Subgraph>;   // impact analysis: what derives from this?
  fieldProvenance(entityId: string, field: string): Promise<LineageNode[]>; // per-field source chain
  /** The propagation primitive: every node reachable downstream of `id`. Used by §4. */
  propagateMarking(id: string, marking: string): Promise<string[]>; // returns affected node ids
}

// spine/ports/policy-identity.ts  (R13)
export interface Principal { id: string; kind: 'user' | 'service' | 'agent'; roles: string[]; groups: string[]; clearances: string[]; }
export interface Decision { allow: boolean; reason: string; obligations?: { filterFields?: string[]; redact?: string[] }; }
export interface PolicyIdentity extends Adapter {
  // authn (Keycloak): issue / verify tokens, SCIM-synced principals
  verifyToken(jwt: string): Promise<Principal | null>;
  principal(id: string): Promise<Principal | null>;
  // authz (OPA PDP): the one decision every PEP asks — DEFAULT DENY
  decide(input: { principal: Principal; action: string; resourceType: string; resourceId: string; markings: string[]; purpose?: string }): Promise<Decision>;
}
```

### 3.1 `AppendWalAuditLog` (R11 default — broker-style WAL, hash-chained, SIEM export)

Append-only, fsync'd, **hash-chained** so any deletion or edit breaks the chain (tamper-evidence — the property Foundry audit and SF Field Audit Trail sell). `verify()` re-walks; `export()` streams CEF/LEEF/OCSF to a SIEM. Backing substrate exists: the broker's WAL+CRC32 and doibio's append-only `event-log.ts`; this adds the chain + SIEM codecs.

```ts
// 40-ADAPTERS/governance/append-wal-audit.ts
import { open, FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import type { AuditLog, AuditRecord, AuditQuery, AdapterContext, HealthStatus } from '../../spine/ports/audit-log';

const canon = (r: object) => JSON.stringify(r, Object.keys(r).sort());
const link = (rec: object, prev: string) => createHash('sha256').update(canon(rec) + prev).digest('hex');

export class AppendWalAuditLog implements AuditLog {
  private fh!: FileHandle;
  private tail = '0'.repeat(64);                // genesis prevHash
  readonly capabilities = {
    consistency: 'append-only', durable: true, rebuildable: false,   // it is EVIDENCE — never rebuilt
    scale: 'vertical', p99TargetMs: 5,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const path = (ctx.manifest.config as { path: string }).path + '/audit.wal';
    this.fh = await open(path, 'a+');
    // recover the chain tail so a restart continues the same chain (no chain break across reboots)
    const buf = await this.fh.readFile('utf8');
    const last = buf.trimEnd().split('\n').at(-1);
    if (last) this.tail = (JSON.parse(last) as AuditRecord).hash!;
  }

  async append(r: Omit<AuditRecord, 'hash' | 'prevHash'>): Promise<AuditRecord> {
    const rec: AuditRecord = { ...r, id: r.id ?? ulid(), prevHash: this.tail, hash: '' };
    rec.hash = link({ ...rec, hash: '' }, this.tail);
    await this.fh.appendFile(JSON.stringify(rec) + '\n');
    await this.fh.sync();                        // fsync — survive restart, the R11 durability contract
    this.tail = rec.hash;
    return rec;
  }

  async *scan(q: AuditQuery): AsyncGenerator<AuditRecord> {
    const buf = await this.fh.readFile('utf8');
    for (const line of buf.split('\n')) {
      if (!line) continue;
      const rec = JSON.parse(line) as AuditRecord;
      if (q.principal && rec.principal !== q.principal) continue;
      if (q.from && rec.ts < q.from) continue;
      if (q.to && rec.ts > q.to) continue;
      if (q.resourceId && rec.resourceId !== q.resourceId) continue;
      yield rec;
    }
  }

  async verify(): Promise<{ ok: boolean; brokenAt?: string }> {
    let prev = '0'.repeat(64);
    for await (const rec of this.scan({})) {
      if (rec.prevHash !== prev) return { ok: false, brokenAt: rec.id };
      if (rec.hash !== link({ ...rec, hash: '', prevHash: rec.prevHash }, prev)) return { ok: false, brokenAt: rec.id };
      prev = rec.hash!;
    }
    return { ok: true };
  }

  async *export(q: AuditQuery, fmt: 'cef' | 'leef' | 'ocsf' | 'jsonl'): AsyncGenerator<string> {
    for await (const rec of this.scan(q)) yield SIEM[fmt](rec);   // codec table → ArcSight/QRadar/Splunk
  }

  async health(): Promise<HealthStatus> { const v = await this.verify(); return { ok: v.ok, detail: v }; }
  async close(): Promise<void> { await this.fh.close(); }
}

// SIEM codecs — CEF (ArcSight), LEEF (QRadar), OCSF (Splunk/AWS Security Lake), raw JSONL
const SIEM = {
  cef: (r: AuditRecord) =>
    `CEF:0|Planetar|Platform|1.0|${r.action}|${r.action}|5|` +
    `suser=${r.principal} act=${r.outcome} cs1Label=markings cs1=${r.markings.join(',')} ` +
    `cs2Label=resource cs2=${r.resourceType}/${r.resourceId} rt=${Math.floor(r.ts / 1e6)}`,
  leef: (r: AuditRecord) =>
    `LEEF:2.0|Planetar|Platform|1.0|${r.action}|usrName=${r.principal}\tresource=${r.resourceType}/${r.resourceId}\t` +
    `markings=${r.markings.join(',')}\toutcome=${r.outcome}`,
  ocsf: (r: AuditRecord) => JSON.stringify({
    class_uid: 6003, activity_id: r.action, actor: { user: { name: r.principal } },
    resources: [{ type: r.resourceType, uid: r.resourceId, labels: r.markings }],
    status: r.outcome, time: Math.floor(r.ts / 1e6),
  }),
  jsonl: (r: AuditRecord) => JSON.stringify(r),
} as const;
```

`ClickhouseAuditLog` / `KafkaAuditLog` implement the same port: `append` becomes an `INSERT`/`produce`, `scan` a `SELECT`/consumer, `export` a materialized query / a sink topic the SIEM consumes directly. The hash-chain travels in the row/message, so tamper-evidence is engine-independent. Bind `clickhouse` when audit must be *queried* (Shield Event Monitoring dashboards over billions of rows); `kafka` when the SIEM pulls the stream.

### 3.2 `MarquezLineage` (R12 default — OpenLineage / Marquez, the Monocle parity)

OpenLineage is the open standard for run/job/dataset lineage; Marquez is its reference store (postgres-backed, with a UI = Foundry Monocle). We emit OpenLineage events on every transform and add **field-level + marking** facets the base spec doesn't standardize.

```ts
// 40-ADAPTERS/governance/marquez-lineage.ts
import { OpenLineageClient, RunEvent } from '@openlineage/client';
import type { Lineage, LineageNode, LineageEdge, Subgraph, AdapterContext, HealthStatus } from '../../spine/ports/lineage';

export class MarquezLineage implements Lineage {
  private ol!: OpenLineageClient;
  private ns = 'planetar';
  readonly capabilities = {
    consistency: 'read-your-writes', durable: true, rebuildable: true,  // re-derivable from R3 + transform meta
    scale: 'vertical', p99TargetMs: 50,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    this.ol = new OpenLineageClient({ url: (ctx.manifest.config as { url: string }).url });  // http://marquez:5000
    this.ns = (ctx.manifest.config as { namespace?: string }).namespace ?? 'planetar';
  }

  async recordNode(n: LineageNode): Promise<void> {
    // a node = an OpenLineage *dataset* carrying our marking facet (the propagation payload)
    await this.ol.emit(this.datasetEvent(n));
  }

  async recordEdge(e: LineageEdge): Promise<void> {
    // an edge = an OpenLineage *run* with input=from, output=to, and a columnLineage facet for field-level
    const run: RunEvent = {
      eventType: 'COMPLETE', eventTime: new Date(e.ts / 1e6).toISOString(),
      run: { runId: crypto.randomUUID() },
      job: { namespace: this.ns, name: e.transform },
      inputs: [{ namespace: this.ns, name: e.from }],
      outputs: [{
        namespace: this.ns, name: e.to,
        facets: e.fields ? { columnLineage: this.columnLineage(e.from, e.fields) } : undefined,
      }],
      producer: 'planetar-platform',
    };
    await this.ol.emit(run);
  }

  async upstream(id: string, depth = 8): Promise<Subgraph> { return this.lineageQuery(id, 'upstream', depth); }
  async downstream(id: string, depth = 8): Promise<Subgraph> { return this.lineageQuery(id, 'downstream', depth); }

  async fieldProvenance(entityId: string, field: string): Promise<LineageNode[]> {
    // walk columnLineage facets back from entity.<field> to its source observation node(s)
    const sub = await this.upstream(`${entityId}#${field}`, 16);
    return sub.nodes.filter(n => n.kind === 'observation' || n.kind === 'source');
  }

  async propagateMarking(id: string, marking: string): Promise<string[]> {
    // §4: every downstream node inherits the marking; Marquez query gives the closure,
    // then we re-emit each as a dataset event with the marking added to its facet.
    const sub = await this.downstream(id, 64);
    const affected: string[] = [];
    for (const n of sub.nodes) {
      if (n.markings.includes(marking)) continue;
      n.markings = [...n.markings, marking];
      await this.recordNode(n);               // re-stamp the lineage node
      affected.push(n.id);
    }
    return affected;
  }

  async health(): Promise<HealthStatus> { return { ok: !!this.ol }; }
  async close(): Promise<void> {}
  // datasetEvent / columnLineage / lineageQuery: OpenLineage facet builders + Marquez REST traversal
}
```

`GraphLineage` reuses the **R5 `GraphStore` port** (falkordb/neo4j): nodes/edges are graph nodes/edges, `upstream`/`downstream` are Cypher traversals, `propagateMarking` is one `MATCH (n)-[:DERIVES*]->(m) SET m.markings = m.markings + $marking`. `PgLineage` does it with a recursive CTE. Same port; pick `graph` when you already run R5 and lineage is graph-shaped, `marquez` when you want the standard + the Monocle-class UI for free.

### 3.3 `KeycloakOpaPolicy` (R13 default — Keycloak authn + OPA PDP, default-deny)

Keycloak issues/validates tokens (OIDC/SAML), syncs principals via SCIM, maps roles/groups. OPA is the PDP: a Rego bundle answers every `decide()` with **default deny**. Decisions cache in R2 (hot-cache) keyed on `(principal, action, resource, markings)`.

```ts
// 40-ADAPTERS/governance/keycloak-opa-policy.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { PolicyIdentity, Principal, Decision, AdapterContext, HealthStatus } from '../../spine/ports/policy-identity';

export class KeycloakOpaPolicy implements PolicyIdentity {
  private jwks!: ReturnType<typeof createRemoteJWKSet>;
  private issuer!: string;
  private opaUrl!: string;
  readonly capabilities = {
    consistency: 'strong', durable: true, rebuildable: false, scale: 'vertical', p99TargetMs: 10,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const c = ctx.manifest.config as { realm: string; keycloakUrl: string; opaUrl: string };
    this.issuer = `${c.keycloakUrl}/realms/${c.realm}`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/protocol/openid-connect/certs`));
    this.opaUrl = c.opaUrl;                      // http://opa:8181/v1/data/planetar/authz/decision
  }

  async verifyToken(jwt: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(jwt, this.jwks, { issuer: this.issuer });
      return {
        id: payload.sub!, kind: (payload.kind as Principal['kind']) ?? 'user',
        roles: (payload.realm_access as { roles: string[] })?.roles ?? [],
        groups: (payload.groups as string[]) ?? [],
        clearances: (payload.clearances as string[]) ?? [],   // mapped from Keycloak attributes → markings a principal MAY see
      };
    } catch { return null; }
  }

  async principal(id: string): Promise<Principal | null> {
    // Keycloak Admin REST / SCIM — fetch a service-account or agent principal not presenting a token
    const res = await fetch(`${this.issuer}/users/${id}`, { headers: await this.svcAuth() });
    return res.ok ? this.toPrincipal(await res.json()) : null;
  }

  /** DEFAULT DENY. Every storage adapter (PEP) calls this before returning a row. */
  async decide(input: Parameters<PolicyIdentity['decide']>[0]): Promise<Decision> {
    const res = await fetch(this.opaUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) return { allow: false, reason: 'pdp-unreachable (fail-closed)' };  // fail closed, never open
    const { result } = await res.json() as { result?: Decision };
    return result ?? { allow: false, reason: 'no-policy-match (default-deny)' };
  }

  async health(): Promise<HealthStatus> {
    const ok = (await fetch(`${this.issuer}/.well-known/openid-configuration`)).ok;
    return { ok };
  }
  async close(): Promise<void> {}
  private async svcAuth(): Promise<Record<string, string>> { /* client-credentials grant */ return {}; }
  private toPrincipal(_u: unknown): Principal { /* map Keycloak user → Principal */ return null as never; }
}
```

The default-deny Rego the PDP loads (the part that makes a *marking* gate a read):

```rego
# policy/authz.rego  (loaded as an OPA bundle; embedded at the edge, served at scale)
package planetar.authz
import future.keywords.if

default decision := {"allow": false, "reason": "default-deny"}

# allow only if the principal is cleared for EVERY marking on the resource (no-read-up)
cleared if {
  every m in input.markings { m in input.principal.clearances }
}

decision := {"allow": true, "reason": "role+marking", "obligations": obligations} if {
  cleared
  some r in input.principal.roles
  data.grants[r][input.action][input.resourceType]   # role grants the verb on the type
  purpose_ok
}

# purpose-based access (Foundry "purpose"): some markings require a declared purpose
purpose_ok if not data.purposeRequired[input.markings[_]]
purpose_ok if input.purpose in data.allowedPurposes[input.markings[_]]

# field-level obligations (FLS): fields the principal may NOT see become a redact list
obligations := {"redact": [f | some f in data.flsRedact[input.resourceType][input.principal.roles[_]]]}
```

`InternalPolicy` (edge/air-gapped) implements the same port with **no network**: principals from a local file, the *same Rego bundle* evaluated by an embedded WASM-compiled OPA policy (`@open-policy-agent/opa-wasm`). The spine's `decide()` call is byte-identical; only the manifest line `engine: keycloak-opa` → `engine: internal` differs. This is the built ontology gate, generalized.

---

## 4. Propagating security — the marking that follows the data (the clone-resistant core)

This is the design the roadmap calls "propagating security." A **marking** (e.g. `OPS-RESTRICTED`, `NOFORN`, `PII`) is applied **once, at ingest (P2)**, and must then gate every downstream read **without anyone re-declaring it** on the derived store, object, or surface. R12 (lineage) is the carrier; R13 (the PDP) is the gate; R11 (audit) is the record; every adapter is the enforcer (PEP).

### 4.1 The mechanism in one walk (lifecycle 4.1 + governance)

```
P2 ingest
  detector emits envelope, stamps env.markings = ['OPS-RESTRICTED']   ← marking applied ONCE
   └─P3 broker WAL-appends; markings ride in the zmesg envelope header region
       └─P1 lineage.recordNode({kind:'observation', ref:obsId, markings:['OPS-RESTRICTED']})
       │    lineage.recordEdge({from: sourceNode, to: obsId, transform:'ais-detect'})
       └─P4 canonical-store.putObservation(obs)  → row carries markings: [...]
           └─P5 resolver folds obs → entity; merges per-field provenance
               │  for each merged field f: lineage.recordEdge({from:obsId, to:`${entityId}#${f}`,
               │       transform:'resolve', fields:[f]})              ← field-level edge
               │  marking UNION: entity.markings = ∪ markings of every contributing observation
               │  → lineage.propagateMarking(entityId, 'OPS-RESTRICTED')   ← closure stamp
               └─P6 ontology indexes entity into object-index (R4) + graph (R5)
                   │  the index doc + graph node copy markings (PEP writes them on the projection)
                   └─P8 surface reads via Object API
                       └─ PEP: store.getEntity → policy.decide({principal, markings: entity.markings})
                          DEFAULT DENY unless principal.clearances ⊇ entity.markings
                          obligations.redact → field-level masking (FLS) applied to the response
                          R11 audit.append({principal, resourceId, markings, outcome})
```

The invariant: **a derived object's marking set is the union of the markings of everything upstream of it in R12.** Because every transform (`detect`, `resolve`, `derive`, `aggregate`) records a lineage edge, the closure is computable; `propagateMarking` walks the downstream closure and stamps each node. No store re-implements policy; each one *carries* the marking the lineage handed it and *asks* the PDP.

### 4.2 The propagation engine (spine, engine-agnostic)

This is spine code — it depends only on the R12 and R11/R13 *ports*, so it runs identically over marquez, a graph engine, or postgres lineage.

```ts
// spine/governance/propagation.ts
import type { Lineage } from '../ports/lineage';
import type { AuditLog } from '../ports/audit-log';

/** Called by the resolver (P5) and any derivation (P7 actions, P9 rollups) after they write a derived node. */
export async function propagate(
  lineage: Lineage, audit: AuditLog,
  derivedId: string, contributingNodeIds: string[], principal: string,
): Promise<string[]> {
  // 1) union markings of all contributors via lineage
  const marks = new Set<string>();
  for (const src of contributingNodeIds) {
    const node = (await lineage.upstream(src, 0)).nodes[0];
    node?.markings.forEach(m => marks.add(m));
  }
  // 2) stamp the derived node + its entire downstream closure with each marking
  const affected = new Set<string>();
  for (const m of marks) (await lineage.propagateMarking(derivedId, m)).forEach(id => affected.add(id));
  // 3) audit the propagation itself — markings changing is a governance event
  await audit.append({
    id: '', ts: Date.now() * 1e6, principal, action: 'admin',
    resourceType: 'lineage-node', resourceId: derivedId,
    markings: [...marks], outcome: 'allow',
    detail: { propagatedTo: affected.size, marks: [...marks] },
  });
  return [...affected];
}
```

The resolver calls `propagate(lineage, audit, entityId, [obsIdA, obsIdB], systemPrincipal)` after every merge. A re-classification (an admin adds `NOFORN` to a source) calls `lineage.propagateMarking(sourceId, 'NOFORN')` once; the closure re-stamps every entity, index doc, graph node, and surface card derived from it — **retroactive, automatic, audited.** That single property is what Foundry has and Salesforce's per-object security cannot express.

### 4.3 Enforcement at the PEP (every adapter, the same three lines)

A reference read-path PEP, identical in shape across canonical-store / object-index / graph / blob-cas:

```ts
// inside any store adapter's read method (the MarkingResolver from AdapterContext wires policy in)
async getEntity(type: TypeName, id: EntityId, ctx: CallContext): Promise<CanonicalEntity | null> {
  const row = await this.raw.get(type, id);
  if (!row) return null;
  const d = await this.ctx.marking.decide({                 // PDP call — DEFAULT DENY
    principal: ctx.principal, action: 'read',
    resourceType: type, resourceId: id, markings: row.markings, purpose: ctx.purpose,
  });
  await this.ctx.audit.append({ id: '', ts: now(), principal: ctx.principal.id, action: 'read',
    resourceType: type, resourceId: id, markings: row.markings, outcome: d.allow ? 'allow' : 'deny' });
  if (!d.allow) return null;                                 // no-read-up
  return d.obligations?.redact ? redact(row, d.obligations.redact) : row;  // FLS field masking
}
```

Because the marking is **on the row** (placed there by propagation, not by the application) and the PEP is **in the adapter** (not the app), enforcement is uniform, unbypassable, and survives an engine swap. Salesforce parity: OWD = the default-deny Rego; sharing rules = `data.grants[role]`; FLS = `obligations.redact`; Shield/Field Audit Trail = the R11 hash-chained log. Foundry parity: markings + Monocle propagation = R12 `propagateMarking`; purpose-based access = `purpose_ok`.

---

## 5. Comparison tables

### R10 registry
| Engine | Consistency | Scale | p99 (read after boot) | When to choose |
|---|---|---|---|---|
| **git-fs** (default) | strong | single | ~1 ms (in-mem snapshot) | SSOT-as-code, PR review, SemVer tags, air-gap, diff/rollback for free |
| sqlite | strong | single | ~2 ms | one running registry service, no git workflow, embedded |
| postgres | strong | vertical | ~3 ms | multi-author live edits, shared with the canonical-store pg |

### R11 audit-log
| Engine | Consistency | Scale | p99 append | When to choose |
|---|---|---|---|---|
| **append-wal** (default) | append-only | vertical | ~5 ms (fsync) | edge/air-gap, zero deps, tamper-evident chain, low query needs |
| clickhouse | append-only | sharded | ~10 ms (batched) | query audit at scale — Shield Event Monitoring dashboards over billions of rows |
| kafka | append-only | sharded | ~2 ms | stream straight to a SIEM; infinite retention; consumer groups |
| postgres | append-only | vertical | ~8 ms | one engine covers everything; modest volume |

### R12 lineage
| Engine | Consistency | Scale | p99 traverse | When to choose |
|---|---|---|---|---|
| **marquez/OpenLineage** (default) | read-your-writes | vertical | ~50 ms | the standard + a Monocle-class UI for free; postgres-backed; field-level facets |
| graph (falkordb/neo4j, reuse R5) | read-your-writes | vertical/sharded | ~30 ms (bounded) | lineage queries are graph-shaped and you already run R5; `propagateMarking` = one Cypher SET |
| postgres (recursive CTE) | read-your-writes | vertical | ~80 ms | small scale; avoid a second system; rides the canonical-store pg |

### R13 policy-identity
| Engine | Consistency | Scale | p99 decide (cached) | When to choose |
|---|---|---|---|---|
| **keycloak + OPA** (default) | strong | vertical | ~2 ms (R2-cached) / ~10 ms cold | SSO/SAML/OIDC/SCIM + default-deny Rego PDP; enterprise/regulated |
| postgres | strong | vertical | ~5 ms | single-store internal IdP; modest org |
| internal (embedded OPA-WASM) | strong | single | ~1 ms | edge/air-gapped — local principals, same Rego bundle, no network |

---

## 6. Conformance-suite hookup

One suite per port; every engine for a role must pass it before the manifest compiler is allowed to bind it. The governance suites add a **cross-port** test the storage suites don't: the propagation invariant.

```ts
// 40-ADAPTERS/_conformance/governance.spec.ts
import { registryConformance } from './registry.spec';
import { auditConformance } from './audit-log.spec';
import { lineageConformance } from './lineage.spec';
import { policyConformance } from './policy-identity.spec';

// R10 — same suite, every engine
registryConformance(() => new GitFsRegistry());
registryConformance(() => new SqlRegistry());        // sqlite + postgres via config

// R11 — append/scan/export + the tamper-evidence test
auditConformance(() => new AppendWalAuditLog());
auditConformance(() => new ClickhouseAuditLog());
test('R11: deleting a record breaks verify()', async () => {
  const a = new AppendWalAuditLog(); await a.init(testCtx());
  await a.append(sampleRead); const tampered = await a.append(sampleWrite);
  await truncateLastLine(a);                          // simulate evidence tampering
  expect((await a.verify()).ok).toBe(false);          // chain MUST break — the whole point
});

// R12 — record/traverse + the propagation-closure test
lineageConformance(() => new MarquezLineage());
lineageConformance(() => new GraphLineage());         // reuses the R5 GraphStore adapter
lineageConformance(() => new PgLineage());

// R13 — default-deny + clearance subset + FLS obligations
policyConformance(() => new KeycloakOpaPolicy());
policyConformance(() => new InternalPolicy());        // same Rego bundle, embedded

// CROSS-PORT: the propagating-security invariant must hold on ANY (R12, R13) pairing
import { propagate } from '../../spine/governance/propagation';
function propagationInvariant(makeLin: () => Lineage, makePol: () => PolicyIdentity, makeAud: () => AuditLog) {
  test('a marking at ingest gates a downstream read on every engine pairing', async () => {
    const lin = makeLin(), pol = makePol(), aud = makeAud();
    await Promise.all([lin.init(testCtx()), pol.init(testCtx()), aud.init(testCtx())]);
    // ingest: observation marked OPS-RESTRICTED
    await lin.recordNode({ id: 'obs1', kind: 'observation', ref: 'obs1', markings: ['OPS-RESTRICTED'] });
    await lin.recordEdge({ from: 'obs1', to: 'ent1', transform: 'resolve', ts: now() });
    // resolve → propagate the marking down the closure
    await propagate(lin, aud, 'ent1', ['obs1'], 'system');
    const ent = (await lin.upstream('ent1', 0)).nodes[0];
    expect(ent.markings).toContain('OPS-RESTRICTED');           // inherited, not re-declared
    // an uncleared principal is DENIED reading the derived entity
    const cleared = { id: 'u1', kind: 'user', roles: ['analyst'], groups: [], clearances: ['OPS-RESTRICTED'] };
    const uncleared = { ...cleared, id: 'u2', clearances: [] };
    expect((await pol.decide({ principal: cleared, action: 'read', resourceType: 'Vessel', resourceId: 'ent1', markings: ent.markings })).allow).toBe(true);
    expect((await pol.decide({ principal: uncleared, action: 'read', resourceType: 'Vessel', resourceId: 'ent1', markings: ent.markings })).allow).toBe(false);
  });
}
propagationInvariant(() => new MarquezLineage(), () => new KeycloakOpaPolicy(), () => new AppendWalAuditLog());
propagationInvariant(() => new PgLineage(),       () => new InternalPolicy(),     () => new AppendWalAuditLog());
```

Green across the matrix = a client can bind *any* governance engine combination and the propagating-security guarantee — marking at ingest gates every downstream read, audited, tamper-evident — holds identically. That invariance is the deliverable, exactly as for R1 in [`global-scale.md`](./global-scale.md).

---

## 7. Which manifest tiers / clients bind which

| Tier ([`13`](../13-CLIENT-MANIFEST.md)) | R10 | R11 | R12 | R13 | Governance shape |
|---|---|---|---|---|---|
| **edge / air-gapped** (planetar today) | git-fs | append-wal (broker WAL substrate) | postgres or sqlite (recursive CTE) | internal (embedded OPA-WASM) | zero external services; markings still propagate (engine is spine code) |
| **standard** (single-cloud SaaS) | git-fs | postgres or clickhouse | marquez (rides the workhorse pg) | keycloak + OPA | SSO + queryable audit + Monocle UI |
| **scale / regulated** | git-fs (+ optional pg mirror) | clickhouse + kafka (→ SIEM) | marquez or falkordb (reuse R5) | keycloak + OPA (HA) | dashboards, streamed SIEM, default-deny PDP, purpose-based access |

Per reference client ([`README`](../README.md) §"four reference clients"):

- **Maritime/defence (`planetar`, edge)** — `git-fs` + `append-wal` + sqlite-lineage + `internal`. Air-gapped, offline. `OPS-RESTRICTED`/`UNCLASS` markings applied at the AIS/SAR/EO/acoustic detectors propagate to every fused entity, map track, and UI card. **Built spine** (ontology gate + per-field provenance); audit-chain + lineage-propagate are the designed adds. Manifest `governance.propagate: lineage` already names this.
- **Biotech CRM (`doibio`, standard)** — `git-fs` + `postgres`-audit + marquez + keycloak/OPA. `PII` marking on contact-point emails (doibio `ContactPointEmail`) propagates through identity-resolution merges to every researcher dossier; FLS redacts email fields for un-cleared roles. doibio's append-only `event-log.ts` is the R11 substrate; the 631-LOC identity-resolution is the merge that emits the field-level R12 edges.
- **Generic enterprise CRM (standard)** — full Salesforce-parity governance: profiles/permsets = Keycloak roles + Rego grants; OWD = default-deny; sharing rules = `data.grants`; FLS = `obligations.redact`; Shield Event Monitoring = clickhouse audit; Setup Audit Trail = the registry git log.
- **Intel/financial-crime (scale/regulated)** — `clickhouse`+`kafka` audit streamed to the agency SIEM; marquez (or falkordb, reusing the link-analysis R5 engine) for lineage; `NOFORN`/compartment markings with purpose-based access; every dossier read default-denied and audited.

The point stands across all four: **the engine under each governance role changes per client and per tier; the spine — the propagation engine, the audit envelope, the PEP shape, the default-deny PDP contract — does not.** One conformance suite (including the cross-port propagation invariant) passing on every engine pairing behind four ports is the deliverable.
