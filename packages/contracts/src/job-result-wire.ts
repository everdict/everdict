import { UpstreamError } from "./errors.js";
import { type CaseResult, CaseResultSchema } from "./execution/eval-case.js";
import { type TraceEvent, TraceEventSchema } from "./execution/trace.js";

// The one-line stdout wire format for a CaseResult crossing the agent → backend process boundary. The agent
// (main.ts) prints encodeResult(result) on its own line; a backend that launched the agent decodes it from the job
// logs with parseResult. Encode and decode live together here so the format only ever changes in one place.
export const RESULT_SENTINEL = "__EVERDICT_RESULT__";

// The streaming sibling of RESULT_SENTINEL: one TraceEvent per sentinel-prefixed stdout line, printed WHILE the
// case runs (live-observability ⑨ — the managed job's only channel back to the control plane is its own stdout).
// The sealed CaseResult.trace remains the durable record; these lines are a live preview and are stripped from
// every human-facing log read the way the result line is.
export const EVENT_SENTINEL = "__EVERDICT_EVENT__";

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

// The live-log view with the machine payloads removed — Observable.logs() returns human-readable progress text
// without the result line or any live-event lines. No sentinel present → unchanged (fast path).
export function stripSentinel(stdout: string): string {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  const text = idx < 0 ? stdout : stdout.slice(0, idx);
  if (!text.includes(EVENT_SENTINEL)) return text;
  return text
    .split("\n")
    .filter((line) => !line.includes(EVENT_SENTINEL))
    .join("\n");
}

// Live-event lines are a preview, not the record — cap the byte-heavy fields so a chatty harness can't bloat the
// job log (the sealed trace keeps the full text). Encoded lines that stay oversized even after the trim are
// dropped rather than emitted broken.
const LIVE_TEXT_CAP = 4000;
const LIVE_LINE_CAP = 32_000;

function trimmedForLive(event: TraceEvent): TraceEvent {
  const cut = (s: string): string => (s.length > LIVE_TEXT_CAP ? `${s.slice(0, LIVE_TEXT_CAP)}… [truncated]` : s);
  switch (event.kind) {
    case "message":
    case "log":
      return { ...event, text: cut(event.text) };
    case "tool_result":
      return { ...event, output: cut(event.output) };
    case "tool_call":
      return { ...event, args: "[truncated]" };
    case "env_action":
      return { ...event, detail: undefined };
    case "span":
      return { ...event, attributes: undefined };
    default:
      return event;
  }
}

// Encode one TraceEvent as a sentinel-prefixed stdout line (the managed job's live tee). undefined = the event
// stays oversized even trimmed — dropped from the live preview (the sealed trace still carries it in full).
export function encodeLiveEvent(event: TraceEvent): string | undefined {
  const line = EVENT_SENTINEL + JSON.stringify(event);
  if (line.length <= LIVE_LINE_CAP) return line;
  const trimmed = EVENT_SENTINEL + JSON.stringify(trimmedForLive(event));
  return trimmed.length <= LIVE_LINE_CAP ? trimmed : undefined;
}

// Decode every live-event line from a job's stdout snapshot (interleaved with teed harness output). Unparseable
// or schema-invalid lines are dropped — a torn tail line must never break the live read.
export function extractLiveEvents(stdout: string): TraceEvent[] {
  if (!stdout.includes(EVENT_SENTINEL)) return [];
  const events: TraceEvent[] = [];
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf(EVENT_SENTINEL);
    if (idx < 0) continue;
    try {
      const parsed = TraceEventSchema.safeParse(JSON.parse(line.slice(idx + EVENT_SENTINEL.length)));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // torn/partial line (snapshot raced the writer) — skip it; the next poll reads it whole
    }
  }
  return events;
}
