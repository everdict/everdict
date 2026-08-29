import { ARTIFACT_REF_SCHEME } from "@everdict/contracts";
import type { EnvSnapshot } from "@everdict/contracts";

// Abstraction for storing artifacts (binaries such as screenshots). put returns a fetchable ref (URL) — a presigned GET URL or a permanent URL.
// Implementations: S3ArtifactStore (MinIO/S3, presigned), InMemoryArtifactStore (dev/test) — both in @everdict/storage.
// The control plane offloads before persisting the result. Moved here in re-architecture P2 (S2): the port +
// the offload use-case belong to the application layer (I/O through the port, not a pure rule).
// ── THE STORED REF IS THE KEY, NEVER THE SIGNATURE (review 40 follow-up) ─────────────────────────────
//
// `put` returns a presigned URL, and persisting THAT was two defects in one string: the signature expires
// (a year-old result points at a dead link until a display read happens to re-mint it), and the bytes'
// identity changed with the signing clock — the same artifact digested differently every time it was
// offloaded, which is noise a receipt's resultDigest exists to make impossible. What a record stores is the
// stable `artifact://<key>` handle; every browser-facing URL is minted AT READ (`publicUrlFor`), and legacy
// rows holding old presigned URLs keep re-minting exactly as before.
// Re-exported, not re-declared: the scheme itself lives at the dependency root now, because `contracts`
// refuses a producer-authored one (arch-review 121). Consumers keep importing it from here.
export { ARTIFACT_REF_SCHEME };
export function artifactRefOf(key: string): string {
  return `${ARTIFACT_REF_SCHEME}${key}`;
}
export function artifactKeyOf(ref: string): string | undefined {
  if (!ref.startsWith(ARTIFACT_REF_SCHEME)) return undefined;
  const key = ref.slice(ARTIFACT_REF_SCHEME.length);
  return key.length > 0 ? key : undefined;
}

export interface ArtifactStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>;
  // Read an artifact back by KEY. The ref `put` returns is not a durable handle — it is presigned (it expires) and it
  // carries the SERVER-internal endpoint, so nothing may re-read an artifact by replaying that stored URL: server-side
  // reads go through the key, and anything the browser must reach is served by us. Missing object → undefined
  // (the caller decides whether that is a 404); a store failure throws (an outage is not an absence).
  get(key: string): Promise<Uint8Array | undefined>;
  // Mint a FRESH browser-facing url for a ref this store minted earlier. Two things are wrong with a stored ref by
  // the time someone looks at it: it was signed for the SERVER-internal endpoint (no browser outside the cluster
  // resolves `http://minio:9000`), and it has expired. So a display read re-mints — against the store's public base
  // when the deployment declared one. Not this store's ref (a foreign bucket/deployment) → undefined, and the caller
  // keeps what it had rather than inventing a link.
  publicUrlFor(ref: string): Promise<string | undefined>;
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
  // Screenshot (os-use + browser): base64 → object store; the record keeps the STABLE key handle, never the
  // put's presigned URL (see ARTIFACT_REF_SCHEME above) — display reads mint a fresh URL from it.
  if ((out.kind === "os-use" || out.kind === "browser") && out.screenshot) {
    await store.put(`${keyBase}.png`, Buffer.from(out.screenshot, "base64"), "image/png");
    out = { ...out, screenshotRef: artifactRefOf(`${keyBase}.png`), screenshot: "" };
  }
  // DOM (browser): the full page HTML can be large (100KB–1MB), bloating the persisted jsonb result. Offload it and
  // keep only an inline preview; the full DOM stays fetchable via domRef.
  if (out.kind === "browser" && out.dom.length > DOM_INLINE_MAX) {
    await store.put(`${keyBase}.dom.html`, Buffer.from(out.dom, "utf8"), "text/html; charset=utf-8");
    out = { ...out, domRef: artifactRefOf(`${keyBase}.dom.html`), dom: out.dom.slice(0, DOM_INLINE_MAX) };
  }
  return out;
}

// The display-side twin of offloadSnapshot: hand the browser links it can actually open. What the record holds is a
// SERVER handle (internal endpoint + long expired), so every read that ends up on a screen re-mints it — never the
// reads that feed our own code (a judge fetching evidence must keep using the in-cluster address). No store, nothing
// offloaded, or a ref this store doesn't recognize → unchanged.
export async function refreshSnapshotRefs(
  snapshot: EnvSnapshot,
  store: ArtifactStore | undefined,
): Promise<EnvSnapshot> {
  if (!store) return snapshot;
  let out = snapshot;
  if ((out.kind === "os-use" || out.kind === "browser") && out.screenshotRef) {
    const fresh = await store.publicUrlFor(out.screenshotRef);
    if (fresh) out = { ...out, screenshotRef: fresh };
  }
  if (out.kind === "browser" && out.domRef) {
    const fresh = await store.publicUrlFor(out.domRef);
    if (fresh) out = { ...out, domRef: fresh };
  }
  return out;
}
