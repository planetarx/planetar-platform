// spine/compiler.ts
// The manifest compiler (12-ADAPTER-CONTRACT §4, 13-CLIENT-MANIFEST §2).
// manifest -> resolve capabilities to required roles -> check every required role
// is bound (or defaultable) -> bind + contract-check each adapter -> BoundPlatform
// + topology. This is the mechanism that makes "an architecture per client" real.

import type { RoleId, EngineName, Adapter, AdapterContext, Logger, MarkingResolver, Principal, MarkingId } from './ports.ts';
import type { TypeName, FieldName, Json } from './model.ts';
import { requiredRoles, type CapabilityKey } from './capabilities.ts';
import { bindRole, BoundPlatform, ManifestError, DEFAULTABLE_ROLES, type SharedResources, type RoleBinding } from './contracts.ts';
import { MarkingPolicy, type FlsMap } from './governance.ts';

export interface ClientManifest {
  schema_version: string;
  client: { id: string; name?: string; tier: 'edge' | 'standard' | 'scale' | 'air-gapped' };
  capabilities: CapabilityKey[];
  roles: Partial<Record<RoleId, { engine: EngineName; config?: Record<string, Json> }>>;
  ingest?: { kind: string; name: string; [k: string]: Json | undefined }[];
  surfaces?: { kind: string; name?: string; [k: string]: Json | undefined }[];
  governance?: {
    markings?: { id: string; default?: boolean }[];
    propagate?: string;
    /** field-level security: type → field → marking needed to see it */
    fls?: FlsMap;
    audit?: { reads?: 'marked' | 'all' | 'none' };
  };
  deploy?: { target: string; [k: string]: Json };
}

export interface CompileResult {
  platform: BoundPlatform;
  required: RoleId[];
  bound: RoleId[];
  warnings: string[];
  topology: string;   // Mermaid
}

// --- default ambient services for a boot (edge-permissive; real clients inject their own) ---

export function consoleLogger(prefix = 'planetar'): Logger {
  return {
    info: (m, c) => console.log(`[${prefix}] ${m}`, c ?? ''),
    warn: (m, c) => console.warn(`[${prefix}] WARN ${m}`, c ?? ''),
    error: (m, c) => console.error(`[${prefix}] ERR ${m}`, c ?? ''),
  };
}

/** Allow-all resolver for the per-adapter conformance harness only. A compiled platform never
 *  uses it: compile() builds a MarkingPolicy from the manifest's governance block. */
export const PERMISSIVE_MARKING: MarkingResolver = {
  visible: (_p: Principal, _m: MarkingId[]) => true,
  redactFields: (_p: Principal, _t: TypeName, f: Record<FieldName, Json>) => f,
};

export function makeShared(): SharedResources {
  const store = new Map<string, unknown>();
  return { get: <T>(key: string, make: () => T) => (store.has(key) ? store.get(key) as T : (store.set(key, make()), store.get(key) as T)) };
}

// --- the compile ---

export async function compile(
  manifest: ClientManifest,
  opts: { logger?: Logger; policy?: MarkingPolicy; shared?: SharedResources; nowNs?: () => bigint } = {},
): Promise<CompileResult> {
  const logger = opts.logger ?? consoleLogger(manifest.client.id);
  const policy = opts.policy ?? new MarkingPolicy(manifest.governance?.fls ?? {});
  const marking: MarkingResolver = policy;
  const shared = opts.shared ?? makeShared();
  const warnings: string[] = [];

  // 1) capabilities -> required roles
  const { required, enhancing, unknown } = requiredRoles(manifest.capabilities);
  if (unknown.length) throw new ManifestError(`unknown capabilities: ${unknown.join(', ')}`);

  // 2) every required role must be bound or defaultable
  const bindings: RoleBinding[] = [];
  for (const role of required) {
    const decl = manifest.roles[role];
    if (decl) {
      bindings.push({ role, engine: decl.engine, config: decl.config ?? {} });
    } else if (DEFAULTABLE_ROLES[role]) {
      bindings.push({ role, engine: DEFAULTABLE_ROLES[role]!, config: {} });
      warnings.push(`role ${role} unbound — using default engine '${DEFAULTABLE_ROLES[role]}'`);
    } else {
      throw new ManifestError(`required role '${role}' is not bound and has no default (needed by an enabled capability)`);
    }
  }
  // also bind any explicitly-declared roles that aren't required (e.g. enhancing), with a note
  for (const role of Object.keys(manifest.roles) as RoleId[]) {
    if (required.has(role)) continue;
    const decl = manifest.roles[role]!;
    bindings.push({ role, engine: decl.engine, config: decl.config ?? {} });
    if (!enhancing.has(role)) warnings.push(`role ${role} bound but no enabled capability needs it`);
  }
  for (const role of enhancing) if (!manifest.roles[role]) warnings.push(`enhancing role ${role} unbound — capability runs degraded`);

  // 3) bind + contract-check each
  const ctx: Omit<AdapterContext, 'role' | 'manifest'> = { logger, marking };
  const bound: Partial<Record<RoleId, Adapter>> = {};
  for (const b of bindings) {
    bound[b.role] = await bindRole(b, shared, ctx);
    logger.info(`bound ${b.role} -> ${b.engine}`);
  }

  return {
    platform: new BoundPlatform(bound, { policy, auditReads: manifest.governance?.audit?.reads, nowNs: opts.nowNs }),
    required: [...required],
    bound: bindings.map((b) => b.role),
    warnings,
    topology: emitTopology(manifest, bindings),
  };
}

// --- topology (Mermaid) from a compiled manifest ---

export function emitTopology(manifest: ClientManifest, bindings: RoleBinding[]): string {
  const eng = (r: RoleId) => bindings.find((b) => b.role === r)?.engine;
  const L: string[] = ['flowchart LR'];
  const ing = manifest.ingest ?? [];
  if (ing.length) {
    L.push('  subgraph Ingest');
    for (const i of ing) L.push(`    ${id(i.name)}[${i.name}]`);
    L.push('  end');
    if (eng('stream')) L.push(`  ${ing.map((i) => id(i.name)).join(' & ')} -->|envelopes| BUS[("stream: ${eng('stream')}")]`);
  }
  if (eng('stream')) {
    if (eng('canonical-store')) L.push(`  BUS --> CS[("canonical-store: ${eng('canonical-store')}")]`);
    if (eng('audit-log')) L.push(`  BUS --> AUD[("audit-log: ${eng('audit-log')}")]`);
  }
  if (eng('canonical-store')) {
    L.push('  CS --> RES[resolution: spine]');
    L.push('  RES --> ONT[ontology: spine]');
    if (eng('object-index')) L.push(`  ONT --> IDX[("object-index: ${eng('object-index')}")]`);
    if (eng('graph')) L.push(`  ONT --> GR[("graph: ${eng('graph')}")]`);
    if (eng('timeseries-geo')) L.push(`  RES --> TS[("timeseries-geo: ${eng('timeseries-geo')}")]`);
    if (eng('vector')) L.push(`  RES --> VEC[("vector: ${eng('vector')}")]`);
  }
  if (eng('blob-cas')) L.push(`  BLOB[("blob-cas: ${eng('blob-cas')}")] --- ONT`);
  for (const s of manifest.surfaces ?? []) L.push(`  ONT --> ${id(s.name ?? s.kind)}["surface: ${s.name ?? s.kind}"]`);
  return L.join('\n');
}

function id(s: string): string { return s.replace(/[^a-zA-Z0-9]/g, '_'); }
