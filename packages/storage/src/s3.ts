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
  endpoint: string; // S3 API 엔드포인트(예: http://localhost:9100 = MinIO)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // 기본 us-east-1
  presignTtlSec?: number; // GET presigned URL 만료(기본 3600)
  // presigned URL 의 호스트를 브라우저가 도달하는 주소로 치환(서버 내부 endpoint ≠ 브라우저 접근 주소일 때).
  publicBaseUrl?: string;
}

// S3 호환 object storage(MinIO 포함) 아티팩트 스토어. put → PutObject 후 presigned GET URL 반환(레코드엔 URL 만 남는다).
// MinIO 는 path-style(forcePathStyle) 필요. 자격증명/엔드포인트는 컨트롤플레인이 env/시크릿으로 주입(스펙에 평문 금지).
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

  // 버킷 보장(없으면 생성). 기동 시 1회 호출 권장 — put 마다 호출하지 않는다.
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
    // 서버 내부 endpoint → 브라우저 접근 주소로 치환(예: http://minio:9000 → https://artifacts.example.com).
    return this.opts.publicBaseUrl ? url.replace(this.opts.endpoint.replace(/\/$/, ""), this.opts.publicBaseUrl) : url;
  }
}
