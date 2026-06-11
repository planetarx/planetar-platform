// spine/capabilities.ts
// The capability -> role-footprint registry (11-CAPABILITY-ROLE-MAP.md §3).
// The compiler unions the footprints of a manifest's enabled capabilities to
// compute the REQUIRED roles. A role not required by any enabled capability is
// never bound (and binding it is a warning, not an error).

import type { RoleId } from './ports.ts';

export interface CapabilitySpec {
  /** roles that MUST be bound for this capability to function */
  required: RoleId[];
  /** roles that improve it but aren't mandatory (degraded-not-broken if unbound) */
  enhancing?: RoleId[];
  note?: string;
}

export type CapabilityKey = string;

export const CAPABILITIES: Record<CapabilityKey, CapabilitySpec> = {
  // --- platform spine basics ---
  'crm-objects':          { required: ['canonical-store', 'registry'], enhancing: ['object-index'] },
  'custom-fields':        { required: ['canonical-store', 'registry'] },
  'streaming-ingestion':  { required: ['stream'] },
  'kinetic-writes':       { required: ['registry', 'canonical-store', 'audit-log', 'stream'], enhancing: ['policy-identity'] },
  'identity-resolution':  { required: ['canonical-store', 'object-index', 'lineage'], enhancing: ['vector'] },
  'audit':                { required: ['audit-log'] },
  'search':               { required: ['object-index', 'canonical-store'], enhancing: ['vector'] },
  'search-360':           { required: ['object-index', 'canonical-store'], enhancing: ['vector', 'graph'] },

  // --- analytics / automation ---
  'reporting-olap':       { required: ['analytics-olap', 'canonical-store'], enhancing: ['timeseries-geo'] },
  'segmentation-activation': { required: ['analytics-olap', 'canonical-store'], enhancing: ['vector'] },
  'automation-flow':      { required: ['work-queue', 'canonical-store', 'stream'], enhancing: ['policy-identity'] },
  'omnichannel-routing':  { required: ['work-queue', 'hot-cache', 'canonical-store'] },
  'sales-pipeline':       { required: ['canonical-store', 'registry'], enhancing: ['analytics-olap', 'object-index'] },
  'service-cases':        { required: ['canonical-store', 'work-queue'], enhancing: ['object-index'] },

  // --- graph / geo / media ---
  'link-analysis':        { required: ['graph', 'canonical-store'], enhancing: ['object-index'] },
  'geotemporal':          { required: ['timeseries-geo', 'canonical-store'], enhancing: ['graph'] },
  'media-sets':           { required: ['blob-cas', 'canonical-store'], enhancing: ['vector'] },
  'dark-vessel-reid':     { required: ['canonical-store', 'timeseries-geo'], enhancing: ['vector'], note: 'kinematic matcher is spine code' },
  'watchlists-alerting':  { required: ['canonical-store', 'work-queue', 'stream'], enhancing: ['object-index'] },
  'case-management':      { required: ['canonical-store', 'blob-cas'], enhancing: ['graph'] },
  'dossiers':             { required: ['canonical-store', 'graph', 'blob-cas'] },

  // --- AI ---
  'agents-rag':           { required: ['vector', 'blob-cas', 'registry'], enhancing: ['graph'] },

  // --- governance / platform-wide ---
  'propagating-security': { required: ['lineage', 'policy-identity', 'audit-log'] },
  'sso-rbac-fls':         { required: ['policy-identity'] },
  'multi-tenancy':        { required: ['policy-identity', 'lineage'] },
  'portal':               { required: ['canonical-store', 'policy-identity'], enhancing: ['object-index'] },
};

/** Union the footprints of the enabled capabilities → {required, enhancing}. */
export function requiredRoles(enabled: CapabilityKey[]): { required: Set<RoleId>; enhancing: Set<RoleId>; unknown: string[] } {
  const required = new Set<RoleId>();
  const enhancing = new Set<RoleId>();
  const unknown: string[] = [];
  for (const key of enabled) {
    const spec = CAPABILITIES[key];
    if (!spec) { unknown.push(key); continue; }
    for (const r of spec.required) required.add(r);
    for (const r of spec.enhancing ?? []) enhancing.add(r);
  }
  // a role that is both required and enhancing is just required
  for (const r of required) enhancing.delete(r);
  return { required, enhancing, unknown };
}
