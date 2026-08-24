import { describe, expect, it } from "vitest";
import { CaseResultSchema } from "./eval-case.js";

// ── AN EXECUTION RESULT IS NOT A CLEANUP INSTRUCTION (arch-review 66 P1-security) ───────────────────
//
// `CaseResult` is the document a grader produces — and it is also the document a SELF-HOSTED RUNNER submits:
// `submit_job_result` (apps/api runner-lease.mcp.ts) declares `result: CaseResultSchema` and hands whatever
// parses straight to the hub. The runner runs on the workspace's own machine, so everything on that schema is
// attacker-controlled in the ordinary sense: the workspace decides what it says.
//
// arch-review 65 put `intermediates` — the keys the settlement DELETES — on that schema. The keys are built
// from the settlement's own tenant and execution, so this was never cross-tenant; inside that boundary it was
// real. A sibling attempt of the same execution stages its half under a digest of its own, and a runner that
// names it hands the settlement a deletion it would otherwise never perform.
//
// The field is gone (the debt is a ledger row now — `IntermediateCleanupStore`), and this pins the boundary
// property rather than the absence: whatever a producer sends, no platform lifecycle instruction survives
// the parse.
//
// Seen RED with the field back on the schema, observed:
//   a runner-submitted cleanup instruction survived the execution boundary: expected { …(1) } to be undefined

// Exactly what a compromised or buggy runner would post: a legitimate result with a deletion rider.
const RUNNER_PAYLOAD = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  scores: [{ graderId: "steps", metric: "steps", value: 1 }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
  // A sibling attempt's staged half, named by an execution result that has no business naming it.
  intermediates: { agentResultDigest: "sha256:another-attempts-half", verifierAttemptId: "evd-run-r1#g7" },
};

describe("[R66 COUNTEREXAMPLE] the execution boundary carries no platform lifecycle state", () => {
  it("STRIPS a cleanup instruction a producer attached to its result", () => {
    const parsed = CaseResultSchema.parse(RUNNER_PAYLOAD);

    // The premise: the payload really is a valid result, so this file is measuring the rider rather than a
    // rejected document.
    expect(parsed.caseId).toBe("c1");
    expect(parsed.scores).toHaveLength(1);

    expect(
      (parsed as unknown as Record<string, unknown>).intermediates,
      "a runner-submitted cleanup instruction survived the execution boundary",
    ).toBe(undefined);
  });

  it("carries no OTHER field naming an object for deletion", () => {
    // The ratchet. The specific field is gone; what has to stay true is the shape of the rule, so a future
    // change that re-adds "which keys should the platform delete" under a different name fails here.
    const parsed = CaseResultSchema.parse(RUNNER_PAYLOAD) as unknown as Record<string, unknown>;
    const lifecycleShaped = Object.keys(parsed).filter((k) =>
      /^(intermediates|cleanup|discard|deleteKeys|artifactRefs)$/.test(k),
    );
    expect(lifecycleShaped, "the measurement document grew a platform lifecycle field again").toEqual([]);
  });
});
