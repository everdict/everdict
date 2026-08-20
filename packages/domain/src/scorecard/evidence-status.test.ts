import { CURRENT_EVIDENCE_VERSION, type CaseFailure, type EnvSnapshot, type TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { evidenceStatus } from "./evidence-status.js";

const failure = (stage: CaseFailure["stage"]): CaseFailure => ({
  stage,
  class: "infra",
  code: "X",
  message: "m",
  retryable: true,
});

const repoSnapshot: EnvSnapshot = { kind: "repo", diff: "d", changedFiles: ["a.ts"], headSha: "h" };
const placeholderSnapshot: EnvSnapshot = { kind: "prompt", output: "" };
const events: TraceEvent[] = [{ t: 0, kind: "log", stream: "stdout", text: "hi" }];

describe("evidenceStatus — completeness as a value, derived not self-reported", () => {
  it("a normal run with events and a real snapshot is complete/complete", () => {
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot })).toEqual({
      trace: "complete",
      snapshot: "complete",
      // This row states nothing about judgment — no scorer vouch, no verifier receipt — which is exactly
      // what the plane answers (arch-review 58 follow-through).
      judgment: "not_applicable",
    });
  });

  it("a collect failure with surviving events is PARTIAL — never reported complete", () => {
    // The partial-results-by-design path: the run finished, collection died halfway.
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot, failure: failure("collect") }).trace).toBe(
      "partial",
    );
  });

  it("a collect failure with nothing collected is missing", () => {
    expect(evidenceStatus({ trace: [], snapshot: repoSnapshot, failure: failure("collect") }).trace).toBe("missing");
  });

  it("a dispatch death has missing trace and a missing (placeholder) snapshot", () => {
    expect(
      evidenceStatus({
        trace: [{ t: 0, kind: "error", message: "boom" }],
        snapshot: placeholderSnapshot,
        failure: failure("dispatch"),
      }),
    ).toEqual({ trace: "missing", snapshot: "missing", judgment: "not_applicable" }); // infra post-mortem events are not the agent's trajectory
  });

  it("the positive seal is the only path to complete for sealed-era producers", () => {
    // sealed → complete; explicitly unsealed (false) with events → partial (truncation is indistinguishable
    // from completeness without the producer's vouch); legacy rows (field absent) keep their old reading.
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot, traceSealed: true }).trace).toBe("complete");
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot, traceSealed: false }).trace).toBe("partial");
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot }).trace).toBe("complete");
  });

  it("a sealed-era result that did NOT vouch reads partial — the era is what makes the absence a statement", () => {
    // Regression: pre-fix, an absent seal was read as "complete" no matter who wrote the row, because
    // "written before the seal existed" and "written by a producer that declined to vouch" were the same
    // absence. `evidenceVersion` bounds the era, so the second one is now a real statement about the trace.
    // The ingest paths are exactly this shape: they score a trace someone else collected.
    expect(
      evidenceStatus({ trace: events, snapshot: repoSnapshot, evidenceVersion: CURRENT_EVIDENCE_VERSION }).trace,
    ).toBe("partial");
    // …and a producer of the same era that DID vouch is still complete.
    expect(
      evidenceStatus({
        trace: events,
        snapshot: repoSnapshot,
        evidenceVersion: CURRENT_EVIDENCE_VERSION,
        traceSealed: true,
      }).trace,
    ).toBe("complete");
  });

  it("a legacy row with no era keeps its old reading — history is not retroactively demoted", () => {
    // The whole point of versioning the era rather than flipping the default: a row written before any
    // producer could vouch says nothing about its own completeness, and inventing a downgrade for it would
    // rewrite what every historical batch's evidence report claimed.
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot }).trace).toBe("complete");
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot, evidenceVersion: 1 }).trace).toBe("complete");
  });

  it("control-plane collection pending reads deferred — even beside the job's infra lifecycle marks", () => {
    const ref = { kind: "otel", endpoint: "http://t", runId: "r1" } as const;
    expect(evidenceStatus({ trace: [], snapshot: repoSnapshot, traceRef: ref }).trace).toBe("deferred");
    // Regression: the released-compute mark (kind "infra") rode every deferred result, so "has events" made
    // the deferred branch unreachable and an UNCOLLECTED case read as complete.
    expect(
      evidenceStatus({
        trace: [{ t: 0, kind: "infra", scope: "placement", message: "sandbox released in 12ms" }],
        snapshot: repoSnapshot,
        traceRef: ref,
      }).trace,
    ).toBe("deferred");
    // ...and once the control plane collects AND SEALS, the same shape is complete.
    expect(evidenceStatus({ trace: events, snapshot: repoSnapshot, traceRef: ref, traceSealed: true }).trace).toBe(
      "complete",
    );
  });
});
