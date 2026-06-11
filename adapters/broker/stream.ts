// adapters/broker/stream.ts — R3 on the real planetar-broker (ns C bus) over TCP.
// Zero npm deps (node:net). Wire = [u32 BE length][zmesg message]; zmesg header is
// 66-byte LITTLE-ENDIAN (verified against ~/github/sness23/zmesg/zmesg.h) + variable
// strings + payload. pub :12001, sub :12002 ("SUB <topics>\n").
import { connect, type Socket } from 'node:net';
import type { Stream, AdapterContext, AdapterCapabilities, Envelope, TopicPattern, Offset } from '../../spine/ports.ts';
import type { HealthStatus } from '../../spine/model.ts';
import { AsyncQueue } from '../../spine/asyncqueue.ts';
import { registerAdapter } from '../../spine/contracts.ts';

const MAGIC = 0x5a4d5347, VERSION = 1, FIXED = 66;

// --- zmesg codec (exported for round-trip testing without a live broker) ---
export function zmesgEncode(env: Envelope): Buffer {
  const enc = (s?: string) => Buffer.from(s ?? '', 'utf8');
  const topic = enc(env.topic), source = enc(env.source), schema = enc(env.schema);
  const corr = enc(env.correlationId), cause = enc(env.causationId);
  const headerLen = FIXED + topic.length + source.length + schema.length + corr.length + cause.length;
  const buf = Buffer.alloc(headerLen + env.payload.length);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt8(VERSION, 4);
  buf.writeUInt8(0, 5);                         // flags (NOTE: no markings field in zmesg v1)
  buf.writeUInt16LE(headerLen, 6);
  Buffer.from(env.id.replace(/-/g, ''), 'hex').copy(buf, 8, 0, 16);
  buf.writeBigUInt64LE(env.createdNs, 24);
  buf.writeBigUInt64LE(env.createdNs, 32);      // stored_at_ns (≈ created here)
  buf.writeBigUInt64LE(env.createdNs, 40);      // published_at_ns
  buf.writeUInt16LE(topic.length, 48);
  buf.writeUInt16LE(source.length, 50);
  buf.writeUInt16LE(schema.length, 52);
  buf.writeUInt16LE(corr.length, 54);
  buf.writeUInt16LE(cause.length, 56);
  buf.writeUInt32LE(0x010000, 58);              // schema_version (packed)
  buf.writeUInt32LE(env.payload.length, 62);
  let off = FIXED;
  for (const s of [topic, source, schema, corr, cause]) { s.copy(buf, off); off += s.length; }
  Buffer.from(env.payload).copy(buf, off);
  return buf;
}

export function zmesgDecode(buf: Buffer): Envelope {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('bad zmesg magic');
  const hex = buf.subarray(8, 24).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const createdNs = buf.readBigUInt64LE(24);
  const tl = buf.readUInt16LE(48), sl = buf.readUInt16LE(50), scl = buf.readUInt16LE(52), col = buf.readUInt16LE(54), cal = buf.readUInt16LE(56);
  const pl = buf.readUInt32LE(62);
  let o = FIXED;
  const take = (n: number) => { const s = buf.subarray(o, o + n).toString('utf8'); o += n; return s; };
  const topic = take(tl), source = take(sl), schema = take(scl), correlationId = take(col) || undefined, causationId = take(cal) || undefined;
  const payload = new Uint8Array(buf.subarray(o, o + pl));
  return { id, topic, source, schema, createdNs, correlationId, causationId, payload };
}

export class BrokerStream implements Stream {
  private host = '127.0.0.1'; private pubPort = 12001; private subPort = 12002;
  private pubSock?: Socket;
  readonly capabilities: AdapterCapabilities = { consistency: 'append-only', durable: true, rebuildable: false, scale: 'vertical', p99TargetMs: 1 };

  async init(ctx: AdapterContext): Promise<void> {
    this.host = (ctx.manifest.config.host as string) ?? this.host;
    this.pubPort = (ctx.manifest.config.pub as number) ?? this.pubPort;
    this.subPort = (ctx.manifest.config.sub as number) ?? this.subPort;
  }
  private framePrefix(len: number): Buffer { const p = Buffer.alloc(4); p.writeUInt32BE(len, 0); return p; }   // BE length

  async publish(env: Envelope): Promise<void> {
    const msg = zmesgEncode(env);
    if (!this.pubSock) this.pubSock = connect(this.pubPort, this.host);
    await new Promise<void>((res, rej) => this.pubSock!.write(Buffer.concat([this.framePrefix(msg.length), msg]), (e) => (e ? rej(e) : res())));
  }
  subscribe(topics: TopicPattern[], _from: Offset | 'latest'): AsyncIterable<Envelope> {
    const q = new AsyncQueue<Envelope>();
    const sock = connect(this.subPort, this.host, () => sock.write(`SUB ${topics.join(' ')}\n`));
    let acc = Buffer.alloc(0);
    let handshook = false;
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      // the broker replies with a text "OK\n" line before the binary frames — strip it once
      if (!handshook) {
        const nl = acc.indexOf(0x0a);
        if (nl === -1) return;                                  // wait for the full line
        if (/^OK/i.test(acc.subarray(0, nl).toString('ascii'))) acc = acc.subarray(nl + 1);
        handshook = true;
      }
      // deframe BE-length-prefixed messages (guard against a desync producing an absurd length)
      const MAX = 16 * 1024 * 1024;
      while (acc.length >= 4) {
        const len = acc.readUInt32BE(0);
        if (len > MAX) { q.close(); sock.destroy(); return; }   // framing desync — fail loud, don't spin
        if (acc.length < 4 + len) break;
        try { q.push(zmesgDecode(acc.subarray(4, 4 + len) as Buffer)); } catch { /* skip non-frame bytes */ }
        acc = acc.subarray(4 + len);
      }
    });
    sock.on('error', (e) => { q.close(); ctxLog(e); });
    return q;
  }
  async ack(): Promise<void> { /* broker durability is its WAL; projector checkpoints R1 */ }
  async health(): Promise<HealthStatus> { return { ok: true, detail: `broker ${this.host}:${this.pubPort}/${this.subPort} (lazy connect)`, p99Ms: 1 }; }
  async close(): Promise<void> { this.pubSock?.end(); }
}
function ctxLog(_e: unknown) { /* errors surface via the closed subscription */ }

registerAdapter('stream', 'broker', () => new BrokerStream());
