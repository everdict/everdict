import type { GraderSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { makeGraders } from "./make-graders.js";

// Trust suite (docs/trust-certification.md) — TRUST-103.
//
// A DECLARATION DESCRIBES SEMANTICS; IT DOES NOT MINT OWNERSHIP OF A CONSTITUTIONAL NAME.
//
// `GraderSpec.metrics[]` was introduced so a grader could declare the semantics of what it actually measures,
// and its first version granted the producer ownership of every id it named. That re-opened the authority
// wildcard by a shorter route than the one it had just closed: `metrics: [{ id: "state" }]` carries no
// `authority` at all, so the admin gate — which looks for `authority === "ground_truth"` — never sees it,
// while the BASE policy reads the NAME `state` as ground truth regardless of what the declaration says.
// Declaring `authority: "observational"` did not even downgrade it, because base matchers are consulted first.
//
// Custom ground truth was never the thing being blocked: a NEW name plus an `authority` declaration, through
// the gate, has always been available and still is.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const script = (metrics: GraderSpec["metrics"]): GraderSpec => ({
  id: "script",
  config: { code: "print()", language: "node", id: "my-check" },
  ...(metrics ? { metrics } : {}),
});

describeTrust("TRUST-103 — a spec cannot declare its way into a constitutional name", () => {
  it("refuses to grant the reserved ground-truth and objective names", () => {
    for (const reserved of ["state", "tests_pass", "answer_match", "url_matches", "dom_contains"]) {
      const [grader] = makeGraders([script([{ id: reserved }])]);
      expect(grader?.ownsMetrics ?? [], `'${reserved}' was granted from a spec`).not.toContain(reserved);
    }
  });

  it("refuses the judge family too — a grader may not declare its way into a judge's rows", () => {
    const [grader] = makeGraders([script([{ id: "judge:quality" }])]);
    expect(grader?.ownsMetrics ?? []).not.toContain("judge:quality");
    expect(grader?.ownsJudgeVerdict).not.toBe(true);
  });

  it("…and a name of the grader's OWN grants normally — the rule is about the constitution, not about custom graders", () => {
    const [grader] = makeGraders([script([{ id: "business_verified", authority: "ground_truth" }])]);
    expect(grader?.ownsMetrics).toEqual(["business_verified"]);
  });

  it("a mixed declaration keeps the legitimate half and drops the constitutional one", () => {
    const [grader] = makeGraders([script([{ id: "business_verified" }, { id: "state" }])]);
    expect(grader?.ownsMetrics).toEqual(["business_verified"]);
  });
});
