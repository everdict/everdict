import type { EnvSnapshot } from "@everdict/core";

// Abstraction for storing artifacts (binaries such as screenshots). put returns a fetchable ref (URL) — a presigned GET URL or a permanent URL.
// Implementations: S3ArtifactStore (MinIO/S3, presigned), InMemoryArtifactStore (dev/test). The control plane offloads before persisting the result.
export interface ArtifactStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>;
}

// Offload the embedded base64 screenshot of an os-use snapshot to object storage → replace screenshotRef=URL and clear screenshot
// (slims the result record). If there's no store or no base64, leave it as-is (fallback: inline base64 — the dev/InMemory store path).
export async function offloadSnapshot(
  snapshot: EnvSnapshot,
  store: ArtifactStore | undefined,
  key: string,
): Promise<EnvSnapshot> {
  if (!store || snapshot.kind !== "os-use" || !snapshot.screenshot) return snapshot;
  const bytes = Buffer.from(snapshot.screenshot, "base64");
  const ref = await store.put(key, bytes, "image/png");
  return { ...snapshot, screenshotRef: ref, screenshot: "" }; // remove base64 → only the URL in the record
}

// In-process store for dev/test. Keeps bytes in a Map, ref is a memory:// URL. Not persisted/shared (same posture as the InMemory run-store).
export class InMemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();
  constructor(private readonly baseUrl = "memory://artifacts/") {}
  async put(key: string, data: Uint8Array, contentType: string): Promise<string> {
    this.objects.set(key, { data, contentType });
    return `${this.baseUrl}${key}`;
  }
}
