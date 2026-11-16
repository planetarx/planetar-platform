// adapters/internal/policy-identity.ts — R13 edge PDP: local principals, default-allow at edge.
// Phase 3 replaces this with Keycloak (authn) + OPA (default-deny authz) behind the same port.
import type { PolicyIdentity, AdapterContext, AdapterCapabilities, Principal, PolicyDecision, MarkingId } from '../../spine/ports.ts';
import type { TypeName, EntityId, HealthStatus } from '../../spine/model.ts';
import { registerAdapter } from '../../spine/contracts.ts';

export class InternalPolicyIdentity implements PolicyIdentity {
  private clearances: MarkingId[] = [];
  readonly capabilities: AdapterCapabilities = { consistency: 'strong', durable: true, rebuildable: false, scale: 'single', p99TargetMs: 5 };

  async init(ctx: AdapterContext): Promise<void> {
    this.clearances = (ctx.manifest.config.clearances as MarkingId[]) ?? ['UNCLASS'];
  }
  async authenticate(token: string): Promise<Principal | null> {
    if (!token) return null;
    return { id: token, roles: ['operator'], clearances: this.clearances };
  }
  async authorize(principal: Principal, action: string, resource: { type: TypeName; id?: EntityId; markings?: MarkingId[] }): Promise<PolicyDecision> {
    const need = resource.markings ?? [];
    const ok = need.every((m) => principal.clearances.includes(m));
    if (!ok) return { allow: false, reason: `missing clearance for ${need.filter((m) => !principal.clearances.includes(m)).join(',')}` };
    // releasing a marking is a separate, per-marking permission (spine/declassify.ts): default-deny
    if (action === 'declassify') {
      const lacking = need.filter((m) => !principal.roles.includes(`declassify:${m}`));
      if (!need.length || lacking.length) return { allow: false, reason: `missing role declassify:${lacking.join(',') || '?'}` };
    }
    return { allow: true };
  }
  async members(_group: string): Promise<string[]> { return []; }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 5 }; }
  async close(): Promise<void> {}
}

registerAdapter('policy-identity', 'internal', () => new InternalPolicyIdentity());
