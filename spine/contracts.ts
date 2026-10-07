// spine/contracts.ts
// The contract each role demands, the check the manifest compiler runs, and the
// binder skeleton. Phase 0/1 of 90-ROADMAP.md. An engine may bind a role only if
// its declared AdapterCapabilities SATISFY the role contract here.

import type { RoleId, AdapterCapabilities, Adapter, PortByRole, AdapterContext, EngineName, ResolvedBinding, Logger, MarkingResolver, Principal } from './ports.ts';
import { MarkingPolicy } from './governance.ts';
import { GovernedPlatform } from './governed.ts';
import { SystemPlatform } from './system.ts';

// ---------------------------------------------------------------------------
// What each role requires. The compiler rejects an engine that can't meet it.
// (Derived from 10-STORAGE-ROLES.md §1–§2.)
// ---------------------------------------------------------------------------

export interface RoleContract {
  /** the weakest consistency the role tolerates (engine must be >= this) */
  minConsistency: AdapterCapabilities['consistency'];
  mustBeDurable: boolean;
  /** if true, the role is the source of record and may NOT be merely rebuildable */
  isSourceOfRecord: boolean;
  maxP99Ms: number;
  /** roles that MUST be rebuildable-from-stream (projections); source/blob roles set false */
  mustBeRebuildable?: boolean;
}

const ORDER: AdapterCapabilities['consistency'][] = ['append-only', 'eventual', 'read-your-writes', 'strong'];
const atLeast = (have: AdapterCapabilities['consistency'], need: AdapterCapabilities['consistency']) =>
  ORDER.indexOf(have) >= ORDER.indexOf(need) || (need === 'append-only' && have === 'append-only');

export const ROLE_CONTRACT: Record<RoleId, RoleContract> = {
  'canonical-store':  { minConsistency: 'read-your-writes', mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 10,   mustBeRebuildable: true },
  'hot-cache':        { minConsistency: 'eventual',         mustBeDurable: false, isSourceOfRecord: false, maxP99Ms: 2 },
  'stream':           { minConsistency: 'append-only',      mustBeDurable: true,  isSourceOfRecord: true,  maxP99Ms: 5 },
  'object-index':     { minConsistency: 'eventual',         mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 100,  mustBeRebuildable: true },
  'graph':            { minConsistency: 'eventual',         mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 150,  mustBeRebuildable: true },
  'blob-cas':         { minConsistency: 'eventual',         mustBeDurable: true,  isSourceOfRecord: true,  maxP99Ms: 200 },
  'vector':           { minConsistency: 'eventual',         mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 100,  mustBeRebuildable: true },
  'timeseries-geo':   { minConsistency: 'eventual',         mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 100,  mustBeRebuildable: true },
  'analytics-olap':   { minConsistency: 'eventual',         mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 5000 },  // external/federated allowed
  'registry':         { minConsistency: 'strong',           mustBeDurable: true,  isSourceOfRecord: true,  maxP99Ms: 50 },
  'audit-log':        { minConsistency: 'append-only',      mustBeDurable: true,  isSourceOfRecord: true,  maxP99Ms: 50 },
  'lineage':          { minConsistency: 'read-your-writes', mustBeDurable: true,  isSourceOfRecord: false, maxP99Ms: 200,  mustBeRebuildable: true },
  'policy-identity':  { minConsistency: 'strong',           mustBeDurable: true,  isSourceOfRecord: true,  maxP99Ms: 50 },
  'work-queue':       { minConsistency: 'read-your-writes', mustBeDurable: true,  isSourceOfRecord: true,  maxP99Ms: 50 },
};

export interface SatisfyResult { ok: boolean; reasons: string[]; }

/** The compile-time check: does this engine's declared capabilities meet the role contract? */
export function satisfies(role: RoleId, cap: AdapterCapabilities): SatisfyResult {
  const c = ROLE_CONTRACT[role];
  const reasons: string[] = [];
  if (!atLeast(cap.consistency, c.minConsistency))
    reasons.push(`consistency ${cap.consistency} < required ${c.minConsistency}`);
  if (c.mustBeDurable && !cap.durable)
    reasons.push('role requires durability; engine is not durable');
  if (c.mustBeRebuildable && !cap.rebuildable && !cap.external)
    reasons.push('role must be rebuildable-from-stream (or external/federated)');
  if (cap.p99TargetMs > c.maxP99Ms && !cap.external)
    reasons.push(`engine p99 ${cap.p99TargetMs}ms exceeds role budget ${c.maxP99Ms}ms`);
  return { ok: reasons.length === 0, reasons };
}

/** Asymmetric default rule (cache-queue.md): R2 may default to a zero-service in-proc engine;
 *  R14 (durable work) may NOT. Used by the compiler when a role is unbound but a default exists. */
export const DEFAULTABLE_ROLES: Partial<Record<RoleId, EngineName>> = {
  'hot-cache': 'in-process',   // safe: not durable, repopulates
  // 'work-queue' deliberately ABSENT — durable work must be explicitly bound
};

// ---------------------------------------------------------------------------
// Binder skeleton (12-ADAPTER-CONTRACT §4). Engines self-register; the compiler
// instantiates + contract-checks. Pool-multiplexing (one pg → R1+R4+R7+R8+R14)
// is handled by a shared-resource key so adapters can co-locate on one connection.
// ---------------------------------------------------------------------------

export type AdapterFactory = (shared: SharedResources) => Adapter;

/** Engines that co-locate (e.g. all postgres-backed roles) share one pool keyed by host+db. */
export interface SharedResources {
  get<T>(key: string, make: () => T): T;
}

export const ADAPTER_REGISTRY: Partial<Record<RoleId, Record<EngineName, AdapterFactory>>> = {
  // populated by 40-ADAPTERS/* modules at import time, e.g.:
  //   registerAdapter('canonical-store', 'sqlite',   (s) => new SqliteCanonicalStore())
  //   registerAdapter('canonical-store', 'postgres', (s) => new PostgresCanonicalStore(s))
};

export function registerAdapter(role: RoleId, engine: EngineName, factory: AdapterFactory): void {
  (ADAPTER_REGISTRY[role] ??= {})[engine] = factory;
}

export class ManifestError extends Error {}

export interface RoleBinding { role: RoleId; engine: EngineName; config: Record<string, unknown>; }

/** Instantiate + contract-check one role binding. The full compiler (Phase 1) loops this
 *  over a manifest's required roles, then wraps results in a BoundPlatform. */
export async function bindRole(
  binding: RoleBinding,
  shared: SharedResources,
  ctx: Omit<AdapterContext, 'role' | 'manifest'>,
): Promise<Adapter> {
  const factory = ADAPTER_REGISTRY[binding.role]?.[binding.engine];
  if (!factory) throw new ManifestError(`no adapter for ${binding.role}/${binding.engine}`);
  const adapter = factory(shared);
  const check = satisfies(binding.role, adapter.capabilities);
  if (!check.ok)
    throw new ManifestError(`${binding.engine} cannot satisfy ${binding.role}: ${check.reasons.join('; ')}`);
  await adapter.init({ ...ctx, role: binding.role, manifest: binding as unknown as ResolvedBinding });
  return adapter;
}

/** How the platform governs access (compiled from the manifest's `governance` block). */
export interface GovernanceConfig {
  policy: MarkingPolicy;
  /** which governed reads are audited: only those touching marked rows, all, or none */
  auditReads: 'marked' | 'all' | 'none';
  nowNs: () => bigint;
}

/** What the spine receives. The adapters are private: a caller takes either the governed view
 *  of a principal, or the system handle (docs/specs/2026-10-06-governed-ports-design.md §4.2). */
export class BoundPlatform {
  #bound: Partial<Record<RoleId, Adapter>>;
  #gov: GovernanceConfig;
  constructor(bound: Partial<Record<RoleId, Adapter>>, gov: Partial<GovernanceConfig> = {}) {
    this.#bound = bound;
    this.#gov = {
      policy: gov.policy ?? new MarkingPolicy(),
      auditReads: gov.auditReads ?? 'marked',
      nowNs: gov.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n),
    };
  }
  /** Governed ports for one principal: reads are filtered and redacted; there are no data writes. */
  as(principal: Principal): GovernedPlatform { return new GovernedPlatform(this.#bound, principal, this.#gov); }
  /** Raw ports for spine internals, ingest and seeding. `component` names the caller. */
  system(component: string): SystemPlatform { return new SystemPlatform(this.#bound, component); }
  /** @deprecated use as(principal) or system(component); removed once every caller has moved. */
  role<R extends RoleId>(r: R): PortByRole[R] { return this.system('legacy').role(r); }
  get policy(): MarkingPolicy { return this.#gov.policy; }
  nowNs(): bigint { return this.#gov.nowNs(); }
  has(r: RoleId): boolean { return !!this.#bound[r]; }
  async closeAll(): Promise<void> { await Promise.all(Object.values(this.#bound).map((a) => a!.close())); }
}

export type { Logger, MarkingResolver };
