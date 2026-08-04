import type { TrajectoryBodyFormat } from "@everdict/application-control";
import { type TraceEvent, TraceEventSchema, type TraceSpan, TraceSpanSchema } from "@everdict/contracts";
import { spansToEvents } from "@everdict/domain";
import { z } from "zod";

// How a stored trajectory body is read back, shared by BOTH store adapters so "what a judge reads" cannot
// differ between Postgres and ClickHouse. Rung 2 is meant to be a swap, not a second interpretation.
//
// See docs/architecture/otel-trace-model.md.

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
export function bodyOf(format: TrajectoryBodyFormat, body: unknown): { events: TraceEvent[]; spans?: TraceSpan[] } {
  if (format !== "spans") return { events: EventsSchema.parse(body) };
  const spans = SpansSchema.parse(body);
  return { events: spansToEvents(spans), spans };
}
