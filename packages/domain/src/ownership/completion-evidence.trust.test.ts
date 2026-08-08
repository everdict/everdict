import type { HandoffCheckpoint, RoleProfile } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assertCompletionForRole } from "./ownership.js";

// Trust suite (docs/trust-certification.md) — TRUST-32.
//
// A ROLE REQUIRING EVIDENCE CANNOT COMPLETE WITHOUT IT. RoleProfile.requiredEvidence declared what a role
// must leave behind and nothing read it — "done" stayed whatever the finisher claimed. The decision now
// exists (assertCompletionForRole) and is wired at checkpoint admission, the one seam holding both the role
// and the evidence refs; the vocabulary mapping is explicit because the two vocabularies grew apart
// (trace→trace ref, scorecard→scorecard ref, diff→commit|file, report→file, checkpoint→the filing itself).
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const verifier = (requiredEvidence: RoleProfile["requiredEvidence"]): RoleProfile => ({
  role: "verifier",
  capabilities: { read: ["scorecards"], write: [] },
  requiredEvidence,
  completion: "verified_verdict",
});

const checkpoint = (
  refs: Array<{ type: "run" | "scorecard" | "commit" | "issue" | "trace" | "file"; id: string }>,
): HandoffCheckpoint => ({
  id: "cp-1",
  goal: "verify the fix",
  currentState: "verified",
  confirmedFacts: refs.length > 0 ? [{ statement: "checked", refs }] : [],
  hypotheses: [],
  actionsTaken: [],
  openDecisions: [],
  remainingTasks: [],
  requiredCapabilities: [],
  risks: [],
  validationPlan: "n/a",
  createdAt: "t",
  createdBy: "agent:checker",
});

describeTrust("TRUST-32 — a role requiring evidence cannot complete without it", () => {
  it("refuses an evidence-less completion, admits one citing what the profile demanded, and never blocks an undeclared profile", () => {
    expect(() => assertCompletionForRole(verifier(["scorecard", "trace"]), checkpoint([]))).toThrow(
      /missing: scorecard, trace/,
    );
    expect(() =>
      assertCompletionForRole(
        verifier(["scorecard", "trace"]),
        checkpoint([
          { type: "scorecard", id: "sc-1" },
          { type: "trace", id: "tr-1" },
        ]),
      ),
    ).not.toThrow();
    // A profile that declares nothing changes nothing — the decision arms on declaration, exactly like the
    // production binding at checkpoint admission (the synthesized profiles declare none yet).
    expect(() => assertCompletionForRole(verifier([]), checkpoint([]))).not.toThrow();
  });
});
