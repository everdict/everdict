import { type CaseResult, CaseResultSchema, UpstreamError } from "@everdict/core";

// The one-line stdout wire format for a CaseResult crossing the agent → backend process boundary. The agent
// (main.ts) prints encodeResult(result) on its own line; a backend that launched the agent decodes it from the job
// logs with parseResult. Encode and decode live together here so the format only ever changes in one place.
export const RESULT_SENTINEL = "__EVERDICT_RESULT__";

// Encode a CaseResult as the single sentinel-prefixed line the agent writes to stdout.
export function encodeResult(result: CaseResult): string {
  return RESULT_SENTINEL + JSON.stringify(result);
}

// Decode the CaseResult from a job's stdout. The real result is emitted AFTER any teed harness output, so take the
// LAST sentinel and the line that follows it. Throws UpstreamError when no sentinel is present (the agent crashed
// before emitting one) — the backend maps that to a dispatch failure rather than a silent misparse.
export function parseResult(stdout: string): CaseResult {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) throw new UpstreamError("UPSTREAM_ERROR", undefined, "could not find the agent result (sentinel).");
  const line = stdout.slice(idx + RESULT_SENTINEL.length).split("\n")[0] ?? "";
  return CaseResultSchema.parse(JSON.parse(line));
}

// The live-log view with the machine result line removed — Observable.logs() returns human-readable progress text
// without the sentinel line. No sentinel present → unchanged.
export function stripSentinel(stdout: string): string {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  return idx < 0 ? stdout : stdout.slice(0, idx);
}
