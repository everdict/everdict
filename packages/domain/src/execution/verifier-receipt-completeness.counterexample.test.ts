import type { VerifierInvocation } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { verifierReceiptOf } from "./verifier-receipt.js";

// ── PRESENCE IS NOT PROVENANCE (arch-review 58 P1) ───────────────────────────────────────────────────
//
// `complete` answers one question: does this receipt carry the runtime identity, so a reader can tell a
// verdict whose origin is fully recorded from one whose origin is partly guessed. It was computed as
//
//     complete: invocation.work !== undefined && invocation.imageProvenance !== undefined
//
// which asks whether a FIELD IS SET. `ImageProvenance` is a three-valued union precisely because a field
// being set is not the same as a question being answered: `none` means this lane observed no image at all,
// and `unresolved` means it saw refs it could not pin to bytes. Both are `!== undefined`, so both counted as
// complete — and the one signal a consumer has for "you may not treat this verdict as fully attributed" said
// yes for exactly the two cases it exists to flag.
//
// This is rule `protocol` L3's last clause almost verbatim: provenance states COVERAGE, not merely presence,
// and a consumer that only asks whether something is there accepts zero. The union was built by arch-review
// 57 for this reason, and the predicate reading it went around it.
//
// Seen RED with the completeness predicate at `imageProvenance !== undefined`, observed:
//   a lane that observed no image at all reported a complete receipt: expected true to be false
//
// STILL OPEN, deliberately, and not fixed by this file: `complete` has no consumer anywhere in the repo.
// The receipt rides `CaseResult.verifier` all the way to the record and nothing reads it, so the honest
// value it now carries is not yet gating anything. What an incomplete receipt should DO — refuse the
// verdict, downgrade it, or mark it — changes which verdicts count, which is a product decision rather
// than a repair.

const invocation = (over: Partial<VerifierInvocation> = {}): VerifierInvocation =>
  ({
    planDigest: "sha256:plan",
    workspaceDigest: "sha256:workspace",
    // The execution this verdict is ABOUT, matching what the handle carries — a receipt whose two copies
    // disagree describes two executions and joins to neither (arch-review 63 P1-provenance).
    agentAttemptId: "evd-run-r1#g1",
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
    ...over,
  }) as unknown as VerifierInvocation;

// The handle `verifierOperation` actually returns: the ledger's canonical row, carrying which attempt ran
// this container and which unit it was judging. A bare {tenant, runId, externalJobId} is what a LANE knows,
// and a receipt built on one cannot be joined to the attempt that produced it (arch-review 62).
const WORK = {
  tenant: "acme",
  runId: "r1",
  externalJobId: "job-1",
  attemptId: "a-verify",
  verifier: {
    planDigest: "sha256:plan",
    workspaceDigest: "sha256:ws",
    caseId: "c1",
    // …and WHICH execution was judged (arch-review 63): a receipt that cannot say so answers "which tree"
    // and not "whose evidence", and those diverge the moment two attempts leave the same tree.
    agentAttemptId: "evd-run-r1#g1",
  },
};
const RESOLVED = { kind: "resolved", by: "driver", images: [{ ref: "tasks/repro:1", digest: "sha256:img" }] };

describe("[R58 COUNTEREXAMPLE] a receipt is complete only when its provenance resolved", () => {
  it("is complete when the lane recorded the work AND pinned the image", () => {
    expect(verifierReceiptOf(invocation({ work: WORK, imageProvenance: RESOLVED } as never)).complete).toBe(true);
  });

  it("is NOT complete when the lane observed no image at all", () => {
    // `none` is an honest answer from a lane with nothing to observe. It is not a resolved image, and a
    // receipt that reports it as one has erased the difference the union exists to keep.
    expect(
      verifierReceiptOf(invocation({ work: WORK, imageProvenance: { kind: "none" } } as never)).complete,
      "a lane that observed no image at all reported a complete receipt",
    ).toBe(false);
  });

  it("is NOT complete when the image refs could not be pinned to bytes", () => {
    const unresolved = { kind: "unresolved", images: [{ ref: "tasks/repro:latest" }] };
    expect(
      verifierReceiptOf(invocation({ work: WORK, imageProvenance: unresolved } as never)).complete,
      "an image nobody could pin to bytes reported a complete receipt",
    ).toBe(false);
  });

  it("is NOT complete without the work handle, however well the image resolved", () => {
    // The other half: knowing WHICH bytes ran is not knowing WHERE. Both or neither.
    expect(verifierReceiptOf(invocation({ imageProvenance: RESOLVED } as never)).complete).toBe(false);
  });

  it("still seals the evidence it does have — an incomplete receipt is not a discarded one", () => {
    // The plan and workspace digests are real evidence regardless. Refusing to seal them because the runtime
    // identity is missing would throw away the part that IS known, which is the opposite of the point.
    const receipt = verifierReceiptOf(invocation());
    expect(receipt.complete).toBe(false);
    expect(receipt.scoreDigest).not.toBe("");
    expect(receipt.planDigest).toBe("sha256:plan");
  });
});

// ── …AND WHICH EXECUTION IT JUDGED (arch-review 63 P1-provenance) ───────────────────────────────────
//
// `complete` asked for the verifier's own attempt and the unit coordinate. Both answer "which container
// produced this verdict" and "which tree it was about"; neither answers "whose trace, scores and runtime
// provenance were judged" — and those diverge the moment two attempts of one case leave the same tree,
// which is precisely the case arch-review 62 keyed the staged half by the result digest to handle.
//
// Both copies of that id must AGREE: one is written on the job and one on the reservation, at different
// moments, so a receipt whose copies differ describes two executions and joins to neither.
//
// Seen RED before the requirement, observed:
//   a receipt claimed to be whole while unable to say which execution it judged: expected true to be false
describe("[R63 COUNTEREXAMPLE] a complete receipt names the execution it judged", () => {
  const bare = { ...WORK, verifier: { ...WORK.verifier, agentAttemptId: undefined } };

  it("is INCOMPLETE when the judged execution is not named", () => {
    expect(
      verifierReceiptOf(invocation({ work: bare, agentAttemptId: undefined, imageProvenance: RESOLVED } as never))
        .complete,
      "a receipt claimed to be whole while unable to say which execution it judged",
    ).toBe(false);
  });

  it("is INCOMPLETE when the two copies of that id DISAGREE", () => {
    // The invocation's and the handle's are written at different moments; a receipt that carries two answers
    // describes two executions.
    expect(
      verifierReceiptOf(invocation({ work: WORK, agentAttemptId: "evd-run-r1#g9", imageProvenance: RESOLVED } as never))
        .complete,
      "a receipt with two different judged executions read as whole",
    ).toBe(false);
  });

  it("is complete when both name the same execution", () => {
    // The control, and the shape production produces — `verifierOperation` stamps the coordinate onto the
    // reservation and returns it on the invocation from the one job field.
    expect(verifierReceiptOf(invocation({ work: WORK, imageProvenance: RESOLVED } as never)).complete).toBe(true);
  });
});
