import type { EnvSnapshot } from "@everdict/contracts";

// Abstraction for storing artifacts (binaries such as screenshots). put returns a fetchable ref (URL) — a presigned GET URL or a permanent URL.
// Implementations: S3ArtifactStore (MinIO/S3, presigned), InMemoryArtifactStore (dev/test) — both in @everdict/storage.
// The control plane offloads before persisting the result. Moved here in re-architecture P2 (S2): the port +
// the offload use-case belong to the application layer (I/O through the port, not a pure rule).
export interface ArtifactStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>;
}

// Offload a run's produced snapshot MEDIA to object storage so the persisted result stays small (the store's `put`
// returns a fetchable ref). Two artifacts, both keyed off `keyBase` (no extension — the function appends one):
//   1. the embedded base64 SCREENSHOT of an os-use/browser snapshot (WebVoyager/OSWorld VLM-judge input) → screenshotRef,
//      inline bytes cleared;
//   2. the full page DOM of a browser snapshot when it exceeds DOM_INLINE_MAX → domRef, with `dom` kept as an inline
//      preview. The offload runs AFTER judging, so the judge always saw the full dom; the preview (>= the judge prompt's
//      own truncation) only affects a later re-score's inline view — the full DOM is fetchable via domRef.
// No store, or nothing to offload → returned as-is (dev/InMemory path keeps everything inline).
export const DOM_INLINE_MAX = 8192; // keep up to this much DOM inline (covers the judge prompt truncation); offload the rest

export async function offloadSnapshot(
  snapshot: EnvSnapshot,
  store: ArtifactStore | undefined,
  keyBase: string,
): Promise<EnvSnapshot> {
  if (!store) return snapshot;
  let out = snapshot;
  // Screenshot (os-use + browser): base64 → object store, replace with a ref, drop the inline bytes.
  if ((out.kind === "os-use" || out.kind === "browser") && out.screenshot) {
    const ref = await store.put(`${keyBase}.png`, Buffer.from(out.screenshot, "base64"), "image/png");
    out = { ...out, screenshotRef: ref, screenshot: "" };
  }
  // DOM (browser): the full page HTML can be large (100KB–1MB), bloating the persisted jsonb result. Offload it and
  // keep only an inline preview; the full DOM stays fetchable via domRef.
  if (out.kind === "browser" && out.dom.length > DOM_INLINE_MAX) {
    const ref = await store.put(`${keyBase}.dom.html`, Buffer.from(out.dom, "utf8"), "text/html; charset=utf-8");
    out = { ...out, domRef: ref, dom: out.dom.slice(0, DOM_INLINE_MAX) };
  }
  return out;
}
