import { describe, expect, it } from "vitest";
import { type RandomBytes, TraceSpanSchema, formatTraceparent, newSpanId, traceIdForRun } from "./span.js";

// The ids are the whole reason this type exists rather than another string bag: a record whose span id is
// `tu_7` cannot be handed to an OTLP exporter, so "our trace IS a valid trace" fails at the first field.

const fixed: RandomBytes = (length) => new Uint8Array(length).fill(0xab);

describe("span identity", () => {
  it("mints a W3C-shaped span id — 16 hex", () => {
    expect(newSpanId(fixed)).toBe("ab".repeat(8));
  });

  it("mints ids the schema accepts, which is the point", () => {
    const span = TraceSpanSchema.parse({
      traceId: traceIdForRun("run-1"),
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

// One run is one trace only if the parent's identity crosses the process boundary — the traceparent a spawned
// process is handed.
describe("W3C trace context propagation", () => {
  const ctx = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };

  it("formats a traceparent", () => {
    expect(formatTraceparent(ctx)).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });

  it("carries the sampled flag", () => {
    expect(formatTraceparent({ ...ctx, sampled: false })).toMatch(/-00$/);
  });
});
