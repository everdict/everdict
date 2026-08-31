import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type ArtifactStore, artifactKeyOf } from "@everdict/application-control";
import { ConflictError, UpstreamError } from "@everdict/contracts";

export interface S3ArtifactStoreOptions {
  endpoint: string; // S3 API endpoint (e.g. http://localhost:9100 = MinIO)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // default us-east-1
  presignTtlSec?: number; // GET presigned URL expiry (default 3600)
  // The address the BROWSER reaches the store at, when it differs from the server-internal endpoint
  // (e.g. endpoint=http://minio:9000, publicBaseUrl=https://artifacts.example.com). Only `publicUrlFor` signs for
  // it — see the presigner below.
  publicBaseUrl?: string;
}

// Artifact store for S3-compatible object storage (incl. MinIO). put → PutObject then returns a presigned GET URL (only the URL stays in the record).
// MinIO requires path-style (forcePathStyle). Credentials/endpoint are injected by the control plane via env/secrets (no plaintext in the spec).
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client; // server-internal endpoint — put/get/bucket calls
  private readonly presigner: S3Client; // signs the browser-facing URL (publicBaseUrl when set, else the same endpoint)
  // The addresses this store ever MINTS a URL at — the only ones a legacy presigned ref can have come from,
  // and therefore the only ones `keyOf` will re-sign. An unparseable option contributes nothing rather than
  // widening the set: with no origins, every legacy URL is refused and only the stable handle resolves.
  private readonly signedOrigins: ReadonlySet<string>;
  constructor(private readonly opts: S3ArtifactStoreOptions) {
    this.signedOrigins = new Set(
      [opts.endpoint, opts.publicBaseUrl].flatMap((address) => {
        if (address === undefined) return [];
        try {
          return [new URL(address).origin];
        } catch {
          return [];
        }
      }),
    );
    const shared = {
      region: opts.region ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    };
    this.client = new S3Client({ endpoint: opts.endpoint, ...shared });
    // SigV4 signs the HOST, so a presigned URL cannot be host-swapped after the fact — rewriting the string produced
    // `403 SignatureDoesNotMatch` (verified against MinIO). When the browser reaches the store at another address we
    // therefore SIGN FOR THAT ADDRESS with a second client, instead of patching the signed URL.
    this.presigner = opts.publicBaseUrl ? new S3Client({ endpoint: opts.publicBaseUrl, ...shared }) : this.client;
  }

  private signedUrl(client: S3Client, key: string): Promise<string> {
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), {
      expiresIn: this.opts.presignTtlSec ?? 3600,
    });
  }

  // Ensure the bucket (create if absent). Recommended to call once at startup — not on every put.
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.opts.bucket })).catch(() => {});
    }
  }

  // The returned ref is a SERVER-side handle: signed for the in-network endpoint, because that is who re-reads it
  // (a judge resolving evidence, the analysis download). What a browser gets is minted at read time by publicUrlFor —
  // handing the persisted ref to a page would ship an unresolvable host and an hour-old signature.
  //
  // ── AN OBJECT WHOSE KEY ENCODES ITS CONTENT IS WRITTEN ONCE (arch-review 66 P1-provenance) ─────────
  //
  // The two-phase case's intermediates are addressed by a digest of their own bytes (`agentHalfKey`), which
  // reads like content addressing and was not: a plain `PutObject` overwrites, so a second writer at that
  // key replaced the document the digest names. The recovery re-derives the digest on the way in now, which
  // is the half that MUST be there — this is the other half, refusing the overwrite at the source.
  //
  // `IfNoneMatch: "*"` is the S3 conditional create (and MinIO implements it). A key that already holds
  // bytes answers 412, and for a content-addressed object that is the IDEMPOTENT case rather than an error:
  // the same digest means the same bytes, so the write is already done. Any other failure propagates.
  //
  // Applied only when the caller declares the object immutable, because this store also holds run media that
  // is legitimately re-uploaded (a refreshed snapshot ref, a re-rendered analysis artifact).
  async put(
    key: string,
    data: Uint8Array,
    contentType: string,
    opts?: { immutable?: boolean; digest?: string },
  ): Promise<string> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          ...(opts?.immutable === true ? { IfNoneMatch: "*" } : {}),
        }),
      );
    } catch (err) {
      // ── A TAKEN KEY IS NOT THE SAME BYTES (arch-review 67 P1-provenance) ─────────────────────────
      //
      // The first version read 412 as idempotent success outright: "the key is occupied" was accepted as
      // "the same object is already there". For an address that does not encode the verdict's own content —
      // and the verifier verdict's cannot, because a recovery has no digest to address it by — those are
      // different statements, and the difference is a restart reading a verdict the normal path never used.
      //
      // So the conflict is VERIFIED: read what is there and compare. Same digest is convergence; different
      // digest is a genuine conflict and throws, because two verdicts under one coordinate is not something
      // an adapter may silently pick a winner for.
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (opts?.immutable !== true || status !== 412) throw err;
      const existing = await this.get(key);
      // Unreadable is NOT convergence (rule `protocol` L2) — we could not find out, so we do not claim it.
      if (existing === undefined)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { key },
          "this immutable key is occupied and its contents could not be read back, so the write cannot be called convergent",
        );
      // Compared as BYTES, not as digests: an adapter's notion of "the same object" is the same octets, and
      // this layer cannot reach the domain's digest function anyway (storage depends on contracts and
      // application-control only). `opts.digest` stays as the caller's own statement of what it wrote.
      if (existing.length !== data.length || !existing.every((b, i) => b === data[i]))
        throw new ConflictError(
          "CONFLICT",
          { key, existingBytes: existing.length, incomingBytes: data.length, digest: opts.digest ?? null },
          "this immutable key already holds different bytes — two documents under one coordinate is not something this adapter may pick a winner for",
        );
    }
    return await this.signedUrl(this.client, key);
  }

  // A fresh browser-facing url for one of our refs — re-signed now (so it hasn't expired) against the public base
  // when the deployment declared one. The key is the ref's bucket-relative path; a ref from another bucket or host
  // isn't ours to re-sign.
  async publicUrlFor(ref: string): Promise<string | undefined> {
    const key = this.keyOf(ref);
    return key === undefined ? undefined : await this.signedUrl(this.presigner, key);
  }

  // `artifact://<key>` (the stable stored handle) or `<origin we sign for>/<bucket>/<key>?<signature>` (a
  // legacy row's presigned URL) → `<key>` (path-style, which is what we always sign).
  //
  // ── THE PATH STARTS WITH OUR BUCKET IS NOT WE MINTED THIS URL ───────────────────────────────────
  //
  // This used to compare no host at all, so that a ref minted against the server-internal endpoint would
  // still resolve after a `publicBaseUrl` was configured. That case is real and is still served — by naming
  // the origins rather than by accepting every one.
  //
  // `screenshotRef` is not always ours to begin with: `EnvSnapshot` legitimately carries a producer's own
  // http(s) artifact URL (the push-ingest channel — the judge resolver fetches those BARE, with no
  // credentials, precisely because they are attacker-influenced). So a producer that knows the deployment's
  // bucket name could submit `https://attacker.invalid/<bucket>/<someone-elses-key>`, and the run-detail
  // read would hand it here and return a URL signed WITH OUR CREDENTIALS for an object it has no
  // relationship with. The bare fetch was designed for hostile input; the signer never was.
  //
  // A ref naming an origin we no longer sign for (the endpoint moved) resolves to nothing and the caller
  // keeps the stored URL — a stale display, which is the direction to fail in.
  private keyOf(ref: string): string | undefined {
    const stable = artifactKeyOf(ref);
    if (stable !== undefined) return stable;
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return undefined; // not a url (dev's memory:// ref, a path inside the compute) — nothing to re-sign
    }
    if (!this.signedOrigins.has(url.origin)) return undefined;
    const path = decodeURIComponent(url.pathname);
    const prefix = `/${this.opts.bucket}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) || undefined : undefined;
  }

  // Read the bytes back by key — the server-side path that must keep working after the put's presigned URL expired.
  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return await res.Body?.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) return undefined; // absent object — the caller's 404, not our error
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { key },
        `object storage read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── AN INTERMEDIATE ARTIFACT HAS A RETENTION OWNER (arch-review 62 follow-through) ────────────────
  //
  // Deliberately NOT on the `ArtifactStore` port: almost everything this store holds is EVIDENCE — a sealed
  // trajectory, an offloaded snapshot, a published payload — and evidence is kept, so a delete on the shared
  // port would be a capability forty callers have and nobody should use. The staged agent half is the
  // exception (it exists only between a case's two halves), so the capability lives on the concrete store and
  // the narrow `AgentHalfStore` port is the only thing that asks for it.
  //
  // An absent object is not a failure — the half may have been reclaimed by the path that raced this one, or
  // retention may be re-running over a sweep that already finished. It is deliberately NOT reported as a
  // distinct answer: S3 DELETE is idempotent and does not say whether anything was there, so a
  // `deleted | absent` union would have one arm the adapter can almost never reach, and no caller reads it.
  // What matters to every caller is that a FAILURE throws (arch-review 120).
  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return;
    } catch (err) {
      if (isNotFound(err)) return;
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { key },
        `object storage delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// NoSuchKey / NoSuchBucket / 404 = the object isn't there; anything else is the store failing.
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" || e.name === "NotFound" || e.name === "NoSuchBucket" || e.$metadata?.httpStatusCode === 404
  );
}
