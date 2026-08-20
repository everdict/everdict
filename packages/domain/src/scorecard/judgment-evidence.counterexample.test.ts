import type { CaseResult } from "@everdict/contracts";
import { CURRENT_EVIDENCE_VERSION } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { evidenceStatus } from "./evidence-status.js";

// ── A VERDICT WHOSE ACCOUNT IS GONE IS NOT A VERDICT WITH AN ACCOUNT (arch-review 58 follow-through) ─
//
// Sealing a judge's own execution as evidence is best-effort BY CONTRACT — evidence, never lifecycle,
// because losing the seal must not lose a real verdict. That contract is right. What was wrong is that the
// failure was swallowed (`.catch(() => {})`) and the port answered a bare `Score[]`, so a judgment whose
// "how" is gone came back indistinguishable from one whose "how" is on file. The product sells a defensible
// verdict, and defensibility is precisely the thing that went missing without a trace.
//
// The verifier lane had the same gap from the other end: `VerifierReceipt.complete` said whether the
// deciding container could be named, and nothing read it.
//
// `EvidenceStatus` is where both belong. It already answers "we have evidence" vs "the evidence is
// complete" for the trace and the snapshot — trust-kernel contract ⑤ — and it is already served on the
// scorecard API and counted in the ops report. So the judgment plane joins it, and the two silent losses
// become a value a reader can see.
//
// Seen RED before the plane existed, observed:
//   Property 'judgment' does not exist on type 'EvidenceStatus'
// …and, with the plane present but the seal outcome still swallowed:
//   a judgment whose evidence was lost read as complete: expected 'complete' to be 'partial'

const judged = (over: Partial<CaseResult> = {}): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    evidenceVersion: CURRENT_EVIDENCE_VERSION,
    trace: [{ t: 0, kind: "message", role: "assistant", text: "hi" }],
    traceSealed: true,
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "quality", metric: "judge:quality", value: 1, pass: true }],
    ...over,
  }) as unknown as CaseResult;

describe("[R58 FOLLOW-THROUGH] the judgment plane says whether a verdict can be re-inspected", () => {
  it("is COMPLETE when every judgment sealed its own execution", () => {
    expect(evidenceStatus(judged({ judgmentsSealed: true })).judgment).toBe("complete");
  });

  it("is PARTIAL when a judgment ran and its evidence did not land", () => {
    // The defect. The verdict stands — it really was reached — and its account is gone, which a reader now
    // learns instead of being told the case is fully evidenced.
    expect(
      evidenceStatus(judged({ judgmentsSealed: false })).judgment,
      "a judgment whose evidence was lost read as complete",
    ).toBe("partial");
  });

  it("is NOT_APPLICABLE when nothing judged the case", () => {
    // Different from complete, and the difference matters: a case nobody judged must not read as well
    // evidenced as one whose judges all sealed.
    const unjudged = judged({ scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }] });
    expect(evidenceStatus(unjudged).judgment).toBe("not_applicable");
  });

  it("is PARTIAL when the deciding verdict came from a container the lane could not name", () => {
    // The verifier's half of the same question. `complete: false` means the receipt cannot say where the
    // verdict happened or from which image — so the account cannot be re-opened, however well the judge
    // half sealed.
    const viaVerifier = judged({
      judgmentsSealed: true,
      verifier: {
        planDigest: "sha256:plan",
        workspaceDigest: "sha256:ws",
        scoreDigest: "sha256:scores",
        scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        complete: false,
      },
    } as unknown as Partial<CaseResult>);
    expect(evidenceStatus(viaVerifier).judgment, "an unattributable verifier container read as complete").toBe(
      "partial",
    );
  });

  it("says NOT_APPLICABLE for a row that states nothing about judgment", () => {
    // Read from the producer's own statement, never from the scores: asking whether a metric starts with
    // `judge:` would be deriving identity from a rendered label, which is the re-derivation rule `protocol`
    // L3 forbids — and the raw-scores guard in this package refused the first draft that did it.
    //
    // On a pre-field row this is technically incomplete: it may well have been judged. It is the honest
    // answer available, because the alternative is to infer from output what the producer never recorded.
    const silent = judged({ evidenceVersion: 1, judgmentsSealed: undefined });
    expect(evidenceStatus(silent).judgment).toBe("not_applicable");
  });

  it("is COMPLETE for a verifier verdict whose receipt names its container", () => {
    const attributable = judged({
      verifier: {
        planDigest: "sha256:plan",
        workspaceDigest: "sha256:ws",
        scoreDigest: "sha256:scores",
        scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        complete: true,
      },
    } as unknown as Partial<CaseResult>);
    expect(evidenceStatus(attributable).judgment).toBe("complete");
  });
});
