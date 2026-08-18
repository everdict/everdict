import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { judgeEvidenceEmitter } from "./judge-execution-spans.js";
import { appendScoringRevision, initialScoringPassId, judgmentReceiptsFromPlane } from "./scoring-revision.js";

// ── PROVENANCE IS BORN AT THE SOURCE, AND STATES COVERAGE (arch-review 54, Phase 3) ──────────────────
//
// Wave D gave the initial pass a judgment receipt vector and a `judgmentProvenance` statement. It built that
// vector by walking the SCORE PLANE and re-deriving each judge's identity from the metric string:
//
//     const judgeId = score.metric.startsWith("judge:") ? score.metric.slice("judge:".length) : undefined;
//
// Two things follow, and both are the same mistake — an identity reconstructed from rendered output rather
// than recorded where it was produced (rule `protocol` L3).
//
// (1) A judge's rows are rewritten by the runner into `judge:<id>` for its overall verdict and
//     `judge:<id>:<criterion>` for each criterion (`apps/api/src/core/execution/judge-runner.ts`:
//     `metric.replace(/^judge/, "judge:<id>")`). Slicing after "judge:" therefore reads a three-segment
//     criterion metric as a DIFFERENT JUDGE. One multi-criteria judge becomes three phantom judges, each
//     minting a receipt whose `evidenceEmitter` names an evidence plane that does not exist. A receipt exists
//     to point at its evidence; the join key is wrong for every criterion row.
//
//     The correct predicate is already in this repo — `judgeIdOf` in
//     `packages/application-control/src/trace-sink/trace-sink-service.ts` takes the FIRST segment, which is
//     exact because `JudgeIdSchema` forbids ':' in a judge id. A predicate written twice has already diverged.
//
// (2) `appendScoringRevision` decides `kind: "recorded"` from `input.judgments !== undefined`, and `[]` is not
//     `undefined`. So a pass that judged a hundred cases and recorded nothing carries `recorded` provenance,
//     and the gate — which asks only `kind !== "recorded"` — accepts it. Presence is not coverage.
//
// The invariant: a receipt names the judge that was INVOKED, and provenance states how many judgments were
// expected against how many were recorded.

const passId = initialScoringPassId("sc-1");

// One registered judge `a` with two criteria, in the exact shape the runner emits.
const multiCriteria: CaseResult[] = [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [
      { graderId: "a", metric: "judge:a", value: 1, pass: true },
      { graderId: "a", metric: "judge:a:helpfulness", value: 0.9, pass: true },
      { graderId: "a", metric: "judge:a:safety", value: 1, pass: true },
    ],
  },
];

// RED as of efe3657e, observed:
//   expected [ 'a', 'a:helpfulness', 'a:safety' ] to deeply equal [ 'a' ]
//   expected [ 'judge:a#initial:sc-1', …(2) ] to deeply equal [ 'judge:a#initial:sc-1' ]
describe("[R54 PHASE-3 COUNTEREXAMPLE #9 — CLOSED] one invoked judge is one receipt, however many criteria it scored", () => {
  it("does not mint a phantom judge per criterion metric", () => {
    const receipts = judgmentReceiptsFromPlane(multiCriteria, passId, () => undefined);
    expect(
      receipts.map((r) => r.ref.judgeId).sort(),
      "a criterion metric was read as a separate judge — `judge:a:safety` is judge `a` scoring `safety`",
    ).toEqual(["a"]);
  });

  it("carries the emitter the judge's evidence plane actually has", () => {
    const receipts = judgmentReceiptsFromPlane(multiCriteria, passId, () => undefined);
    // The evidence side mints its plane name from the judge id alone. Both sides are built with their
    // production functions here, so a divergence in either shows up as a failed join rather than as prose.
    expect(receipts.map((r) => r.evidenceEmitter)).toEqual([judgeEvidenceEmitter("a", { passId })]);
  });
});

// RED as of efe3657e, observed:
//   expected 'recorded' not to be 'recorded'   (an empty vector is accepted as authorship)
//   expected undefined to be 1                 (provenance states no coverage at all)
describe("[R54 PHASE-3 COUNTEREXAMPLE #10 — CLOSED] provenance states coverage, not merely presence", () => {
  it("a pass that judged cases and recorded no receipt is not COMPLETE provenance", () => {
    // A selected judge, a judged case, and a vector the derivation could not fill — the situation the
    // metric-string derivation produces on any plane it fails to recognise.
    const revisions = appendScoringRevision(undefined, {
      kind: "initial",
      judges: [{ id: "a", version: "1" }],
      results: multiCriteria,
      judgments: [],
      inputObservation: { completed: true, cases: 1, diverged: 0, vouched: 1 },
      createdAt: "2026-08-18T00:00:00.000Z",
    } as never);
    const provenance = (
      revisions[0] as
        | { judgmentProvenance?: { kind: string; expectedUnits?: number; recordedUnits?: number; complete?: boolean } }
        | undefined
    )?.judgmentProvenance;
    // `kind` stays "recorded" ON PURPOSE — this pass DID state something, and "we hold 0 of 1" is a different
    // fact from "the stage could not be read", which an operator needs to tell apart. What must not be true
    // is that a decision may rely on it, and that is `complete`.
    expect(
      provenance?.complete,
      "a judged pass with an empty receipt vector was accepted as having stated its authorship",
    ).toBe(false);
    expect(provenance?.expectedUnits).toBe(1);
    expect(provenance?.recordedUnits).toBe(0);
  });

  it("a recorded provenance says how many judgments it expected and how many it holds", () => {
    const revisions = appendScoringRevision(undefined, {
      kind: "initial",
      judges: [{ id: "a", version: "1" }],
      results: multiCriteria,
      judgments: judgmentReceiptsFromPlane(multiCriteria, passId, () => undefined),
      inputObservation: { completed: true, cases: 1, diverged: 0, vouched: 1 },
      createdAt: "2026-08-18T00:00:00.000Z",
    } as never);
    const provenance = (
      revisions[0] as
        | { judgmentProvenance?: { kind: string; expectedUnits?: number; recordedUnits?: number; complete?: boolean } }
        | undefined
    )?.judgmentProvenance;
    expect(provenance?.kind).toBe("recorded");
    expect(provenance?.expectedUnits, "provenance does not state how many judgments were owed").toBe(1);
    expect(provenance?.recordedUnits).toBe(1);
    expect(provenance?.complete).toBe(true);
  });
});
