import type { SpanAttrMapping, TraceEvidence } from "@everdict/contracts";
import { type Span, spansToEvidence } from "./trace-source.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // judge-evidence screenshots are page captures — cap runaway downloads

// Resolve an http(s) screenshot ref to base64 bytes with the source's own credentials. Best-effort enhancement:
// any failure (non-URL ref, non-2xx, empty/oversized body) returns undefined and the caller keeps the unresolved
// ref — a missing screenshot must never fail a trace pull. Never throws.
export async function fetchImageBase64(
  f: typeof fetch,
  url: string,
  headers?: Record<string, string>,
): Promise<{ base64: string; mediaType: string } | undefined> {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const res = await f(url, { ...(headers ? { headers } : {}) });
    if (!res.ok) return undefined;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return undefined;
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
    const mediaType = contentType?.startsWith("image/")
      ? contentType
      : /\.jpe?g(\?|$)/i.test(url)
        ? "image/jpeg"
        : "image/png";
    return { base64: Buffer.from(buf).toString("base64"), mediaType };
  } catch {
    return undefined;
  }
}

// spansToEvidence (pure) + screenshot-ref byte resolution (I/O) — the one evidence entrypoint the span-based
// sources (otel/mlflow) call from fetchDetailed/inspect. The ref is kept alongside resolved bytes (provenance).
export async function extractEvidence(
  spans: Span[],
  mapping: SpanAttrMapping | undefined,
  f: typeof fetch,
  headers?: Record<string, string>,
): Promise<TraceEvidence | undefined> {
  const evidence = spansToEvidence(spans, mapping);
  if (!evidence?.screenshotRef || evidence.screenshot) return evidence;
  const img = await fetchImageBase64(f, evidence.screenshotRef, headers);
  return img ? { ...evidence, screenshot: img.base64, screenshotMediaType: img.mediaType } : evidence;
}
