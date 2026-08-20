import type { Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type VerifierInvocation, verifierReceiptOf } from "./verifier-receipt.js";

// ── A VERDICT CARRIES WHAT PRODUCED IT (arch-review 57 P1) ───────────────────────────────────────────
//
// `dispatchVerifier` answers `Score[]`, and `withVerifierPass` appends those scores to the case result. The
// numbers arrive; nothing arrives with them. So the record cannot answer the question a defensible verdict
// exists to answer:
//
//     which procedure, reading which workspace, in which runtime, produced this number?
//
// Every part of that is known at the moment of the invocation and thrown away one frame later. The plan has
// a content digest and the job carries it; the workspace snapshot has a digest; the lane knows the work id
// and the image it placed; the reward file has bytes. None of it is joined to the score, so a replay can say
// "tests_pass was 1" and cannot say what was run to get it.
//
// This is rule `protocol` L3 at the seam that matters most: provenance is born at the source. Re-deriving it
// later — from the metric name, from the record's current plan, from whatever the registry holds now — is
// exactly the class this repo has paid for repeatedly. The verifier knows; the verifier should say.
//
// RED as of 927eddfc, observed:
//   Cannot find module './verifier-receipt.js'
//
// It lives in `domain`, not `contracts`: it digests, and every consumer (backends, application-control,
// apps/api) sits ABOVE the domain cone — the admission test in rule `core-contracts`.
//
// What this pins is the RECEIPT: given an invocation, the evidence that must travel with its scores, and
// what it means for one to be incomplete. Whether a lane fills it in is that lane's wiring.

const score = (metric: string, value: number): Score => ({ graderId: "reward-file", metric, value, pass: value > 0 });

const invocation = (over: Partial<VerifierInvocation> = {}): VerifierInvocation => ({
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [score("tests_pass", 1)],
  ...over,
});

describe("[R57 COUNTEREXAMPLE] a verifier verdict says what produced it", () => {
  it("joins the scores to the procedure and the workspace they were read from", () => {
    const receipt = verifierReceiptOf(invocation());
    expect(receipt.planDigest).toBe("sha256:plan");
    expect(receipt.workspaceDigest).toBe("sha256:workspace");
    expect(receipt.scores).toHaveLength(1);
  });

  it("digests the SCORES, so a record cannot be re-read as a different verdict", () => {
    const a = verifierReceiptOf(invocation());
    const b = verifierReceiptOf(invocation({ scores: [score("tests_pass", 0)] }));
    expect(a.scoreDigest).not.toBe(b.scoreDigest);
  });

  it("is stable for the same invocation — a digest that moved on its own proves nothing", () => {
    expect(verifierReceiptOf(invocation()).scoreDigest).toBe(verifierReceiptOf(invocation()).scoreDigest);
  });

  it("does not depend on the ORDER graders happened to run in", () => {
    // Two lanes that ran the same graders reached the same verdict; a receipt that says otherwise turns a
    // scheduling detail into a difference of evidence.
    const forward = invocation({ scores: [score("tests_pass", 1), score("cost", 2)] });
    const reverse = invocation({ scores: [score("cost", 2), score("tests_pass", 1)] });
    expect(verifierReceiptOf(forward).scoreDigest).toBe(verifierReceiptOf(reverse).scoreDigest);
  });

  it("records the RUNTIME identity when the lane reported one", () => {
    const receipt = verifierReceiptOf(
      invocation({
        work: { tenant: "acme", runId: "r1", externalJobId: "everdict-c1-verify" },
        imageProvenance: { kind: "resolved", images: [{ ref: "task:1", digest: "sha256:img" }], by: "ref" },
      }),
    );
    expect(receipt.work?.externalJobId).toBe("everdict-c1-verify");
    expect(receipt.imageProvenance?.kind).toBe("resolved");
  });

  it("is INCOMPLETE, not silently fine, when the lane could not report where it ran", () => {
    // A receipt missing its runtime identity is still worth keeping — the plan and workspace digests are
    // real — but a consumer must be able to tell. Absence that reads as completeness is how a weaker record
    // gets counted as a stronger one.
    expect(verifierReceiptOf(invocation()).complete).toBe(false);
    // …and `none` is NOT the completing half, which this assertion originally claimed. `ImageProvenance` is a
    // three-valued union: `none` says the lane observed no image at all and `unresolved` says it saw refs it
    // could not pin to bytes. Reading either as complete makes the one signal for "this verdict is not fully
    // attributed" say yes for exactly the two cases it exists to flag (arch-review 58 P1, and see
    // `verifier-receipt-completeness.counterexample.test.ts` for the full statement).
    expect(
      verifierReceiptOf(
        invocation({
          work: { tenant: "acme", runId: "r1", externalJobId: "j" },
          imageProvenance: { kind: "none" },
        }),
      ).complete,
    ).toBe(false);
    expect(
      verifierReceiptOf(
        invocation({
          work: { tenant: "acme", runId: "r1", externalJobId: "j" },
          imageProvenance: { kind: "resolved", by: "driver", images: [{ ref: "t:1", digest: "sha256:img" }] },
        }),
      ).complete,
    ).toBe(true);
  });

  it("REFUSES an invocation with no scores — an empty verdict is not a measurement", () => {
    // The same rule the verifier runner already applies to an empty plan: reporting an absence as a result
    // is how a case that was never judged reads as one that was.
    expect(() => verifierReceiptOf(invocation({ scores: [] }))).toThrow(/no score|not a measurement/i);
  });
});
