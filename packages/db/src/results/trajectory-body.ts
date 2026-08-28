import type { TrajectoryBodyFormat } from "@everdict/application-control";
import { type TraceEvent, TraceEventSchema, type TraceSpan, TraceSpanSchema } from "@everdict/contracts";
import { type SpanBatchFacts, spansToEvents } from "@everdict/domain";
import { z } from "zod";

// How a stored trajectory body is read back, shared by BOTH store adapters so "what a judge reads" cannot
// differ between Postgres and ClickHouse. Rung 2 is meant to be a swap, not a second interpretation.
//
// See docs/architecture/otel-trace-model.md and docs/architecture/long-horizon-trace-reads.md.

const EventsSchema = z.array(TraceEventSchema);
const SpansSchema = z.array(TraceSpanSchema);

// A row written before N6 carries no format and holds events. NEVER sniffed from the bytes: the column is
// the record's own statement about itself, and a sniffer silently mis-reads the first ambiguous body it meets.
export function formatOf(value: string | null | undefined): TrajectoryBodyFormat {
  return value === "spans" ? "spans" : "events";
}

// The segment's two faces: the record (`spans`, when that is what was sealed) and the projection every judge
// reads. A spans row projects on READ rather than storing both — one copy of the truth, and the projection is
// versioned so an old verdict stays re-derivable.
//
// ⚠️ WHOLE-PLANE ONLY. This is the LEGACY (unsplit) path and the split path's per-page twin is `pageBodyOf`,
// which needs the plane's batch facts. Handing a slice to this function projects that slice against itself —
// the defect `SpanBatchFacts` exists to prevent.
export function bodyOf(format: TrajectoryBodyFormat, body: unknown): { events: TraceEvent[]; spans?: TraceSpan[] } {
  if (format !== "spans") return { events: EventsSchema.parse(body) };
  const spans = SpansSchema.parse(body);
  return { events: spansToEvents(spans), spans };
}

// ── ONE PAGE OF A SPLIT PLANE ────────────────────────────────────────────────────────────────────────
//
// The same decode, item by item, so a page is validated at the boundary exactly as a whole body was — and
// the validation copy is now a PAGE's rather than a trajectory's, which is most of what the split buys.
//
// `batch` is the plane's own provenance (`TrajectorySegment.batch`, derived at seal). A spans page projected
// WITHOUT it is measured against the page: the relative `t` axis restarts at every page boundary and a page
// holding an aggregate span double-counts its tokens. Absent is therefore not "use the defaults" — it is a
// plane the store recorded no facts for, which only happens for evidence sealed before mig 0200, and such a
// plane is never split, so this function is never reached for one. The parameter is required to keep that
// reasoning at the call site rather than in a comment.
export function pageBodyOf(
  format: TrajectoryBodyFormat,
  bodies: unknown[],
  batch: SpanBatchFacts | undefined,
): { events: TraceEvent[]; spans?: TraceSpan[] } {
  if (format !== "spans") return { events: EventsSchema.parse(bodies) };
  const spans = SpansSchema.parse(bodies);
  return { events: spansToEvents(spans, batch !== undefined ? { batch } : {}), spans };
}
