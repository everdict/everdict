import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactStore } from "./artifact-store.js";

export interface S3ArtifactStoreOptions {
  endpoint: string; // S3 API endpoint (e.g. http://localhost:9100 = MinIO)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // default us-east-1
  presignTtlSec?: number; // GET presigned URL expiry (default 3600)
  // Replace the presigned URL's host with the address the browser can reach (when the server-internal endpoint ≠ the browser-access address).
  publicBaseUrl?: string;
}

// Artifact store for S3-compatible object storage (incl. MinIO). put → PutObject then returns a presigned GET URL (only the URL stays in the record).
// MinIO requires path-style (forcePathStyle). Credentials/endpoint are injected by the control plane via env/secrets (no plaintext in the spec).
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  constructor(private readonly opts: S3ArtifactStoreOptions) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
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

  async put(key: string, data: Uint8Array, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: contentType }),
    );
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), {
      expiresIn: this.opts.presignTtlSec ?? 3600,
    });
    // Replace the server-internal endpoint with the browser-access address (e.g. http://minio:9000 → https://artifacts.example.com).
    return this.opts.publicBaseUrl ? url.replace(this.opts.endpoint.replace(/\/$/, ""), this.opts.publicBaseUrl) : url;
  }
}
