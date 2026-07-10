import { S3ArtifactStore } from "@everdict/storage";

// Per-workspace metering policy: if EVERDICT_METER_TENANTS (comma list) is set, only those tenants; otherwise EVERDICT_METER_USAGE=1
// is the all-tenant default. A per-request override (POST /runs body.meterUsage) always wins.
export function meterUsagePolicyFromEnv(): (tenant: string) => boolean {
  const list = process.env.EVERDICT_METER_TENANTS;
  if (list) {
    const allow = new Set(
      list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return (tenant) => allow.has(tenant);
  }
  const all = process.env.EVERDICT_METER_USAGE === "1";
  return () => all;
}

// Artifact (screenshot) object storage: if all 4 env vars (endpoint/bucket/access/secret) are present, configure the S3/MinIO store + ensure the bucket.
// Unset → undefined → os-use screenshots fall back to base64 inline (dev). Secrets are env (secrets) — never in the spec/committed.
export async function artifactStoreFromEnv(): Promise<S3ArtifactStore | undefined> {
  const endpoint = process.env.EVERDICT_S3_ENDPOINT;
  const bucket = process.env.EVERDICT_S3_BUCKET;
  const accessKeyId = process.env.EVERDICT_S3_ACCESS_KEY;
  const secretAccessKey = process.env.EVERDICT_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const store = new S3ArtifactStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(process.env.EVERDICT_S3_REGION ? { region: process.env.EVERDICT_S3_REGION } : {}),
    ...(process.env.EVERDICT_S3_PUBLIC_URL ? { publicBaseUrl: process.env.EVERDICT_S3_PUBLIC_URL } : {}),
  });
  await store.ensureBucket().catch(() => {});
  return store;
}
