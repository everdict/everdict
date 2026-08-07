import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { workspaceOpsReport } from "./ops-report.js";

const pass = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "x" }],
  traceSealed: true,
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: "t", metric: "tests_pass", value: 1, pass: true }],
});

const infraDead = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
  failure: { stage: "dispatch", class: "infra", code: "UPSTREAM_ERROR", message: "blip", retryable: true },
});

describe("workspaceOpsReport — the workspace's own SLA evidence", () => {
  it("separates the platform's share (infra/evidence) from the product's, with domain-derived tallies", () => {
    const report = workspaceOpsReport(
      [
        {
          status: "succeeded",
          requested: 3,
          scorecard: { results: [pass("a"), pass("b"), infraDead("c")] },
        },
        { status: "cancelled" },
      ],
      { from: "2026-08-01T00:00:00Z" },
    );
    expect(report.from).toBe("2026-08-01T00:00:00Z");
    expect(report.batches).toEqual({ total: 2, succeeded: 1, failed: 0, cancelled: 1, superseded: 0 });
    expect(report.cases).toMatchObject({ executed: 3, verdicted: 2, infraFailed: 1, requested: 3 });
    expect(report.rates.infraFailure).toBeCloseTo(1 / 3);
    expect(report.rates.traceComplete).toBeCloseTo(2 / 3); // sealed passes only — the dead case has no trace
    expect(report.evidence.trace).toMatchObject({ complete: 2, missing: 1 });
    expect(report.evidence.snapshot).toEqual({ complete: 2, missing: 1 });
  });

  it("an empty window has NO rates — a denominator of zero is absence, never 0%", () => {
    const report = workspaceOpsReport([{ status: "cancelled" }]);
    expect(report.rates).toEqual({});
    expect(report.cases.executed).toBe(0);
    // A batch without per-case detail contributes to batch tallies only — no invented case rows.
    expect(report.batches.cancelled).toBe(1);
  });
});
