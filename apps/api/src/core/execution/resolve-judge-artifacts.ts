import type { EnvSnapshot, GradeContext, TraceEvidence } from "@everdict/contracts";
import { fetchImageBase64, fetchTextArtifact } from "@everdict/trace";

// Resolve artifact URLs to real DATA before ANY judge sees the context — the control-plane counterpart of the
// trace-pull path's extractEvidence (which only ran for pulled traces). A judge can reach a context carrying refs
// instead of bytes/text: after offloadSnapshot moves a screenshot to object storage (screenshotRef → presigned URL,
// bytes cleared), on a retry/re-score of a stored result, or on a push-ingested trace whose image/artifact is an
// http(s) URL. The model transport only sends image BYTES (never a URL), and a {name} evidence slot that is a URL
// would put the URL — not the artifact — into the judge prompt. Resolve them here so the judge grades real content.
//
// Channels (all best-effort, reusing @everdict/trace's http(s)-only, size-capped, never-throwing fetchers):
//   • snapshot.screenshotRef (browser/os-use) → embedded base64        [IMAGE — only when a VLM judge needs it]
//   • evidence.screenshotRef                   → embedded base64        [IMAGE — same gate]
//   • snapshot.dom (browser) that IS a URL     → the page's real text   [TEXT — always]
//   • evidence.dom that IS a URL               → the artifact's text    [TEXT — always]
//   • evidence.custom slots that ARE URLs      → the artifact's text    [TEXT — always]
// finalAnswer is never auto-fetched — the answer is the answer, not a pointer (matches extractEvidence).
// Fetches bare (no credentials): an attacker-controlled URL inside a trace must never receive one (SSRF/leak guard);
// an offloaded presigned URL self-authenticates via its query string.

const isHttpUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test(v.trim());

async function resolveSnapshot(snap: EnvSnapshot, fetchImpl: typeof fetch, image: boolean): Promise<EnvSnapshot> {
  let out = snap;
  if (out.kind === "browser" && isHttpUrl(out.dom)) {
    const text = await fetchTextArtifact(fetchImpl, out.dom);
    if (text !== undefined) out = { ...out, dom: text };
  }
  if (image && (out.kind === "browser" || out.kind === "os-use") && !out.screenshot && out.screenshotRef) {
    const img = await fetchImageBase64(fetchImpl, out.screenshotRef);
    if (img) out = { ...out, screenshot: img.base64 };
  }
  return out;
}

async function resolveEvidence(ev: TraceEvidence, fetchImpl: typeof fetch, image: boolean): Promise<TraceEvidence> {
  let out = ev;
  if (image && out.screenshotRef && !out.screenshot) {
    const img = await fetchImageBase64(fetchImpl, out.screenshotRef);
    if (img) out = { ...out, screenshot: img.base64, screenshotMediaType: img.mediaType };
  }
  if (out.dom !== undefined && isHttpUrl(out.dom)) {
    const text = await fetchTextArtifact(fetchImpl, out.dom);
    if (text !== undefined) out = { ...out, dom: text };
  }
  if (out.custom) {
    let changed = false;
    const custom: Record<string, string> = {};
    for (const [name, value] of Object.entries(out.custom)) {
      if (isHttpUrl(value)) {
        const text = await fetchTextArtifact(fetchImpl, value);
        custom[name] = text ?? value;
        if (text !== undefined) changed = true;
      } else {
        custom[name] = value;
      }
    }
    if (changed) out = { ...out, custom };
  }
  return out;
}

// Resolve every judge artifact channel in the context. `image` gates the (potentially large) screenshot fetch — a
// text-only judge (a code judge, or a model judge without a "screenshot" input) skips it. Returns the SAME ctx
// reference when nothing resolved (a common no-op — most contexts carry no URL refs).
export async function resolveJudgeArtifacts(
  ctx: GradeContext,
  fetchImpl: typeof fetch,
  opts: { image?: boolean } = {},
): Promise<GradeContext> {
  const image = opts.image ?? false;
  const snapshot = await resolveSnapshot(ctx.snapshot, fetchImpl, image);
  const evidence = ctx.evidence ? await resolveEvidence(ctx.evidence, fetchImpl, image) : ctx.evidence;
  if (snapshot === ctx.snapshot && evidence === ctx.evidence) return ctx;
  return { ...ctx, snapshot, ...(evidence ? { evidence } : {}) };
}
