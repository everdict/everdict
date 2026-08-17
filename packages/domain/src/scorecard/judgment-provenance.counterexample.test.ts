import type { CaseResult, GateScoringPin } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type GateInput, applyInputTrust, evaluateGate } from "./gate.js";
import { appendScoringRevision, currentScoringPin } from "./scoring-revision.js";

// ── EVERY JUDGING IS A PASS, NOT JUST THE DETACHED ONE (arch-review 53, Wave D) ──────────────────────
//
// Wave 5 gave the re-score's revision a judgment receipt vector: WHICH invocation of which judge produced
// the verdict this revision adopted. It gave it to exactly one caller. `ScoringService.applyJudges` takes
// `scoringPass?: string | JudgeEvidenceScope` — optional — and the two batch drivers do not pass it, so the
// INITIAL judging of every batch is recorded as an anonymous one-shot.
//
// "One-shot" is the assumption that fails. The durable batch lane runs each case as a Temporal activity with
// `heartbeatTimeout: "1 minute"` and `retry: { maximumAttempts: 10 }`: a worker death or a lost heartbeat
// re-runs the SAME case, and each run judges again. The first invocation may have sealed its judge evidence
// plane before dying (the trajectory keeps the first seal); the retry's child result is what commits. The
// revision then records a score plane from invocation B beside a judge evidence plane authored by invocation
// A, and nothing on the revision says which one it adopted — because initial revisions carry no receipt
// vector at all.
//
// And the gate does not ask. `GateScoringPin` gained `judgmentReceiptSetDigest` as an OPTIONAL field, and
// `inputTrustReasons` consumes `inputObservation` only. So a release can be gated on a comparison whose
// EXECUTION input is receipt-vouched and whose JUDGMENT author is unrecorded, and the decision reads clean.
//
// The invariant these pin: a revision states its judgment provenance as `recorded` or `unrecorded` — never by
// omission — and an unrecorded provenance is not comparable unless a waiver says so, exactly as an
// unverified input already is.

const results: CaseResult[] = [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "judge:a", metric: "quality", value: 1, pass: true }],
  },
];

const initialPass = () =>
  appendScoringRevision(undefined, {
    kind: "initial",
    judges: [{ id: "a", version: "1" }],
    results,
    inputObservation: { completed: true, cases: results.length, diverged: 0, vouched: results.length },
    createdAt: "2026-08-17T00:00:00.000Z",
  } as never);

// RED as of 186f9fd9: `expected undefined to be defined` — only the re-score path passes `judgments`.
describe.skip("[R53 WAVE-D COUNTEREXAMPLE #18] an initial revision states which invocations it adopted", () => {
  it("carries a judgment receipt vector, like the re-score revision does", () => {
    const revisions = initialPass();
    const born = revisions[0];

    expect(born?.judges.length).toBe(1);
    // A revision that judged something and recorded no author is the shape this wave removes.
    expect(
      (born as { judgments?: unknown[] } | undefined)?.judgments,
      "the initial revision judged one case and recorded no invocation for it",
    ).toBeDefined();
    expect(
      (born as { judgmentReceiptSetDigest?: string } | undefined)?.judgmentReceiptSetDigest,
      "no digest, so no pin can carry the provenance either",
    ).toBeDefined();
  });
});

// RED as of 186f9fd9: `expected 'unrecorded' to be …` — provenance is expressed by ABSENCE, so a consumer
// cannot tell "this pass recorded nothing" from "this field has not been read yet".
describe.skip("[R53 WAVE-D COUNTEREXAMPLE #19] provenance is stated, never omitted", () => {
  it("a revision says recorded or unrecorded, and an unrecorded one says why", () => {
    const born = initialPass()[0] as { judgmentProvenance?: { kind: string; reason?: string } } | undefined;

    expect(born?.judgmentProvenance?.kind, "provenance is absent rather than stated").toBeTypeOf("string");
    if (born?.judgmentProvenance?.kind === "unrecorded")
      expect(born.judgmentProvenance.reason, "an unrecorded provenance must name its reason").toBeTypeOf("string");
  });
});

// RED as of 186f9fd9: `expected 'pass' to be 'not_comparable'` — the gate reads inputObservation only.
describe.skip("[R53 WAVE-D COUNTEREXAMPLE #20] a gate refuses a comparison whose judgment author is unknown", () => {
  it("treats unrecorded judgment provenance the way it already treats unverified input", () => {
    const pin = (over: Partial<GateScoringPin> = {}): GateScoringPin =>
      ({
        revision: 1,
        judges: [{ id: "a", version: "1" }],
        scorePlaneDigest: "sha256:plane",
        // Execution input IS vouched — this test is about the other half.
        inputObservation: { completed: true, cases: 1, diverged: 0, vouched: 1 },
        ...over,
      }) as GateScoringPin;

    const diff: GateInput = {
      baseline: "b",
      candidate: "c",
      metrics: [],
      regressions: [],
      improvements: [],
      caseTransitions: [],
      metricCoverage: [],
      missing: {
        casesOnlyInBaseline: [],
        casesOnlyInCandidate: [],
        metricsOnlyInBaseline: [],
        metricsOnlyInCandidate: [],
      },
      incomparable: [],
      overlap: { sharedCases: 1, baselineCases: 1, candidateCases: 1 },
      comparability: "full",
    };
    // The same two-step the gate route takes: evaluate, then apply what the pins say about input trust.
    const decision = applyInputTrust(
      evaluateGate(diff, { maxRegressions: 0, comparability: "require_full" }),
      { baseline: pin(), candidate: pin() },
      { maxRegressions: 0, comparability: "require_full" },
    );

    // Both sides state a vouched execution input and neither states who judged it.
    expect(
      decision.decision === "not_comparable" || decision.reasons.some((r) => String(r.kind) === "judgment_unrecorded"),
      "the gate passed a comparison with no judgment provenance on either side",
    ).toBe(true);
  });
});

// RED as of 186f9fd9: the pin projects only what the revision holds, and the revision holds nothing.
describe.skip("[R53 WAVE-D COUNTEREXAMPLE #21] the pin carries the provenance the gate needs", () => {
  it("projects the initial revision's judgment digest onto the pin", () => {
    const pinned = currentScoringPin(initialPass());
    expect(
      (pinned as { judgmentReceiptSetDigest?: string } | undefined)?.judgmentReceiptSetDigest,
      "an initial pass's pin cannot state its judgment provenance",
    ).toBeDefined();
  });
});
