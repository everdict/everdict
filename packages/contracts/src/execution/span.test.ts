import { describe, expect, it } from "vitest";
import {
  type RandomBytes,
  TraceSpanSchema,
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from "./span.js";

// The ids are the whole reason this type exists rather than another string bag: a record whose span id is
// `tu_7` cannot be handed to an OTLP exporter, so "our trace IS a valid trace" fails at the first field.

const fixed: RandomBytes = (length) => new Uint8Array(length).fill(0xab);

describe("span identity", () => {
  it("mints W3C-shaped ids — 32 hex for a trace, 16 for a span", () => {
    expect(newTraceId(fixed)).toBe("ab".repeat(16));
    expect(newSpanId(fixed)).toBe("ab".repeat(8));
  });

  it("mints ids the schema accepts, which is the point", () => {
    const span = TraceSpanSchema.parse({
      traceId: newTraceId(),
      spanId: newSpanId(),
      name: "chat claude-opus-5",
      startedAt: "2026-08-04T00:00:00.000Z",
      endedAt: "2026-08-04T00:00:01.200Z",
    });
    expect(span.kind).toBe("internal"); // the default a caller need not state
    expect(span.attributes).toEqual({});
  });

  it("refuses an id that is not hex — the failure belongs here, not at the exporter", () => {
    const bad = {
      traceId: "tu_7",
      spanId: newSpanId(),
      name: "execute_tool Bash",
      startedAt: "2026-08-04T00:00:00.000Z",
      endedAt: "2026-08-04T00:00:00.400Z",
    };
    expect(() => TraceSpanSchema.parse(bad)).toThrow();
  });
});

// One run is one trace only if the parent's identity crosses the process boundary. These are the two halves
// of that crossing, and the parser is deliberately strict: a caller that cannot read the parent starts a new
// trace rather than hanging spans off an id it guessed.
describe("W3C trace context propagation", () => {
  const ctx = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };

  it("round-trips a traceparent", () => {
    const header = formatTraceparent(ctx);
    expect(header).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(parseTraceparent(header)).toEqual(ctx);
  });

  it("carries the sampled flag both ways", () => {
    expect(formatTraceparent({ ...ctx, sampled: false })).toMatch(/-00$/);
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled).toBe(false);
  });

  it("accepts a future version's first three fields but refuses the forbidden one", () => {
    // A later version may append fields; the first three are positionally stable, so we read them.
    expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra")?.traceId).toBe(
      ctx.traceId,
    );
    expect(parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeUndefined();
  });

  it("refuses malformed, truncated, and all-zero ids rather than guessing a parent", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent("not-a-header")).toBeUndefined();
    expect(parseTraceparent("00-4bf92f3577b34da6-00f067aa0ba902b7-01")).toBeUndefined(); // short trace id
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined(); // all-zero trace id
    expect(parseTraceparent(`00-${ctx.traceId}-${"0".repeat(16)}-01`)).toBeUndefined(); // all-zero span id
  });
});
