import { describe, expect, it } from "vitest";
import { UntrustedTraceSpanSchema } from "./span.js";
import { TraceEventSchema, UntrustedTraceEventSchema } from "./trace.js";

// ── [R121 COUNTEREXAMPLE] A PRODUCER CANNOT HAND US AN ARTIFACT COORDINATE ──────────────────────────
//
// `textRef` / `argsRef` / `outputRef` / `attributesRef` are a CAPABILITY: the platform mints them when it
// offloads an oversized payload, a resolve fetches that key from object storage, and retention deletes it.
// The same `TraceEventSchema` was also what every producer's submission was validated by — a job result, a
// leased runner's batch, trace JSON handed to a judge tool, a scorecard ingest, the front door's inline
// trace, and the output of the harness under evaluation itself.
//
//     the ref is schema-valid   ≠   the platform minted it
//
// Rule `protocol` states the shape from `CaseResult`'s GC coordinate one review earlier: the untrusted
// execution surface, the canonical measurement and the platform's private lifecycle state are three schemas.
// This is that law as a type.
//
// Seen RED before the split: the parsed event still carried `outputRef`, so a forged coordinate reached the
// seal and then both readers —
//   "a producer-authored artifact coordinate survived the untrusted door: expected 'artifact://…' to be undefined"
const FORGED = "artifact://trajectory-payloads/rival/run-999/run/deadbeef.output";

describe("[R121 COUNTEREXAMPLE] the untrusted trace schema drops platform-authored coordinates", () => {
  it("strips a forged outputRef while keeping everything the producer legitimately said", () => {
    const parsed = UntrustedTraceEventSchema.safeParse({
      t: 2,
      kind: "tool_result",
      id: "c1",
      ok: true,
      output: "harmless preview",
      outputRef: FORGED,
    });
    expect(parsed.success, "a legitimate event was refused along with its forged field").toBe(true);
    const event = parsed.success ? (parsed.data as Record<string, unknown>) : {};
    expect(event.outputRef, "a producer-authored artifact coordinate survived the untrusted door").toBeUndefined();
    // The producer's own content is untouched — stripping is not rejection, and not truncation.
    expect(event.output).toBe("harmless preview");
    expect(event.id).toBe("c1");
  });

  it("strips every one of the four coordinates, not only the one that was noticed", () => {
    const cases = [
      { t: 0, kind: "message", role: "user", text: "x", textRef: FORGED },
      { t: 1, kind: "tool_call", id: "c1", name: "n", args: {}, argsRef: FORGED },
      { t: 2, kind: "tool_result", id: "c1", ok: true, output: "x", outputRef: FORGED },
      { t: 3, kind: "log", stream: "stdout", text: "x", textRef: FORGED },
    ];
    for (const raw of cases) {
      const parsed = UntrustedTraceEventSchema.safeParse(raw);
      expect(parsed.success, `the ${raw.kind} case was refused`).toBe(true);
      const event = parsed.success ? (parsed.data as Record<string, unknown>) : {};
      for (const field of ["textRef", "argsRef", "outputRef", "attributesRef"])
        expect(event[field], `${raw.kind}.${field} survived the untrusted door`).toBeUndefined();
    }
  });

  it("strips the span coordinate too — the OTLP door is a producer like any other", () => {
    const parsed = UntrustedTraceSpanSchema.safeParse({
      name: "s",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      attributes: { a: 1 },
      attributesRef: FORGED,
    });
    expect(parsed.success, "a legitimate span was refused").toBe(true);
    expect(
      (parsed.success ? (parsed.data as Record<string, unknown>) : {}).attributesRef,
      "a producer-authored span coordinate survived the untrusted door",
    ).toBeUndefined();
  });

  it("the STORED schema still accepts them — this is a split, not a deletion", () => {
    // The platform's own decode path reads back what it wrote. If this stopped carrying the ref, every
    // offloaded payload would become unreachable, which is the opposite failure.
    const stored = TraceEventSchema.safeParse({
      t: 2,
      kind: "tool_result",
      id: "c1",
      ok: true,
      output: "preview",
      outputRef: FORGED,
    });
    expect(stored.success).toBe(true);
    expect((stored.success ? (stored.data as Record<string, unknown>) : {}).outputRef).toBe(FORGED);
  });
});
