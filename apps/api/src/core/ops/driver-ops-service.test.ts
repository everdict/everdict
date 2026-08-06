import { describe, expect, it } from "vitest";
import { parseDriverWorkflowId } from "./driver-ops-service.js";

describe("parseDriverWorkflowId (the workflowId grammar, inverted)", () => {
  it("maps each deterministic family prefix back to its ledger id", () => {
    expect(parseDriverWorkflowId("everdict-batch-sc-1")).toEqual({ family: "batch", ledgerId: "sc-1" });
    expect(parseDriverWorkflowId("everdict-score-grp-9")).toEqual({ family: "score", ledgerId: "grp-9" });
    expect(parseDriverWorkflowId("everdict-approval-ap-3")).toEqual({ family: "approval", ledgerId: "ap-3" });
    expect(parseDriverWorkflowId("everdict-reaper-run-7")).toEqual({ family: "reaper", ledgerId: "run-7" });
    expect(parseDriverWorkflowId("everdict-reaction-ev-1-sub-2")).toEqual({
      family: "reaction",
      ledgerId: "ev-1-sub-2",
    });
  });

  it("strips the nominal fire time a Temporal Schedule appends to a schedule fire's workflowId", () => {
    // The live zombie's exact shape: everdict-sched-run-<uuid>-<ISO time of the tick>.
    expect(
      parseDriverWorkflowId("everdict-sched-run-3c5a2b28-7974-4a2e-b22c-2276983df6a6-2026-08-06T03:00:00Z"),
    ).toEqual({ family: "schedule", ledgerId: "3c5a2b28-7974-4a2e-b22c-2276983df6a6" });
  });

  it("returns undefined for a workflow outside the everdict grammar", () => {
    expect(parseDriverWorkflowId("someone-elses-workflow")).toBeUndefined();
    expect(parseDriverWorkflowId("everdict-mystery-x")).toBeUndefined();
  });
});
