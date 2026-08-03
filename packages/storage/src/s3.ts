import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactStore } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";

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
  constructor(private readonly opts: S3ArtifactStoreOptions) {
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
  async put(key: string, data: Uint8Array, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: contentType }),
    );
    return await this.signedUrl(this.client, key);
  }

  // A fresh browser-facing url for one of our refs — re-signed now (so it hasn't expired) against the public base
  // when the deployment declared one. The key is the ref's bucket-relative path; a ref from another bucket or host
  // isn't ours to re-sign.
  async publicUrlFor(ref: string): Promise<string | undefined> {
    const key = this.keyOf(ref);
    return key === undefined ? undefined : await this.signedUrl(this.presigner, key);
  }

  // `<endpoint>/<bucket>/<key>?<signature>` → `<key>` (path-style, which is what we always sign). The endpoint's host
  // is deliberately NOT compared: an old ref minted before the public base was configured names a different host and
  // still points at this bucket.
  private keyOf(ref: string): string | undefined {
    let path: string;
    try {
      path = decodeURIComponent(new URL(ref).pathname);
    } catch {
      return undefined; // not a url (dev's memory:// ref, a relative path) — nothing to re-sign
    }
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
}

// NoSuchKey / NoSuchBucket / 404 = the object isn't there; anything else is the store failing.
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" || e.name === "NotFound" || e.name === "NoSuchBucket" || e.$metadata?.httpStatusCode === 404
  );
}
