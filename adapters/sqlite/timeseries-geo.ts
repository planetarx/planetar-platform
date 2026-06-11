// adapters/sqlite/timeseries-geo.ts — R8 track/telemetry store over node:sqlite.
// Real scale binds TimescaleDB+PostGIS or ClickHouse (40-ADAPTERS/timeseries-olap.md); same port.
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './_db.ts';
import type { TimeSeriesGeo, AdapterContext, AdapterCapabilities, TrackPoint } from '../../spine/ports.ts';
import type { EntityId, TimeWindow, HealthStatus } from '../../spine/model.ts';
import { jstr, jparse } from '../../spine/json.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const DDL = `CREATE TABLE IF NOT EXISTS track (entity_id TEXT, ts INTEGER, lat REAL, lon REAL, fields TEXT);
CREATE INDEX IF NOT EXISTS track_eid_ts ON track(entity_id, ts);`;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export class SqliteTimeSeriesGeo implements TimeSeriesGeo {
  private db!: DatabaseSync;
  readonly capabilities: AdapterCapabilities = { consistency: 'read-your-writes', durable: true, rebuildable: true, scale: 'single', p99TargetMs: 60 };

  async init(ctx: AdapterContext): Promise<void> {
    this.db = openDb((ctx.manifest.config.path as string) ?? ':memory:');
    this.db.exec(DDL);
  }
  async append(p: TrackPoint): Promise<void> {
    this.db.prepare('INSERT INTO track(entity_id,ts,lat,lon,fields) VALUES(?,?,?,?,?)').run(p.entityId, Number(p.ts / 1_000_000n), p.lat, p.lon, jstr(p.fields ?? {}));
  }
  private toPoints(rows: { entity_id: string; ts: number; lat: number; lon: number; fields: string }[]): TrackPoint[] {
    return rows.map((r) => ({ entityId: r.entity_id, ts: BigInt(r.ts) * 1_000_000n, lat: r.lat, lon: r.lon, fields: jparse(r.fields) }));
  }
  async range(entityId: EntityId, w: TimeWindow): Promise<TrackPoint[]> {
    const rows = this.db.prepare('SELECT * FROM track WHERE entity_id=? AND ts BETWEEN ? AND ? ORDER BY ts').all(entityId, Number(w.fromNs / 1_000_000n), Number(w.toNs / 1_000_000n)) as never[];
    return this.toPoints(rows);
  }
  async downsample(entityId: EntityId, w: TimeWindow, bucketSec: number): Promise<TrackPoint[]> {
    const rows = this.db.prepare(
      `SELECT entity_id, (ts/?)*? AS ts, avg(lat) lat, avg(lon) lon, '{}' fields FROM track
       WHERE entity_id=? AND ts BETWEEN ? AND ? GROUP BY ts/? ORDER BY ts`,
    ).all(bucketSec * 1000, bucketSec * 1000, entityId, Number(w.fromNs / 1_000_000n), Number(w.toNs / 1_000_000n), bucketSec * 1000) as never[];
    return this.toPoints(rows);
  }
  async within(geo: { lat: number; lon: number; radiusKm: number }, w: TimeWindow): Promise<TrackPoint[]> {
    const rows = this.db.prepare('SELECT * FROM track WHERE ts BETWEEN ? AND ?').all(Number(w.fromNs / 1_000_000n), Number(w.toNs / 1_000_000n)) as { entity_id: string; ts: number; lat: number; lon: number; fields: string }[];
    return this.toPoints(rows.filter((r) => haversineKm(geo, { lat: r.lat, lon: r.lon }) <= geo.radiusKm));
  }
  async health(): Promise<HealthStatus> { return { ok: true, p99Ms: 60 }; }
  async close(): Promise<void> { this.db.close(); }
}

registerAdapter('timeseries-geo', 'sqlite', () => new SqliteTimeSeriesGeo());
