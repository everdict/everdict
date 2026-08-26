import type { VerifierDurabilityPolicy } from "@everdict/application-control";
import { InternalError } from "@everdict/contracts";
import { S3ArtifactStore, S3WorkspaceFs } from "@everdict/storage";

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

// The workspace filesystem's distributed backend: the SAME S3/MinIO endpoint + credentials as the artifact store,
// but its OWN buckets — one bucket PER TENANT (`<prefix>-<tenant>-<hash8>`, default prefix "everdict-fs",
// override via EVERDICT_S3_FS_BUCKET_PREFIX), created lazily on a tenant's first filesystem touch. The bucket is
// the isolation boundary (per-tenant credentials/quota/lifecycle attach at the storage layer). Unset → undefined
// → the caller falls back to InMemoryWorkspaceFs (dev: per-process, not persisted).
export async function workspaceFsFromEnv(): Promise<S3WorkspaceFs | undefined> {
  const endpoint = process.env.EVERDICT_S3_ENDPOINT;
  const accessKeyId = process.env.EVERDICT_S3_ACCESS_KEY;
  const secretAccessKey = process.env.EVERDICT_S3_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return undefined;
  return new S3WorkspaceFs({
    endpoint,
    accessKeyId,
    secretAccessKey,
    ...(process.env.EVERDICT_S3_REGION ? { region: process.env.EVERDICT_S3_REGION } : {}),
    ...(process.env.EVERDICT_S3_FS_BUCKET_PREFIX ? { bucketPrefix: process.env.EVERDICT_S3_FS_BUCKET_PREFIX } : {}),
  });
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

// ── WHAT AN UNWRITABLE INTERMEDIATE COSTS, CHOSEN BY THE DEPLOYMENT (arch-review 70 P0) ─────────────
//
// `VerifierDurabilityPolicy` shipped in arch-review 67 so a deployment could say what it loses when a
// two-phase case's artifacts cannot be written. No composition root ever passed it, so every deployment
// silently took `best_effort` and `required` existed only in tests — a policy type is not a policy the
// deployment chose, and the default that stood in for the decision was the permissive arm.
//
// Absent stays `best_effort` DELIBERATELY: making the strict arm the default would start failing cases that
// deployments have been measuring successfully, which is a behaviour change nobody asked for. What changes
// is that the choice is now readable, reported, and validated against what the deployment actually wired.
//
// An unrecognised value THROWS rather than falling back. A misspelled `EVERDICT_VERIFIER_DURABILITY=requird`
// silently meaning "best effort" is the shape this whole law is about (rule `typescript`: no fallback on a
// bad enum).
export function verifierDurabilityFromEnv(): VerifierDurabilityPolicy {
  const raw = process.env.EVERDICT_VERIFIER_DURABILITY;
  if (raw === undefined || raw === "") return "best_effort";
  if (raw === "required" || raw === "best_effort") return raw;
  throw new InternalError(
    "NOT_CONFIGURED",
    { value: raw },
    `EVERDICT_VERIFIER_DURABILITY must be "required" or "best_effort", not "${raw}".`,
  );
}

// A deployment cannot CLAIM crash-safe private-verifier evaluation without the three stores that make it
// true. Under `required` the claim is refused at boot rather than at the first case that needs it: the
// artifacts a recovery reads, the ledger that owns their removal, and the attempt rows a cancellation
// enumerates are each a precondition, and a missing one is a deployment error, not a runtime surprise.
export function assertVerifierDurabilitySatisfiable(
  policy: VerifierDurabilityPolicy,
  wired: { artifacts: boolean; cleanup: boolean; attempts: boolean },
): void {
  if (policy !== "required") return;
  const missing = [
    ...(wired.artifacts ? [] : ["an artifact store (EVERDICT_S3_*)"]),
    ...(wired.cleanup ? [] : ["an intermediate cleanup ledger (DATABASE_URL)"]),
    ...(wired.attempts ? [] : ["an execution attempt ledger (DATABASE_URL)"]),
  ];
  if (missing.length === 0) return;
  throw new InternalError(
    "NOT_CONFIGURED",
    { missing },
    `EVERDICT_VERIFIER_DURABILITY=required needs ${missing.join(", ")}. Wire them, or choose best_effort and accept that a crash between a case's two halves loses work already paid for.`,
  );
}
