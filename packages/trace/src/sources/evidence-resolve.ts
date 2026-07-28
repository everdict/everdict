import type { SpanAttrMapping, TraceEvidence } from "@everdict/contracts";
import { type Span, spansToEvidence } from "./trace-source.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // judge-evidence screenshots are page captures — cap runaway downloads
const MAX_TEXT_BYTES = 1024 * 1024; // text artifacts feed a prompt that slices at ~6k chars — 1 MB is already generous

const isHttpUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test(v.trim());

// Credentials only travel to the source's own origin — an attacker-controlled URL inside a trace must never
// receive the tenant's observability credential (SSRF/credential-leak guard). Cross-origin fetches go bare.
function headersFor(
  url: string,
  headers: Record<string, string> | undefined,
  endpoint: string | undefined,
): Record<string, string> | undefined {
  if (!headers || !endpoint) return undefined;
  try {
    return new URL(url).origin === new URL(endpoint).origin ? headers : undefined;
  } catch {
    return undefined;
  }
}

// Resolve an http(s) screenshot ref to base64 bytes. Best-effort enhancement: any failure (non-URL ref, non-2xx,
// empty/oversized body) returns undefined and the caller keeps the unresolved ref — a missing screenshot must
// never fail a trace pull. Never throws.
export async function fetchImageBase64(
  f: typeof fetch,
  url: string,
  headers?: Record<string, string>,
): Promise<{ base64: string; mediaType: string } | undefined> {
  if (!isHttpUrl(url)) return undefined;
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

// Resolve an http(s) ref to its TEXT body (a JSON/HTML/text artifact the judge should read instead of the URL).
// Same best-effort discipline as the image fetch: any failure returns undefined and the caller keeps the URL string.
export async function fetchTextArtifact(
  f: typeof fetch,
  url: string,
  headers?: Record<string, string>,
): Promise<string | undefined> {
  if (!isHttpUrl(url)) return undefined;
  try {
    const res = await f(url, { ...(headers ? { headers } : {}) });
    if (!res.ok) return undefined;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_TEXT_BYTES) return undefined;
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (contentType.startsWith("image/")) return undefined; // an image is not prompt text
    return Buffer.from(buf).toString("utf8");
  } catch {
    return undefined;
  }
}

// Resolve a ROOT-RELATIVE artifact ref ("/artifacts/run-1/shot.png") against the source's artifactBaseUrl.
// Absolute http(s) refs pass through untouched; with no base (or a non-path value) the original stays — the
// pre-existing "keep the raw string" behavior. Without this, a harness that references its artifacts
// root-relatively left the judge holding path STRINGS instead of the resolved bytes/text.
export function resolveArtifactRef(value: string, artifactBaseUrl: string | undefined): string {
  if (isHttpUrl(value)) return value;
  if (!artifactBaseUrl || !value.startsWith("/")) return value;
  try {
    return new URL(value, artifactBaseUrl).toString();
  } catch {
    return value;
  }
}

// spansToEvidence (pure) + I/O resolution — the one evidence entrypoint the span-based sources (otel/mlflow)
// call from fetchDetailed/inspect: ① a screenshot ref resolves to image bytes (ref kept as provenance);
// ② a dom/custom-slot value that IS an http(s) URL (or a root-relative ref + artifactBaseUrl) auto-resolves to
// the artifact's real text (the original string kept on miss). finalAnswer is never auto-fetched — the answer is
// the answer, not a pointer. Credentials: same-origin only.
export async function extractEvidence(
  spans: Span[],
  mapping: SpanAttrMapping | undefined,
  f: typeof fetch,
  headers?: Record<string, string>,
  endpoint?: string,
  artifactBaseUrl?: string,
): Promise<TraceEvidence | undefined> {
  const evidence = spansToEvidence(spans, mapping);
  if (!evidence) return undefined;
  const out: TraceEvidence = { ...evidence };

  if (out.screenshotRef && !out.screenshot) {
    const url = resolveArtifactRef(out.screenshotRef, artifactBaseUrl); // the UNRESOLVED ref stays as provenance
    const img = await fetchImageBase64(f, url, headersFor(url, headers, endpoint));
    if (img) {
      out.screenshot = img.base64;
      out.screenshotMediaType = img.mediaType;
    }
  }

  if (out.dom !== undefined) {
    const url = resolveArtifactRef(out.dom, artifactBaseUrl);
    if (isHttpUrl(url)) {
      const text = await fetchTextArtifact(f, url, headersFor(url, headers, endpoint));
      if (text !== undefined) out.dom = text;
    }
  }

  if (out.custom) {
    const custom: Record<string, string> = {};
    for (const [name, value] of Object.entries(out.custom)) {
      const url = resolveArtifactRef(value, artifactBaseUrl);
      if (isHttpUrl(url)) {
        const text = await fetchTextArtifact(f, url, headersFor(url, headers, endpoint));
        custom[name] = text ?? value;
      } else {
        custom[name] = value;
      }
    }
    out.custom = custom;
  }

  return out;
}
