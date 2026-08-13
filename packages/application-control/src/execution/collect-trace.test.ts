import type { CaseResult, EvalCase, TraceSource } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { collectDeferredTrace } from "./collect-trace.js";

const evalCase: EvalCase = {
  id: "c1",
  env: { kind: "prompt" },
  task: "do it",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const deferred: CaseResult = {
  caseId: "c1",
  harness: "aegra@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
  traceRef: { kind: "mlflow", endpoint: "http://mlflow:5000", runId: "run-1" },
};

// ── WHAT THE PULL KNEW AND THE RESULT DID NOT (downstream report 1.2 / 1.4) ──────────────────────────
describe("collectDeferredTrace — the pull's own findings reach the result", () => {
  it("carries the evidence AND the platform trace id the adapter resolved", async () => {
    // Under tag correlation the platform id is NOT the runId the caller asked with, so nothing downstream can
    // reconstruct it: a judged result had no route back to the evidence it judged, and the judge's declared
    // evidence slots were never even requested at this hop.
    const source: TraceSource = {
      async fetch() {
        return [];
      },
      async fetchDetailed() {
        return {
          events: [{ t: 0, kind: "message" as const, role: "assistant" as const, text: "done" }],
          evidence: { custom: { receipt: "ORDER-9" } },
          traceId: "tr-42",
        };
      },
    };
    const out = await collectDeferredTrace({ buildTraceSource: () => source }, "acme", evalCase, deferred);
    expect(out.sourceTraceId).toBe("tr-42");
    expect(out.evidence?.custom).toEqual({ receipt: "ORDER-9" });
    expect(out.failure).toBeUndefined();
  });

  it("a source that only implements fetch still collects — the id is simply absent, never invented", async () => {
    const source: TraceSource = {
      async fetch() {
        return [{ t: 0, kind: "message" as const, role: "assistant" as const, text: "done" }];
      },
    };
    const out = await collectDeferredTrace({ buildTraceSource: () => source }, "acme", evalCase, deferred);
    expect(out.sourceTraceId).toBeUndefined();
    expect(out.trace).toHaveLength(1);
  });
});
