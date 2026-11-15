// spine/declassify.ts — governed marking removal (declassification) along one lineage edge.
// A principal requests that some markings stop flowing along upstream → downstream; a DIFFERENT
// principal, cleared for those markings and authorized by the PDP for 'declassify', approves.
// Only the approval ('unmark' record) changes inheritance, and only forward: stored rows lose a
// released marking when they are next re-derived (spine/system.ts, I2 exception).
// Design: docs/specs/2026-11-15-governed-declassification-design.md.
import { randomUUID } from 'node:crypto';
import type { BoundPlatform } from './contracts.ts';
import type { Principal, DeclassRecord, LineageEdge } from './ports.ts';
import type { MarkingId } from './model.ts';
import { GovernanceError, parseRef, union } from './governance.ts';

export interface DeclassRequest { upstream: string; downstream: string; markings: MarkingId[]; reason: string; }
export interface PendingDeclassification extends DeclassRequest { id: string; by: string; ts: string; }


function cleared(p: Principal, markings: MarkingId[]): boolean { return markings.every((m) => p.clearances.includes(m)); }

/** The markings an audit record about this edge must carry: the released ones plus whatever the
 *  entities at either end of the edge carry, so a reader learns nothing they could not read. */
async function recordMarkings(platform: BoundPlatform, edge: { upstream: string; downstream: string }, markings: MarkingId[]): Promise<MarkingId[]> {
  const sys = platform.system('governance.declassify');
  if (!sys.has('canonical-store')) return markings;
  const ids = [edge.upstream, edge.downstream].map((r) => parseRef(r)?.id).filter((x): x is string => x !== undefined);
  return union(markings, Object.values(await sys.role('canonical-store').markingsOf(ids)).flat());
}

export async function requestDeclassification(platform: BoundPlatform, principal: Principal, req: DeclassRequest): Promise<string> {
  const sys = platform.system('governance.declassify');
  if (!sys.has('lineage')) throw new GovernanceError('declassification needs a bound lineage role');
  const markings = [...new Set(req.markings)];
  if (!markings.length) throw new GovernanceError('name at least one marking to release');
  if (!req.reason?.trim()) throw new GovernanceError('a declassification request needs a reason');
  if (!cleared(principal, markings)) throw new GovernanceError('a principal may only request release of markings it holds');
  const lineage = sys.role('lineage');
  if (!(await lineage.upstreamOf(req.downstream, 1)).some((e) => e.upstream === req.upstream)) throw new GovernanceError(`no lineage edge ${req.upstream} → ${req.downstream}`);
  const declass: DeclassRecord = { id: randomUUID(), by: principal.id, reason: req.reason, ts: new Date().toISOString() };
  await sys.recordDeclassification({ upstream: req.upstream, downstream: req.downstream, kind: 'unmark-request', markings, declass });
  if (sys.has('audit-log')) await sys.role('audit-log').append({
    ts: platform.nowNs(), actor: principal.id, action: 'admin', resource: `${req.upstream} -> ${req.downstream}`,
    detail: { declassify: 'request', id: declass.id, markings, reason: req.reason }, markings: await recordMarkings(platform, req, markings),
  });
  return declass.id;
}

export async function approveDeclassification(platform: BoundPlatform, approver: Principal, id: string): Promise<void> {
  const sys = platform.system('governance.declassify');
  if (!sys.has('lineage')) throw new GovernanceError('declassification needs a bound lineage role');
  if (!sys.has('policy-identity')) throw new GovernanceError('declassification approval needs a bound policy-identity role');
  const recs = await sys.role('lineage').declassifications(id);
  const req = recs.find((r) => r.kind === 'unmark-request');
  if (!req?.declass) throw new GovernanceError(`no declassification request ${id}`);
  if (recs.some((r) => r.kind === 'unmark')) throw new GovernanceError(`declassification ${id} is already approved`);
  const markings = req.markings ?? [];
  if (approver.id === req.declass.by) throw new GovernanceError('the requester cannot approve their own declassification');
  if (!cleared(approver, markings)) throw new GovernanceError('the approver must hold every marking being released');
  const decision = await sys.role('policy-identity').authorize(approver, 'declassify', { type: 'marking', markings });
  if (!decision.allow) throw new GovernanceError(`declassification not authorized: ${decision.reason ?? 'denied'}`);
  const edge: LineageEdge = { upstream: req.upstream, downstream: req.downstream, kind: 'unmark', markings, declass: { ...req.declass, approvedBy: approver.id } };
  await sys.recordDeclassification(edge);
  if (sys.has('audit-log')) await sys.role('audit-log').append({
    ts: platform.nowNs(), actor: approver.id, action: 'admin', resource: `${req.upstream} -> ${req.downstream}`,
    detail: { declassify: 'approve', id, markings, requestedBy: req.declass.by }, markings: await recordMarkings(platform, req, markings),
  });
}

/** Open requests whose markings `principal` holds (a request names markings, so it is itself marked). */
export async function pendingDeclassifications(platform: BoundPlatform, principal: Principal): Promise<PendingDeclassification[]> {
  const sys = platform.system('governance.declassify');
  if (!sys.has('lineage')) return [];
  const recs = await sys.role('lineage').declassifications();
  const approved = new Set(recs.filter((r) => r.kind === 'unmark').map((r) => r.declass?.id));
  return recs
    .filter((r) => r.kind === 'unmark-request' && r.declass && !approved.has(r.declass.id) && cleared(principal, r.markings ?? []))
    .map((r) => ({ id: r.declass!.id, by: r.declass!.by, ts: r.declass!.ts, reason: r.declass!.reason, upstream: r.upstream, downstream: r.downstream, markings: r.markings ?? [] }));
}
