import { z } from "zod";
import { stripPlatformAuthoredFields } from "./trace.js";

// The RECORD of what happened — OTel's upper layer, which this codebase spent five rungs without.
//
// A trace has two layers and we only ever modelled the lower one: a SPAN is an interval (it has a duration
// and a parent), a SPAN EVENT is a point inside a span. `TraceEvent` is, almost exactly, the span-event
// layer — which is why an interval was inexpressible in it and the placement plane could only ever be two
// instants ("leased" at 0, "finished" at 23262) for something that is one 23-second span with phases inside.
//
// This is deliberately OTLP-shaped, field for field, so a span we hold can be handed to an exporter as a
// valid trace rather than a projection of one. `TraceEvent[]` does not go away: it becomes the versioned
// read-time PROJECTION that graders and judges keep reading unchanged (`spansToEvents`, @everdict/domain).
//
// See docs/architecture/otel-trace-model.md.

// OTel SpanKind — the span's relationship to its peers, not its subject matter. `client` on a dispatch says
// "we called the orchestrator"; `internal` is the default and covers most agent work.
export const SpanKindSchema = z.enum(["internal", "server", "client", "producer", "consumer"]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

// OTel span status. `unset` is NOT "ok" — it means nobody claimed either, which is a different fact.
export const SpanStatusSchema = z.object({
  code: z.enum(["unset", "ok", "error"]),
  message: z.string().optional(),
});
export type SpanStatus = z.infer<typeof SpanStatusSchema>;

// A point in time INSIDE a span — an orchestrator's "Driver Failure", a compaction, a retry. The things that
// have no duration and therefore were never spans, but which used to be forced into the same flat list as
// the intervals because there was nowhere else to put them.
export const SpanEventSchema = z.object({
  name: z.string(),
  at: z.string(), // ISO-8601 absolute instant
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type SpanEvent = z.infer<typeof SpanEventSchema>;

// A pointer to a span in another trace (OTel links) — a batch fanning out to its cases, an agent spawning a
// subagent under its own trace. Carried so an export round-trips; nothing reads it yet.
export const SpanLinkSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type SpanLink = z.infer<typeof SpanLinkSchema>;

// Who emitted the span (OTel Resource) — `service.name`, `k8s.node.name`, `container.id`. Kept SEPARATE from
// the span's own attributes rather than merged into them (which is what the pull adapters do today): a
// resource describes the process, an attribute describes the operation, and flattening the two loses which
// is which the moment you try to export.
export const SpanResourceSchema = z.record(z.string(), z.unknown());

// What instrumented it (OTel InstrumentationScope).
export const SpanScopeSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
});
export type SpanScope = z.infer<typeof SpanScopeSchema>;

export const TraceSpanSchema = z.object({
  // W3C ids: 32 hex chars for a trace, 16 for a span. Validated as a shape, not merely a string — the whole
  // point of the id fields is that an exporter accepts them, and `tu_7` (what our span ids used to be) does
  // not survive contact with OTLP.
  traceId: z.string().regex(/^[0-9a-f]{32}$/, "traceId must be 32 lowercase hex characters"),
  spanId: z.string().regex(/^[0-9a-f]{16}$/, "spanId must be 16 lowercase hex characters"),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/, "parentSpanId must be 16 lowercase hex characters")
    .optional(),
  name: z.string(),
  kind: SpanKindSchema.default("internal"),
  // Absolute instants, both of them. A span with no end has not ended; there is no "instant span" in this
  // model — a thing with no duration is a SpanEvent, which is the distinction the old model could not make.
  startedAt: z.string(),
  endedAt: z.string(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  // `artifact://` ref to the full attribute bag when it was too large to keep inline; `attributes` then holds
  // the same shape with its oversized string leaves truncated. See the offload note in execution/trace.ts —
  // the record is the same value either way, and a caller that needs the bytes asks the trajectory store to
  // resolve them.
  attributesRef: z.string().optional(),
  events: z.array(SpanEventSchema).optional(),
  links: z.array(SpanLinkSchema).optional(),
  status: SpanStatusSchema.optional(),
  resource: SpanResourceSchema.optional(),
  scope: SpanScopeSchema.optional(),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

// The span half of the producer-facing split — see `UntrustedTraceEventSchema` in `trace.ts` for why a
// platform-authored artifact coordinate may not arrive from a producer.
export const UntrustedTraceSpanSchema = z.preprocess(stripPlatformAuthoredFields, TraceSpanSchema);

// --- Identity ------------------------------------------------------------------------------------------

// Entropy source, injectable for the same reason clocks are: a test that cannot fix the ids cannot assert on
// a tree. Defaults to the platform CSPRNG (Web Crypto, present in every runtime we target).
export type RandomBytes = (length: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function newTraceId(random: RandomBytes = defaultRandomBytes): string {
  return hex(random(16));
}

export function newSpanId(random: RandomBytes = defaultRandomBytes): string {
  return hex(random(8));
}

// The trace id a RUN's planes share, derived from the run id rather than minted.
//
// Deterministic on purpose: the agent's plane and the orchestrator's placement plane are sealed by different
// processes that never speak to each other, and a run is one trace. Deriving means both arrive at the same id
// with no coordination, and a plane that seals late still joins the trace it belongs to. This is an
// IDENTIFIER, not a security primitive — a fast avalanche hash is the right tool, and collisions across two
// distinct run ids would only merge two traces in a viewer.
export function traceIdForRun(runId: string): string {
  // FNV-1a, four independent 32-bit lanes (distinct offset bases) → 32 hex characters.
  const bases = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  return bases
    .map((base) => {
      let h = base >>> 0;
      for (let i = 0; i < runId.length; i++) {
        h ^= runId.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    })
    .join("");
}

// --- W3C trace context ---------------------------------------------------------------------------------
//
// The propagation format that makes one RUN one TRACE across the process boundary. The job really does run
// inside the placed unit, so the agent's spans are genuinely children of the placement span — but only if
// the parent's identity crosses with it. This travels beside the `EVERDICT_RUN_ID` and
// `OTEL_RESOURCE_ATTRIBUTES` we already inject.
export const TRACEPARENT_ENV = "TRACEPARENT";

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

// `00-<32 hex trace>-<16 hex span>-<2 hex flags>`
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

// Undefined on anything malformed — a caller that cannot parse the parent starts its own trace rather than
// hanging spans off an id it guessed. Version `00` only: a future version's extra fields are not ours to
// interpret, but its first three fields are positionally stable, so we accept them and ignore the rest.
export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (value === undefined) return undefined;
  const parts = value.trim().split("-");
  const [version, traceId, spanId, flags] = parts;
  if (parts.length < 4 || version === undefined || version === "ff" || !/^[0-9a-f]{2}$/.test(version)) return undefined;
  if (traceId === undefined || !/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) return undefined;
  if (spanId === undefined || !/^[0-9a-f]{16}$/.test(spanId) || /^0+$/.test(spanId)) return undefined;
  if (flags === undefined || !/^[0-9a-f]{2}$/.test(flags)) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01 };
}
