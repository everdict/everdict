import { AppError, type TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { extractInlineTrace } from "./inline-trace.js";

describe("extractInlineTrace", () => {
  const steps: TraceEvent[] = [
    { t: 0, kind: "message", role: "assistant", text: "navigate" },
    { t: 1, kind: "tool_call", id: "1", name: "goto", args: { url: "http://x" } },
    { t: 2, kind: "tool_result", id: "1", ok: true, output: "loaded" },
  ];

  it("reads a normalized TraceEvent[] from a dot-path in the response body", () => {
    // The agent returned { output, trace: [...] } inline — the judge now sees the action steps with no trace platform.
    expect(extractInlineTrace({ output: "done", trace: steps }, "trace")).toEqual(steps);
  });

  it("treats the whole body as the array when no path is given", () => {
    expect(extractInlineTrace(steps, undefined)).toEqual(steps);
  });

  it("throws a classified error (not a silent empty trace) when the inline body is not a TraceEvent[]", () => {
    // A malformed inline trace surfaces explicitly; the caller downgrades it to a non-fatal error event (trace is secondary).
    try {
      extractInlineTrace({ trace: [{ kind: "not-a-real-event" }] }, "trace");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as Error).message).toMatch(/not a normalized TraceEvent/);
    }
  });

  it("throws when the path is missing from the response", () => {
    expect(() => extractInlineTrace({ output: "done" }, "trace")).toThrow(/TraceEvent/);
  });
});
