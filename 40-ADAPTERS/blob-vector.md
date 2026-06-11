# 40-ADAPTERS · Blob-CAS (R6) + Vector (R7)

**Roles:** R6 · blob-cas (content-addressed unstructured bytes) **and** R7 · vector (embedding storage + KNN). They ship in one file because they ride together: **bytes land in R6, the embedding of those bytes lands in R7, and only the `{sha256,size,mime}` handle + a vector-ref travel the R3 bus.** Neither bytes nor vectors are ever on the envelope.
**Engines:** R6 — MinIO/S3 (`@aws-sdk/client-s3`), filesystem + JSON sidecar, GCS (`@google-cloud/storage`). R7 — pgvector (`pg`), Qdrant (`@qdrant/js-client-rest`), Milvus (`@zilliz/milvus2-sdk-node`), OpenSearch-kNN (`@opensearch-project/opensearch`).
**Status:** **designed** at the port level; **partial** in the field. The CAS *concept* is built/specified for the photo modality in `ARCH-planetar-photos.md` §3 (filesystem `store/<aa>/<bb>/<sha256>` + sidecar, `GET /blob /thumb /emb` read surface) — that doc is the contract this file generalizes into the R6 port. R7/embeddings are **designed only** (the `visual_similarity` match rule is the headline research contribution of `ARCH-planetar-photos.md` §6.3; no embedding store is built yet). The detectors that *produce* blob-bearing observations — `planetar-eo`, `planetar-sat` — are **built**. So: the producers are real, the handle-on-the-envelope discipline is specified, and the R6/R7 adapters below conform to the same port shape the rest of the platform uses.

This pair is the **media + AI substrate**: Foundry media sets, Gotham imagery/FMV, Salesforce Files (R6); AIP/Agentforce RAG grounding, Data Cloud vector DB, and the flagship **dark-vessel visual re-ID** (photo↔EO↔SAR cosine on one calibrated scale) (R7).

---

## 1. Intro — which roles, which engines, when to pick each

### R6 · blob-cas — the load-bearing invariant

R6 holds **unstructured bytes addressed by content hash** — imagery, SAR chips, EO frames, FMV, photos, PDFs, attachments ([`10 §R6`](../10-STORAGE-ROLES.md)). Its contract: **immutable once written, eventual, durable + replicated, NOT rebuildable** (it *is* source bytes), large scale. The non-negotiable, inherited verbatim from `ARCH-canonical-data-model.md` §13 and `ARCH-planetar-photos.md` §2–3:

> **Bytes never traverse the bus.** A photo or SAR chip is multi-megabyte; the bus is a nanosecond bus. The envelope body stays a few hundred bytes — it carries a `blob:sha256-…` handle (`{sha256,size,mime}`), never the JPEG. The hash *is* the integrity check (the same role CRC32 plays for the WAL). Identical bytes deduplicate for free.

| Pick R6 engine… | …when |
|---|---|
| **filesystem + sidecar** | Edge / air-gapped / POC. One directory `store/<aa>/<bb>/<sha256>` + `<sha256>.json` sidecar; the filesystem *is* the index, zero external services. This is exactly what `ARCH-planetar-photos.md` §3 specifies and what the maritime `edge` manifest binds (`13 §1`: `blob-cas: { engine: filesystem }`). Victoria-BBox scale (low thousands of images). |
| **MinIO / S3** | Standard / scale. S3 API, presigned URLs, lifecycle/replication, multipart for FMV. Self-host MinIO (sovereign / on-prem) or AWS S3 (managed). Same `@aws-sdk/client-s3` client for both — MinIO is S3-wire-compatible, so **one adapter class, endpoint-parameterized**. The default for any real deployment. |
| **GCS** | The client is GCP-resident (pairs naturally with a Spanner R1, see [`global-scale.md`](./global-scale.md)). Distinct client, same port. |

### R7 · vector — embeddings + KNN

R7 holds **embeddings (text, image, audio-SAI) + metadata for nearest-neighbor retrieval** ([`10 §R7`](../10-STORAGE-ROLES.md)). Contract: **eventual, p99 ≤ 50 ms ANN, durable, rebuildable** (re-embed from R6/R1). Two query shapes drive the platform: **visual re-ID** (photo↔EO↔SAR cosine on a shared scale, the `visual_similarity` rule of `ARCH-planetar-photos.md` §6.3) and **RAG retrieval** (ground an AIP/Agentforce answer in the client's own objects/documents).

| Pick R7 engine… | …when |
|---|---|
| **pgvector** | Default. Rides the **postgres a client already runs** for R1 — no second system, transactional with the canonical store, `ORDER BY embedding <=> $1` is plain SQL. HNSW index handles up to ~10M vectors comfortably. The "I already have postgres" choice; the maritime `edge`/`standard` manifest binds it on the same pg as R8 (`13 §1`). |
| **Qdrant** | Dedicated vector workload, rich **payload filtering** (filter by `marking`, `modality`, `vessel_id` *inside* the ANN search), quantization for memory, fast HNSW. The "vectors are a first-class workload, not a postgres side-table" choice. |
| **Milvus** | Billion-scale, GPU index options, multiple index types (IVF/HNSW/DiskANN), heavy throughput. The "national-imagery-archive / FMV-at-scale" choice. |
| **OpenSearch-kNN** | The client **already runs OpenSearch for R4** (object-index). One engine covers full-text *and* vector → hybrid lexical+semantic search in a single query. The "collapse R4+R7 onto opensearch" choice. |

Decision tie-back ([`README`](../README.md)): *custom spine + OSS breadth.* Every engine here is OSS or a managed-equivalent behind the port; the spine imports only `BlobCas` / `VectorStore`, never `@aws-sdk/client-s3` or `pg`. The thing that's custom — and the reason this works — is the **discipline** that the envelope carries a handle, not bytes: that lives in the detector SDK and the canonical model, both spine.

---

## 2. The ingest path — bytes → R6, embedding → R7, handle on R3

This is the path that makes a photo or a SAR chip a first-class fused observation without ever putting a JPEG on the ns bus. It generalizes `ARCH-planetar-photos.md` §5 (the 6-step `planetar-photo` pipeline) to any blob-bearing modality (EO frame, SAR chip, FMV keyframe, document).

```
detector / modality service (P2)   e.g. planetar-eo, planetar-sat, planetar-photo
  │  raw bytes (JPEG / GeoTIFF chip / PNG frame) + a computed embedding
  │
  1. PUT BYTES     blob = await blobCas.put(bytes, mime)          → {sha256,size,mime}   (R6)
  2. PUT EMBEDDING vecId = `emb:${model}:${sha256(vec)}`          
                   await vectorStore.upsert(vecId, embedding, {   (R7)
                     blobSha: blob.sha256, modality:'eo', vesselId:null, marking:'UNCLASS' })
  3. ENVELOPE      body = { image_ref:`blob:${blob.sha256}`, mime, width, height,
                           bytes:blob.size, embedding_ref:vecId, geo, captured_at_ns, … }
                   // body is a few hundred bytes — refs + metadata only
  4. PUBLISH       await stream.publish(zmesgEnvelope('eo.detection', body))   (R3)
  │
  └─ warm-path read surface:  GET /blob/:sha256   GET /thumb/:sha256?w=256   (presignRead)
```

The spine code that does this — the detector emit SDK — depends only on the two ports:

```ts
// spine/ingest/blob-observation.ts  — used by every blob-bearing detector (P2)
import type { BlobCas } from '../ports/blob-cas';
import type { VectorStore } from '../ports/vector';
import type { Stream } from '../ports/stream';
import { buildEnvelope } from '../codec/zmesg';   // planetar-ontology/src/codec/zmesg.ts

export interface BlobObservation {
  topic: string;            // 'eo.detection' | 'sar.chip' | 'photo.observation'
  source: string;           // 'src:planetar-eo' | 'src:planetar-photo-mobile' | ...
  modality: 'eo' | 'sar' | 'photo' | 'fmv' | 'doc';
  bytes: Uint8Array;
  mime: string;
  embedding?: Float32Array; // optional: CLIP-class image vector (ARCH-planetar-photos §6.3)
  embedModel?: string;      // 'clip-vitb32'
  marking: string;          // P1 governance; propagates to R6 object + R7 vector
  body: Record<string, unknown>;   // EXIF, geo, dims, claimed_name, … (NO bytes)
}

/** STORE → EMBED → ENVELOPE → PUBLISH. The only place bytes meet the platform. */
export async function emitBlobObservation(
  io: { blob: BlobCas; vector?: VectorStore; stream: Stream },
  obs: BlobObservation,
): Promise<{ sha256: string; vecRef: string | null }> {
  // 1. bytes → R6 (content-addressed; dedupes identical bytes for free)
  const handle = await io.blob.put(obs.bytes, obs.mime);   // {sha256,size,mime}

  // 2. embedding → R7 (vector never travels the envelope either)
  let vecRef: string | null = null;
  if (obs.embedding && io.vector) {
    vecRef = `emb:${obs.embedModel ?? 'clip'}:${handle.sha256}`;
    await io.vector.upsert(vecRef, obs.embedding, {
      blobSha: handle.sha256, modality: obs.modality, marking: obs.marking,
      vesselId: null,                       // set later by the resolver on merge
    });
  }

  // 3. envelope body = refs + metadata only (a few hundred bytes)
  const payload = Buffer.from(JSON.stringify({
    ...obs.body,
    image_ref: `blob:${handle.sha256}`,
    mime: handle.mime,
    bytes: handle.size,
    embedding_ref: vecRef,
    _marking: obs.marking,
  }));

  // 4. handle + vectorRef on the bus (R3). Bytes stayed in R6; vector stayed in R7.
  await io.stream.publish(buildEnvelope({
    topic: obs.topic, source: obs.source, schemaName: 'core:Observation',
    schemaVersion: 1, payload,
  }));

  return { sha256: handle.sha256, vecRef };
}
```

Downstream is the standard lifecycle ([`00 §4.1`](../00-ARCHITECTURE-OVERVIEW.md)): the broker fans the small envelope out; the canonical-store projector (R1) persists the observation with its `image_ref`/`embedding_ref`; the resolver (P5) reads the **vector by ref** (never off the bus) to run `visual_similarity`; on merge it back-fills `vesselId` into the R7 metadata so future filtered-KNN can scope by vessel. The UI (`planetar-ui` ImageryTab / entity-card gallery, `ARCH-planetar-photos.md` §9) renders thumbnails via `presignRead` — the bytes flow **client ⇄ R6 directly**, bypassing the bus and the Object API.

---

## 3. R6 adapters — implementing the exact `BlobCas` port

Port recap from [`12 §3`](../12-ADAPTER-CONTRACT.md):

```ts
// spine/ports/blob-cas.ts
export interface BlobHandle { sha256: string; size: number; mime: string; }

export interface BlobCas extends Adapter {
  put(bytes: Uint8Array, mime: string): Promise<BlobHandle>;   // content-addressed
  get(handle: BlobHandle): Promise<Uint8Array>;
  presignRead(handle: BlobHandle, ttlSec: number): Promise<string>;
}
```

All R6 adapters declare `consistency: 'eventual'`, `durable: true`, **`rebuildable: false`** (bytes are source — this is the one role besides R3/R11 that the compiler must *not* allow to be marked rebuildable), `immutable once written`. Content addressing is shared: `put` hashes the bytes with SHA-256 and uses the hex digest as the key, so the same bytes written twice resolve to the same object (free dedup, the integrity guarantee of `ARCH-planetar-photos.md` §3).

```ts
// spine/ports/blob-cas.ts (helper, shared by every adapter)
import { createHash } from 'node:crypto';
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** layout fan-out: store/<aa>/<bb>/<sha256> — avoids one giant directory. */
export function shardPath(sha: string): string { return `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`; }
```

### 3.1 `FsBlobCas` — filesystem + JSON sidecar (edge / air-gapped, the built pattern)

Directly realizes `ARCH-planetar-photos.md` §3: a plain directory, the filesystem as index, a sidecar for mime/size, an HTTP read surface. No external services — this is what the maritime `edge` manifest binds.

```ts
// 40-ADAPTERS/blob-cas/fs.ts
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  BlobCas, BlobHandle, AdapterContext, HealthStatus,
} from '../../spine/ports/blob-cas';
import { sha256Hex, shardPath } from '../../spine/ports/blob-cas';

export class FsBlobCas implements BlobCas {
  private root!: string;        // e.g. ./blobs  (manifest: blob-cas.config.root)
  private baseUrl!: string;     // read surface, e.g. http://127.0.0.1:7300

  readonly capabilities = {
    consistency: 'eventual', durable: true,
    rebuildable: false,                       // bytes are SOURCE — never re-derivable
    scale: 'single', p99TargetMs: 5,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { root: string; baseUrl?: string };
    this.root = cfg.root;
    this.baseUrl = cfg.baseUrl ?? 'http://127.0.0.1:7300';
    await mkdir(this.root, { recursive: true });
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await access(this.root); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }

  async close(): Promise<void> { /* nothing to drain */ }

  async put(bytes: Uint8Array, mime: string): Promise<BlobHandle> {
    const sha256 = sha256Hex(bytes);
    const handle: BlobHandle = { sha256, size: bytes.byteLength, mime };
    const path = join(this.root, shardPath(sha256));
    // CAS: immutable. If it already exists, the bytes are identical (hash equality) → skip.
    try { await access(path); return handle; } catch { /* not present → write */ }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.json`, JSON.stringify(handle));   // sidecar: mime + size
    return handle;
  }

  async get(handle: BlobHandle): Promise<Uint8Array> {
    return readFile(join(this.root, shardPath(handle.sha256)));
  }

  async presignRead(handle: BlobHandle, _ttlSec: number): Promise<string> {
    // No signing at the edge: the read surface (GET /blob/:sha256) is local + access-gated
    // by the same marking the adapter enforces. Returns the warm-path URL the UI fetches.
    return `${this.baseUrl}/blob/${handle.sha256}`;
  }
}
```

### 3.2 `S3BlobCas` — MinIO / AWS S3 (the workhorse, `@aws-sdk/client-s3`)

One class for both: MinIO is S3-wire-compatible, so a `endpoint` + `forcePathStyle` flag is the only difference (the §1 "one adapter, endpoint-parameterized" claim, mirroring how [`global-scale.md`](./global-scale.md) §3.2 shares one pg-wire class for CockroachDB/Yugabyte).

```ts
// 40-ADAPTERS/blob-cas/s3.ts
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  BlobCas, BlobHandle, AdapterContext, HealthStatus,
} from '../../spine/ports/blob-cas';
import { sha256Hex, shardPath } from '../../spine/ports/blob-cas';

export class S3BlobCas implements BlobCas {
  private s3!: S3Client;
  private bucket!: string;

  readonly capabilities = {
    consistency: 'eventual',     // S3 is read-after-write for new keys, eventual for overwrite
    durable: true,
    rebuildable: false,          // bytes are SOURCE
    scale: 'global', p99TargetMs: 30,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as {
      bucket: string; region?: string; endpoint?: string;   // endpoint set → MinIO / sovereign
      accessKeyId?: string; secretAccessKey?: string;
    };
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      region: cfg.region ?? 'us-east-1',
      endpoint: cfg.endpoint,                          // undefined → real AWS S3
      forcePathStyle: !!cfg.endpoint,                  // true for MinIO path-style addressing
      credentials: cfg.accessKeyId
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey! }
        : undefined,                                   // undefined → IAM role / instance creds
    });
    await this.health();   // fail init() fast if the bucket is unreachable
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      // HEAD a known-absent key: 404 proves connectivity + auth without listing the bucket.
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: '__health__' }))
        .catch((e: any) => { if (e?.$metadata?.httpStatusCode !== 404) throw e; });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }

  async close(): Promise<void> { this.s3.destroy(); }

  private key(sha256: string): string { return `blobs/${shardPath(sha256)}`; }

  async put(bytes: Uint8Array, mime: string): Promise<BlobHandle> {
    const sha256 = sha256Hex(bytes);
    const handle: BlobHandle = { sha256, size: bytes.byteLength, mime };
    // CAS: the key IS the hash, so a re-PUT is byte-identical and idempotent.
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: this.key(sha256),
      Body: bytes, ContentType: mime,
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),   // S3 verifies on write
      Metadata: { sha256, size: String(handle.size) },
    }));
    return handle;
  }

  async get(handle: BlobHandle): Promise<Uint8Array> {
    const out = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket, Key: this.key(handle.sha256),
    }));
    return new Uint8Array(await out.Body!.transformToByteArray());
  }

  async presignRead(handle: BlobHandle, ttlSec: number): Promise<string> {
    // Presigned GET: the UI fetches bytes directly from S3/MinIO — never through the bus or API.
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket, Key: this.key(handle.sha256),
    }), { expiresIn: ttlSec });
  }
}
```

### 3.3 `GcsBlobCas` — Google Cloud Storage (sketch; same port, distinct client)

```ts
// 40-ADAPTERS/blob-cas/gcs.ts (abridged — identical port, GCS client)
import { Storage } from '@google-cloud/storage';
import type { BlobCas, BlobHandle, AdapterContext } from '../../spine/ports/blob-cas';
import { sha256Hex, shardPath } from '../../spine/ports/blob-cas';

export class GcsBlobCas implements BlobCas {
  private bucket!: ReturnType<Storage['bucket']>;
  readonly capabilities = { consistency: 'eventual', durable: true, rebuildable: false,
    scale: 'global', p99TargetMs: 30 } as const;

  async init(ctx: AdapterContext) {
    const cfg = ctx.manifest.config as { bucket: string; projectId?: string };
    this.bucket = new Storage({ projectId: cfg.projectId }).bucket(cfg.bucket);
  }
  async put(bytes: Uint8Array, mime: string): Promise<BlobHandle> {
    const sha256 = sha256Hex(bytes);
    await this.bucket.file(`blobs/${shardPath(sha256)}`).save(Buffer.from(bytes), { contentType: mime });
    return { sha256, size: bytes.byteLength, mime };
  }
  async get(h: BlobHandle): Promise<Uint8Array> {
    const [buf] = await this.bucket.file(`blobs/${shardPath(h.sha256)}`).download();
    return new Uint8Array(buf);
  }
  async presignRead(h: BlobHandle, ttlSec: number): Promise<string> {
    const [url] = await this.bucket.file(`blobs/${shardPath(h.sha256)}`)
      .getSignedUrl({ action: 'read', expires: Date.now() + ttlSec * 1000 });
    return url;
  }
  async health() { const t0 = Date.now();
    try { await this.bucket.exists(); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; } }
  async close() { /* GCS client is stateless */ }
}
```

---

## 4. R7 adapters — implementing the exact `VectorStore` port

Port recap from [`12 §3`](../12-ADAPTER-CONTRACT.md):

```ts
// spine/ports/vector.ts
export interface ScoredId { id: string; score: number; }   // score = cosine similarity ∈ [-1,1]
export interface VectorStore extends Adapter {
  upsert(id: string, vec: Float32Array, meta: Json): Promise<void>;
  knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]>;
}
```

All R7 adapters declare `consistency: 'eventual'`, `durable: true`, **`rebuildable: true`** (re-embed from R6/R1, `10 §R7`), and return **cosine** similarity so scores are comparable across engines and across modalities — the prerequisite for `ARCH-planetar-photos.md` §6.3's "score visual similarity on the **same calibrated scale** as AIS/kinematic." Vectors are L2-normalized on `upsert` so cosine = dot product, the cheapest ANN metric. **`filter` scopes the search by metadata** (`modality`, `vesselId`, `marking`) — this is what makes cross-modal re-ID and marking-aware RAG possible in one call.

### 4.1 `PgVectorStore` — pgvector (default; rides the client's postgres)

```ts
// 40-ADAPTERS/vector/pgvector.ts
import { Pool } from 'pg';
import type {
  VectorStore, ScoredId, AdapterContext, HealthStatus, Json,
} from '../../spine/ports/vector';

function l2normalize(v: Float32Array): Float32Array {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o;
}
const vecLiteral = (v: Float32Array) => `[${Array.from(v).join(',')}]`;   // pgvector text form

export class PgVectorStore implements VectorStore {
  private pool!: Pool;
  private dim!: number;

  readonly capabilities = {
    consistency: 'eventual', durable: true,
    rebuildable: true,                       // re-embed from R6/R1
    scale: 'vertical', p99TargetMs: 50,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { connection: object; dim: number };
    this.dim = cfg.dim;                       // e.g. 512 (CLIP ViT-B/32)
    this.pool = new Pool(cfg.connection as any);
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS embedding(
         id text PRIMARY KEY,
         vec vector(${this.dim}) NOT NULL,
         modality text, vessel_id text, marking text, blob_sha text,
         meta jsonb NOT NULL DEFAULT '{}')`);
    // HNSW index on cosine distance (<=>). Built once; ANN scales to ~10M rows here.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS embedding_vec_hnsw
         ON embedding USING hnsw (vec vector_cosine_ops)`);
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.pool.query('SELECT 1'); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async upsert(id: string, vec: Float32Array, meta: Json): Promise<void> {
    const m = (meta ?? {}) as Record<string, unknown>;
    await this.pool.query(
      `INSERT INTO embedding(id, vec, modality, vessel_id, marking, blob_sha, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(id) DO UPDATE SET vec=$2, modality=$3, vessel_id=$4,
                                     marking=$5, blob_sha=$6, meta=$7`,
      [id, vecLiteral(l2normalize(vec)), m.modality ?? null, m.vesselId ?? null,
       m.marking ?? null, m.blobSha ?? null, m]);
  }

  async knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]> {
    const where: string[] = []; const args: unknown[] = [vecLiteral(l2normalize(vec))]; let n = 1;
    const f = (filter ?? {}) as Record<string, unknown>;
    for (const col of ['modality', 'vessel_id', 'marking'] as const) {
      // accept camelCase 'vesselId' from callers as well as snake column names
      const v = f[col] ?? f[col.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
      if (v != null) { where.push(`${col} = $${++n}`); args.push(v); }
    }
    args.push(k);
    const { rows } = await this.pool.query(
      // 1 - cosine_distance = cosine_similarity ∈ [-1,1]; ORDER BY distance ASC = most similar first
      `SELECT id, 1 - (vec <=> $1) AS score FROM embedding
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY vec <=> $1 LIMIT $${++n}`, args);
    return rows.map(r => ({ id: r.id, score: Number(r.score) }));
  }
}
```

### 4.2 `QdrantVectorStore` — Qdrant (dedicated, payload-filtered ANN)

```ts
// 40-ADAPTERS/vector/qdrant.ts
import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  VectorStore, ScoredId, AdapterContext, HealthStatus, Json,
} from '../../spine/ports/vector';

export class QdrantVectorStore implements VectorStore {
  private q!: QdrantClient;
  private collection!: string;
  private dim!: number;

  readonly capabilities = {
    consistency: 'eventual', durable: true, rebuildable: true,
    scale: 'sharded', p99TargetMs: 30,
  } as const;

  async init(ctx: AdapterContext): Promise<void> {
    const cfg = ctx.manifest.config as { url: string; apiKey?: string; collection: string; dim: number };
    this.q = new QdrantClient({ url: cfg.url, apiKey: cfg.apiKey });
    this.collection = cfg.collection; this.dim = cfg.dim;
    const exists = await this.q.collectionExists(this.collection);
    if (!exists.exists) {
      await this.q.createCollection(this.collection, {
        vectors: { size: this.dim, distance: 'Cosine' },   // cosine → comparable scores
      });
      // payload indexes make filtered KNN (by vessel/modality/marking) fast
      for (const field of ['modality', 'vessel_id', 'marking']) {
        await this.q.createPayloadIndex(this.collection, { field_name: field, field_schema: 'keyword' });
      }
    }
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try { await this.q.getCollection(this.collection); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; }
  }

  async close(): Promise<void> { /* REST client is stateless */ }

  async upsert(id: string, vec: Float32Array, meta: Json): Promise<void> {
    const m = (meta ?? {}) as Record<string, unknown>;
    await this.q.upsert(this.collection, {
      wait: true,
      points: [{
        id: hashTo64(id),                  // qdrant ids are uint64 | uuid; map our string id
        vector: Array.from(vec),
        payload: { ext_id: id, modality: m.modality ?? null, vessel_id: m.vesselId ?? null,
                   marking: m.marking ?? null, blob_sha: m.blobSha ?? null },
      }],
    });
  }

  async knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]> {
    const f = (filter ?? {}) as Record<string, unknown>;
    const must: object[] = [];
    for (const [key, col] of [['modality','modality'],['vesselId','vessel_id'],['marking','marking']] as const) {
      const v = f[key] ?? f[col];
      if (v != null) must.push({ key: col, match: { value: v } });
    }
    const res = await this.q.search(this.collection, {
      vector: Array.from(vec), limit: k,
      filter: must.length ? { must } : undefined,
      with_payload: true,
    });
    // qdrant returns cosine similarity directly as `score`
    return res.map(p => ({ id: String((p.payload as any)?.ext_id ?? p.id), score: p.score }));
  }
}

/** stable string → uint64 (FNV-1a 64) so our envelope ids map to qdrant point ids. */
function hashTo64(s: string): number {
  let h = 0xcbf29ce484222325n; for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(h & 0x1fffffffffffffn);   // clamp to JS safe-int range for the client
}
```

### 4.3 `MilvusVectorStore` / `OpenSearchKnnVectorStore` (sketches; same port)

```ts
// 40-ADAPTERS/vector/milvus.ts (abridged — billion-scale; @zilliz/milvus2-sdk-node)
import { MilvusClient, DataType, MetricType } from '@zilliz/milvus2-sdk-node';
import type { VectorStore, ScoredId, AdapterContext, Json } from '../../spine/ports/vector';

export class MilvusVectorStore implements VectorStore {
  private c!: MilvusClient; private coll!: string;
  readonly capabilities = { consistency: 'eventual', durable: true, rebuildable: true,
    scale: 'global', p99TargetMs: 50 } as const;
  async init(ctx: AdapterContext) {
    const cfg = ctx.manifest.config as { address: string; collection: string; dim: number };
    this.c = new MilvusClient({ address: cfg.address }); this.coll = cfg.collection;
    await this.c.createCollection({ collection_name: this.coll, fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 128 },
      { name: 'vec', data_type: DataType.FloatVector, dim: cfg.dim },
      { name: 'modality', data_type: DataType.VarChar, max_length: 16 },
      { name: 'vessel_id', data_type: DataType.VarChar, max_length: 64 },
      { name: 'marking', data_type: DataType.VarChar, max_length: 32 },
    ]}).catch(() => {});   // idempotent create
    await this.c.createIndex({ collection_name: this.coll, field_name: 'vec',
      index_type: 'HNSW', metric_type: MetricType.COSINE, params: { M: 16, efConstruction: 200 } });
    await this.c.loadCollection({ collection_name: this.coll });
  }
  async upsert(id: string, vec: Float32Array, meta: Json) {
    const m = (meta ?? {}) as Record<string, any>;
    await this.c.upsert({ collection_name: this.coll, data: [{ id, vec: Array.from(vec),
      modality: m.modality ?? '', vessel_id: m.vesselId ?? '', marking: m.marking ?? '' }] });
  }
  async knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]> {
    const f = (filter ?? {}) as Record<string, any>;
    const exprs: string[] = [];
    if (f.modality) exprs.push(`modality == "${f.modality}"`);
    if (f.vesselId ?? f.vessel_id) exprs.push(`vessel_id == "${f.vesselId ?? f.vessel_id}"`);
    if (f.marking) exprs.push(`marking == "${f.marking}"`);
    const res = await this.c.search({ collection_name: this.coll, data: [Array.from(vec)],
      limit: k, output_fields: ['id'], filter: exprs.join(' and ') || undefined });
    return res.results.map(r => ({ id: String(r.id), score: r.score }));   // COSINE metric → similarity
  }
  async health() { const t0 = Date.now();
    try { await this.c.checkHealth(); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; } }
  async close() { await this.c.closeConnection(); }
}
```

```ts
// 40-ADAPTERS/vector/opensearch-knn.ts (abridged — collapses R4+R7 onto one engine)
import { Client } from '@opensearch-project/opensearch';
import type { VectorStore, ScoredId, AdapterContext, Json } from '../../spine/ports/vector';

export class OpenSearchKnnVectorStore implements VectorStore {
  private os!: Client; private index!: string;
  readonly capabilities = { consistency: 'eventual', durable: true, rebuildable: true,
    scale: 'sharded', p99TargetMs: 50 } as const;
  async init(ctx: AdapterContext) {
    const cfg = ctx.manifest.config as { node: string; index: string; dim: number };
    this.os = new Client({ node: cfg.node }); this.index = cfg.index;
    const exists = await this.os.indices.exists({ index: this.index });
    if (!exists.body) await this.os.indices.create({ index: this.index, body: {
      settings: { index: { knn: true } },
      mappings: { properties: {
        vec: { type: 'knn_vector', dimension: cfg.dim,
               method: { name: 'hnsw', space_type: 'cosinesimil', engine: 'lucene' } },
        modality: { type: 'keyword' }, vessel_id: { type: 'keyword' }, marking: { type: 'keyword' },
      }}}});
  }
  async upsert(id: string, vec: Float32Array, meta: Json) {
    const m = (meta ?? {}) as Record<string, any>;
    await this.os.index({ index: this.index, id, refresh: true, body: {
      vec: Array.from(vec), modality: m.modality, vessel_id: m.vesselId, marking: m.marking } });
  }
  async knn(vec: Float32Array, k: number, filter?: Json): Promise<ScoredId[]> {
    const f = (filter ?? {}) as Record<string, any>;
    const must = Object.entries({ modality: f.modality, vessel_id: f.vesselId ?? f.vessel_id,
      marking: f.marking }).filter(([, v]) => v != null).map(([key, value]) => ({ term: { [key]: value } }));
    const res = await this.os.search({ index: this.index, body: {
      size: k, query: { bool: { must, filter: { knn: { vec: { vector: Array.from(vec), k } } } } } } });
    // cosinesimil score = (1 + cosine) / 2 ∈ [0,1]; map back to [-1,1] for cross-engine comparability
    return res.body.hits.hits.map((h: any) => ({ id: h._id, score: 2 * h._score - 1 }));
  }
  async health() { const t0 = Date.now();
    try { await this.os.cluster.health(); return { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e) }; } }
  async close() { await this.os.close(); }
}
```

---

## 5. The two queries that matter — visual re-ID and RAG

Both are spine code that imports **only** `VectorStore` (and reads bytes via `BlobCas`); neither knows which engine is bound. This is where R7 earns its place in the proposal.

### 5.1 Visual re-ID — photo ↔ EO ↔ SAR cosine on one calibrated scale

The flagship `visual_similarity` match rule (`ARCH-planetar-photos.md` §6.3): a dock photo of a hull is scored against EO detections and SAR chips by cosine similarity, *on the same scale* every other modality's confidence is calibrated to, so the multi-method log-score fusion (`03-ARCHITECTURE.md` Layer 4) can combine it with AIS/kinematic evidence.

```ts
// spine/resolve/visual-reid.ts  — the new P5 match rule; engine-agnostic
import type { VectorStore } from '../ports/vector';

export interface ReidCandidate { obsId: string; modality: string; cosine: number; confidence: number; }

/**
 * Given a fresh photo embedding, find the same hull across feeds.
 * Searches photo↔photo (re-ID under a changed name), photo↔EO (same modality family),
 * and photo↔SAR (cross-modal, the stretch). Filtered KNN keeps each modality separable
 * so calibration (§6.3) can weight them differently.
 */
export async function visualReId(
  vector: VectorStore,
  photoEmbedding: Float32Array,
  opts: { k?: number; marking: string } = { marking: 'UNCLASS' },
): Promise<ReidCandidate[]> {
  const k = opts.k ?? 10;
  const out: ReidCandidate[] = [];
  for (const modality of ['photo', 'eo', 'sar'] as const) {
    // marking filter = P1 governance: an UNCLASS query never matches against OPS-RESTRICTED vectors
    const hits = await vector.knn(photoEmbedding, k, { modality, marking: opts.marking });
    for (const h of hits) {
      out.push({ obsId: h.id, modality, cosine: h.score, confidence: calibrate(modality, h.score) });
    }
  }
  // the resolver folds `confidence` into the §6.5 thresholds: merge ≥0.95, link 0.80–0.94, review 0.70–0.79
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Map raw cosine → calibrated confidence per modality (ARCH-planetar-photos §6.3 weights).
 * photo↔photo is the most trustworthy, photo↔SAR the least (genuinely cross-modal).
 * Real calibration is fit on a small labelled set (the research deliverable); this is the shape.
 */
function calibrate(modality: string, cosine: number): number {
  const ceiling = { photo: 0.85, eo: 0.80, sar: 0.65 }[modality] ?? 0.6;
  const floor = 0.5;                                   // below this cosine, no signal
  return Math.max(0, Math.min(ceiling, (cosine - floor) / (1 - floor) * ceiling));
}
```

The resolver then merges (lifecycle [`00 §4.1`](../00-ARCHITECTURE-OVERVIEW.md)) and **back-fills `vesselId`** into the matched vectors' metadata (`vector.upsert(id, vec, {vesselId})`), so a later query can scope KNN to "more imagery of *this* vessel" — turning a one-shot match into a growing per-hull fingerprint set.

### 5.2 RAG retrieval — grounding an AIP / Agentforce answer

AIP/Agentforce agents ground answers in the client's own objects ([`11 §2`](../11-CAPABILITY-ROLE-MAP.md): `agents-rag = {R7, R6, R10}`). The agent is a **read** path; any state change it proposes flows through P7 kinetic (`00 §3` principle 3), never a direct write — the vector store is grounding, not authority.

```ts
// spine/agents/rag-retrieve.ts  — engine-agnostic RAG grounding (P8 surface → P7 for writes)
import type { VectorStore } from '../ports/vector';
import type { BlobCas, BlobHandle } from '../ports/blob-cas';

export interface Grounding { chunkId: string; score: number; sourceUri: string | null; }

/**
 * Embed the user/agent query (via the manifest's embedding gateway — an OSS LLM gateway behind
 * an adapter, never imported here), KNN against the doc-chunk vectors, return grounded passages.
 * `marking` gates retrieval to what the calling principal may see — RAG inherits P1 governance,
 * so an agent cannot surface a passage from a document above the user's clearance.
 */
export async function ragRetrieve(
  io: { vector: VectorStore; blob: BlobCas },
  queryEmbedding: Float32Array,
  ctx: { k?: number; marking: string },
): Promise<Grounding[]> {
  const hits = await io.vector.knn(queryEmbedding, ctx.k ?? 8, { modality: 'doc', marking: ctx.marking });
  return Promise.all(hits.map(async h => {
    // each chunk vector's metadata carries the blobSha of its source document
    const handle = (h as any).blobSha as BlobHandle | undefined;
    return { chunkId: h.id, score: h.score,
             sourceUri: handle ? await io.blob.presignRead(handle, 300) : null };
  }));
}
```

---

## 6. Comparison table

### R6 · blob-cas

| Engine | Client lib | Consistency | Scale | p99 (single-object get) | When to choose |
|---|---|---|---|---|---|
| **filesystem + sidecar** | `node:fs` | strong-local (read-after-write) | single-node | ~1–5 ms | edge / air-gapped / POC — built pattern (`ARCH-planetar-photos.md` §3); the maritime `edge` manifest |
| **MinIO** | `@aws-sdk/client-s3` | read-after-write (new key) | sharded / cluster | ~10–40 ms | sovereign / on-prem S3; standard + scale tiers without a cloud dependency |
| **AWS S3** | `@aws-sdk/client-s3` | read-after-write (new key) | global | ~20–60 ms | managed, 11-nines durability, lifecycle/replication; the default cloud pick |
| **GCS** | `@google-cloud/storage` | read-after-write (new key) | global | ~20–60 ms | GCP-resident clients (pairs with a Spanner R1) |

### R7 · vector

| Engine | Client lib | Index | Consistency | Scale | p99 ANN | When to choose |
|---|---|---|---|---|---|---|
| **pgvector** | `pg` | HNSW | eventual (refresh-after-write) | vertical (~10M vec) | ~10–50 ms | rides the client's existing postgres; no second system; transactional with R1 |
| **Qdrant** | `@qdrant/js-client-rest` | HNSW + quantization | eventual | sharded | ~5–30 ms | dedicated workload, rich payload filtering, memory efficiency |
| **Milvus** | `@zilliz/milvus2-sdk-node` | HNSW / IVF / DiskANN | eventual | global (billion-scale) | ~10–50 ms | national-archive / FMV-at-scale, GPU indexes |
| **OpenSearch-kNN** | `@opensearch-project/opensearch` | HNSW (Lucene/nmslib/faiss) | eventual | sharded | ~20–50 ms | client already runs OpenSearch for R4 → collapse R4+R7 (hybrid lexical+semantic) |

**The honest tradeoffs:**

- **R6: bytes are SOURCE, so the engine choice is about *durability and access*, not *correctness*.** Unlike R1 (where `eventual` is a compile-time error), every R6 engine is `eventual` and that's fine — the content hash *is* the consistency guarantee (the bytes for a given sha256 are byte-identical everywhere or the hash wouldn't match). The compiler's one hard rule for R6: **`rebuildable: false`** — a manifest that marks the blob store rebuildable is rejected, because re-deriving source bytes from the bus is impossible (the bus only ever carried the handle).
- **R7: the metric must be cosine and vectors L2-normalized**, or the cross-engine/cross-modality comparability that §5.1 calibration depends on breaks. OpenSearch's `cosinesimil` returns `(1+cos)/2`; the adapter maps it back to `[-1,1]` so a score from opensearch means the same thing as a score from pgvector. **Scores are calibrated, not raw** — the research contribution (`ARCH-planetar-photos.md` §6.3, §13) is the calibration, and it lives in spine code (`visual-reid.ts §5.1`), above the port, so it's identical on every engine.
- **pgvector vs dedicated:** pgvector wins on operational simplicity up to ~10M vectors; past that, HNSW build time and recall degrade and a dedicated engine (Qdrant for filtering, Milvus for scale) earns its second system. Because R7 is **rebuildable** (`10 §R7`), this is a reversible, deferrable choice — start on pgvector, re-embed into Qdrant later, no app change (the same re-projection argument as [`global-scale.md`](./global-scale.md) §4 for R1).

---

## 7. Conformance-suite hookup

Both ports ship one engine-agnostic suite ([`12 §5`](../12-ADAPTER-CONTRACT.md)); an engine is "supported for the role" only when green. Same suite, every engine = blind swappability per client.

```ts
// 40-ADAPTERS/_conformance/blob-cas.spec.ts
export function blobCasConformance(make: () => BlobCas) {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);   // tiny JPEG-ish

  test('put is content-addressed: handle.sha256 == sha256(bytes)', async () => {
    const s = make(); await s.init(testCtx());
    const h = await s.put(bytes, 'image/jpeg');
    expect(h.sha256).toBe(sha256Hex(bytes));
    expect(h.size).toBe(bytes.byteLength);
    expect(h.mime).toBe('image/jpeg');
  });
  test('round-trips bytes by handle', async () => {
    const s = make(); await s.init(testCtx());
    const h = await s.put(bytes, 'image/jpeg');
    expect(await s.get(h)).toEqual(bytes);
  });
  test('put is idempotent — identical bytes dedupe to one object', async () => {
    const s = make(); await s.init(testCtx());
    const a = await s.put(bytes, 'image/jpeg');
    const b = await s.put(bytes, 'image/jpeg');
    expect(a.sha256).toBe(b.sha256);          // same hash → same key → no duplicate
  });
  test('presignRead returns a fetchable URL', async () => {
    const s = make(); await s.init(testCtx());
    const h = await s.put(bytes, 'image/jpeg');
    expect(await s.presignRead(h, 60)).toMatch(/^https?:\/\//);
  });
  test('declares capabilities that satisfy R6 (and is NOT rebuildable)', () => {
    const cap = make().capabilities;
    expect(satisfies(ROLE_CONTRACT['blob-cas'], cap)).toBe(true);
    expect(cap.rebuildable).toBe(false);      // bytes are source — the R6 hard rule
  });
}
// then: blobCasConformance(() => new FsBlobCas())
//       blobCasConformance(() => new S3BlobCas())     // against MinIO in CI
//       blobCasConformance(() => new GcsBlobCas())    // against the GCS emulator (fake-gcs-server)
```

```ts
// 40-ADAPTERS/_conformance/vector.spec.ts
export function vectorStoreConformance(make: () => VectorStore) {
  const a = unit([1, 0, 0]), b = unit([0.9, 0.1, 0]), c = unit([0, 0, 1]);   // a≈b, c orthogonal

  test('knn returns the nearest by cosine, descending score', async () => {
    const s = make(); await s.init(testCtx({ dim: 3 }));
    await s.upsert('a', a, { modality: 'photo', marking: 'UNCLASS' });
    await s.upsert('c', c, { modality: 'photo', marking: 'UNCLASS' });
    const res = await s.knn(b, 2);
    expect(res[0].id).toBe('a');              // a is nearest to b
    expect(res[0].score).toBeGreaterThan(res[1].score);
    expect(res[0].score).toBeGreaterThan(0.9);   // cosine(a,b) high
  });
  test('filtered knn scopes by metadata (the re-ID / governance primitive)', async () => {
    const s = make(); await s.init(testCtx({ dim: 3 }));
    await s.upsert('eo1',  a, { modality: 'eo',  marking: 'UNCLASS' });
    await s.upsert('sar1', a, { modality: 'sar', marking: 'UNCLASS' });
    const res = await s.knn(a, 5, { modality: 'eo' });
    expect(res.map(r => r.id)).toEqual(['eo1']);   // sar1 filtered out
  });
  test('marking filter enforces P1 governance — clearance scopes retrieval', async () => {
    const s = make(); await s.init(testCtx({ dim: 3 }));
    await s.upsert('secret', a, { modality: 'doc', marking: 'OPS-RESTRICTED' });
    expect(await s.knn(a, 5, { modality: 'doc', marking: 'UNCLASS' })).toHaveLength(0);
  });
  test('upsert is idempotent on id', async () => {
    const s = make(); await s.init(testCtx({ dim: 3 }));
    await s.upsert('x', a, {}); await s.upsert('x', c, {});   // second wins
    const res = await s.knn(c, 1);
    expect(res[0].id).toBe('x');
  });
  test('declares capabilities that satisfy R7 (rebuildable: re-embed from R6/R1)', () => {
    const cap = make().capabilities;
    expect(satisfies(ROLE_CONTRACT['vector'], cap)).toBe(true);
    expect(cap.rebuildable).toBe(true);
  });
}
// then: vectorStoreConformance(() => new PgVectorStore())
//       vectorStoreConformance(() => new QdrantVectorStore())   // ephemeral qdrant in CI
//       vectorStoreConformance(() => new MilvusVectorStore())   // milvus-standalone in CI
//       vectorStoreConformance(() => new OpenSearchKnnVectorStore())
```

The shared cross-engine assertion that makes calibration trustworthy: **the same `(a,b,c)` vectors must produce cosine scores within ε across every engine** — a `vectorStoreConformance.crossEngine()` case runs all four adapters on the identical triple and asserts the scores agree to 1e-3. If opensearch's score-remap or qdrant's metric drifted, the calibration in §5.1 would silently mean different things per engine; this test forbids that.

---

## 8. Which manifest tiers / clients bind these

| Tier ([`13 §1`](../13-CLIENT-MANIFEST.md)) | R6 binding | R7 binding | Rationale |
|---|---|---|---|
| `edge` / `air-gapped` | **filesystem** | **pgvector** (on the edge postgis pg) or **none** | one directory + sidecar, no services; vector only if `visual-reid`/`agents-rag` is enabled — else unbound (`13 §2`: no capability ⇒ no binding) |
| `standard` | **MinIO** | **pgvector** | one S3-compat store; vectors ride the existing pg; no dedicated vector service |
| `scale` | **S3** / **MinIO** | **Qdrant** or **Milvus** | managed durability; dedicated vector engine once volume/filtering outgrows pgvector |
| `scale` (GCP) | **GCS** | **pgvector**/**Qdrant** | pairs with a Spanner R1 (`global-scale.md`) |

Across the four reference clients ([`README`](../README.md)):

- **Maritime / defence (`planetar`)** — *edge today.* R6 = **filesystem** (the `ARCH-planetar-photos.md` §3 CAS, the only built blob path). R7 = **pgvector** on the same postgis pg as R8, bound **only because `dark-vessel-reid` + the photos modality need it** (`visual_similarity`, §5.1) — the flagship demo. Scale-up: filesystem → MinIO (sovereign, *not* S3/GCS — sovereignty rules out the US clouds, same logic as `global-scale.md` §7 picking CockroachDB over Spanner), pgvector → Qdrant if imagery volume grows.
- **Biotech / research CRM (`doibio`)** — R6 = **MinIO** for attachments/documents (doibio's CSV/import + ~20 micro-frontends). R7 = **pgvector** for **knowledge-article / literature semantic match** and Cohere-style chat grounding (doibio already ships Elasticsearch + Cohere AI chat; the RAG path §5.2 formalizes it). `standard` tier.
- **Generic enterprise CRM+ops** — R6 = **S3** for Salesforce-Files-equivalent content. R7 = **pgvector** for Einstein/Agentforce-style RAG over the client's objects (§5.2). Collapses to **opensearch-knn** if the client already runs OpenSearch for R4 (one engine, hybrid search). The clean Data-Cloud-vector-DB story.
- **Intel / financial-crime graph** — R6 = **S3/MinIO** for dossier imagery/documents/FMV (Gotham imagery-exploitation parity). R7 = **Milvus** or **Qdrant** for face/object/document embedding search at archive scale, filtered by case/marking. `scale` tier, paired with R5 (falkordb/neo4j) for the link graph.

**Foundry / Gotham / Salesforce mapping** (the parity claim these two roles cover, for `20-PARITY-MATRIX/`):

| Their feature | Plane | Roles | Our realization |
|---|---|---|---|
| Foundry **media sets** | P2,P6,P8 | **R6**, R1, *R7* | blob handle in the envelope (`emitBlobObservation §2`); thumbnails via `presignRead` |
| Gotham **imagery / FMV exploitation** | P2,P8 | **R6**, *R7* | SAR-chip / EO-frame / FMV-keyframe → R6; visual re-ID via R7 (§5.1) |
| Salesforce **Files / Content / Attachments** | P8 | **R6** | content-addressed store; FLS-gated reads via the marking-aware `presignRead` |
| AIP / **Agentforce RAG** grounding | P7,P8 | **R7**, R6, R10 | `ragRetrieve §5.2`; writes contained through P7 kinetic, never direct |
| **Data Cloud vector DB** / semantic search | P6,P9 | **R7**, *R4* | `VectorStore` port; collapses onto opensearch-knn for hybrid lexical+semantic |
| **visual / appearance re-ID** (the planetar flagship) | P5 | **R7**, R6, R1 | `visualReId §5.1` — photo↔EO↔SAR cosine on one calibrated scale |

The invariance holds, exactly as for R1 in [`global-scale.md`](./global-scale.md): the detector emit SDK, the resolver's `visual_similarity` rule, the RAG retriever, the Object API, and the UI gallery are **byte-for-byte identical** whether bytes land in a filesystem directory on an air-gapped boat or in S3 across three regions, and whether embeddings live in pgvector or Milvus. One conformance suite green on three blob engines and four vector engines behind two ports — that invariance is the deliverable.
