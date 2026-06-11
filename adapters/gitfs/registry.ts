// adapters/gitfs/registry.ts — R10 registry SSOT: schema/type defs as JSON files in a (git) dir.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Registry, AdapterContext, AdapterCapabilities } from '../../spine/ports.ts';
import type { SchemaType, TypeName, HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

export class GitFsRegistry implements Registry {
  private dir!: string;
  readonly capabilities: AdapterCapabilities = { consistency: 'strong', durable: true, rebuildable: false, scale: 'single', p99TargetMs: 10 };

  async init(ctx: AdapterContext): Promise<void> {
    this.dir = (ctx.manifest.config.path as string) ?? './registry';
    mkdirSync(this.dir, { recursive: true });
  }
  async loadAll(): Promise<SchemaType[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => jparse<SchemaType>(readFileSync(join(this.dir, f), 'utf8')));
  }
  async get(name: TypeName): Promise<SchemaType | null> {
    const file = join(this.dir, name.replace(/[:/]/g, '_') + '.json');
    return existsSync(file) ? jparse<SchemaType>(readFileSync(file, 'utf8')) : null;
  }
  async put(schema: SchemaType): Promise<void> {
    writeFileSync(join(this.dir, schema.name.replace(/[:/]/g, '_') + '.json'), jstr(schema));
  }
  async versions(name: TypeName): Promise<string[]> { const s = await this.get(name); return s ? [s.semver] : []; }
  async health(): Promise<HealthStatus> { return { ok: existsSync(this.dir), p99Ms: 10 }; }
  async close(): Promise<void> {}
}

registerAdapter('registry', 'git-fs', () => new GitFsRegistry());
