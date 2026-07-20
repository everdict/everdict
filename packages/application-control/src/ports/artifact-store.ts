import type { EnvSnapshot } from "@everdict/contracts";

// Abstraction for storing artifacts (binaries such as screenshots). put returns a fetchable ref (URL) — a presigned GET URL or a permanent URL.
// Implementations: S3ArtifactStore (MinIO/S3, presigned), InMemoryArtifactStore (dev/test) — both in @everdict/storage.
// The control plane offloads before persisting the result. Moved here in re-architecture P2 (S2): the port +
// the offload use-case belong to the application layer (I/O through the port, not a pure rule).
export interface ArtifactStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>;
}

// Offload the embedded base64 screenshot of an os-use OR browser snapshot to object storage → replace screenshotRef=URL
// and clear screenshot (slims the result record). Both kinds carry an inline base64 screenshot for VLM judging
// (os-use = OSWorld-style desktop, browser = WebVoyager-style page); offloading keeps the persisted record small.
// If there's no store or no base64, leave it as-is (fallback: inline base64 — the dev/InMemory store path).
export async function offloadSnapshot(
  snapshot: EnvSnapshot,
  store: ArtifactStore | undefined,
  key: string,
): Promise<EnvSnapshot> {
  if (!store || (snapshot.kind !== "os-use" && snapshot.kind !== "browser") || !snapshot.screenshot) return snapshot;
  const bytes = Buffer.from(snapshot.screenshot, "base64");
  const ref = await store.put(key, bytes, "image/png");
  return { ...snapshot, screenshotRef: ref, screenshot: "" }; // remove base64 → only the URL in the record
}
