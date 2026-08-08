import type { CaseResult, Scorecard } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { evaluateGate } from "./gate.js";
import { diffScorecards } from "./scorecard.js";
import { diffTrials } from "./trials.js";

// Trust suite (docs/trust-certification.md) — TRUST-13 / TRUST-18.
//
// TRUST-13: THE RELEASE-REGRESSION UNIT IS THE CASE VERDICT, IN EVERY MODE. The same product outcome
// expressed as a single run and as repeated trials must gate on the same claim — a diagnostic metric flip
// that the authority ladder overrules blocks in NEITHER mode, and one case is one regression however many
// metrics it lost. A fake cannot prove this: the invariant is exactly the agreement of two INDEPENDENT
// pipelines (diffScorecards' caseTransitions vs diffTrials' per-case rates) — stubbing either re-implements
// the agreement instead of certifying it, so both real pipelines run here end to end.
//
// TRUST-18: A SILENTLY-UNEMITTED SCORE ROW CANNOT GATE GREEN. 99 of 100 measurements vanishing (rows never
// produced — not "unmeasured" rows) must never read as "0 regressions, ship it".
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const result = (
  caseId: string,
  scores: Array<{ metric: string; pass?: boolean; value?: number }>,
  trial?: number,
): CaseResult => ({
  caseId,
  harness: "h@1",
  ...(trial !== undefined ? { trial } : {}),
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: scores.map((s) => ({
    graderId: s.metric,
    metric: s.metric,
    value: s.value ?? (s.pass ? 1 : 0),
    ...(s.pass !== undefined ? { pass: s.pass } : {}),
  })),
});
const card = (results: CaseResult[]): Scorecard => ({ suiteId: "s", harness: "h@1", results });

describeTrust("TRUST-13 — trials=1 and trials>1 gate on the SAME regression unit (the case verdict)", () => {
  it("a diagnostic judge flip on a ground-truth-passing case blocks in NEITHER mode", () => {
    const scoresPass = (judgePass: boolean) => [
      { metric: "tests_pass", pass: true },
      { metric: "judge:quality", pass: judgePass, value: judgePass ? 1 : 0 },
    ];
    // Single-run mode: the metric flipped, the verdict did not.
    const single = evaluateGate(
      diffScorecards(card([result("login", scoresPass(true))]), card([result("login", scoresPass(false))])),
      { maxRegressions: 0 },
    );
    expect(single.decision).toBe("pass");
    // Trial mode: same outcome, three trials a side — the case-rate pipeline agrees.
    const b = card([0, 1, 2].map((t) => result("login", scoresPass(true), t)));
    const c = card([0, 1, 2].map((t) => result("login", scoresPass(false), t)));
    const diff = { ...diffScorecards(b, c), trials: diffTrials(b, c) };
    const trialed = evaluateGate(diff, { maxRegressions: 0 });
    expect(trialed.decision).toBe("pass");
    expect(trialed.evidence.regressions).toBe(single.evidence.regressions); // one unit, both modes: zero
  });

  it("a REAL case collapse counts ONCE in both modes — never once per metric", () => {
    const scores = (pass: boolean) => [
      { metric: "tests_pass", pass },
      { metric: "answer_match", pass },
      { metric: "judge:quality", pass, value: pass ? 1 : 0 },
    ];
    const single = evaluateGate(
      diffScorecards(card([result("login", scores(true))]), card([result("login", scores(false))])),
      { maxRegressions: 0 },
    );
    expect(single.decision).toBe("block");
    expect(single.evidence.regressions).toBe(1); // three metrics fell, ONE case broke
    const b = card([0, 1, 2, 3, 4].map((t) => result("login", scores(true), t)));
    const c = card([0, 1, 2, 3, 4].map((t) => result("login", scores(false), t)));
    const trialed = evaluateGate(
      { ...diffScorecards(b, c), trials: diffTrials(b, c, { zThreshold: 1.6 }) },
      { maxRegressions: 0 },
    );
    expect(trialed.decision).toBe("block");
    expect(trialed.evidence.regressions).toBe(1);
  });
});

describeTrust("TRUST-18 — a grader that silently stops emitting rows cannot gate green", () => {
  it("100/100 → 1/100 emitted measurements is blocked_missing, not a clean pass", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const baseline = card(ids.map((id) => result(id, [{ metric: "tests_pass", pass: true }])));
    // The candidate RAN every case, but the grader emitted a row on only one — no unmeasured rows, no
    // missing cases, nothing the metric SETS or measurementCoverage could see before per-metric coverage.
    const candidate = card(ids.map((id, i) => result(id, i === 0 ? [{ metric: "tests_pass", pass: true }] : [])));
    const g = evaluateGate(diffScorecards(baseline, candidate), { maxRegressions: 0 });
    expect(g.decision).not.toBe("pass");
    expect(g.decision).toBe("blocked_missing");
    expect(g.reasons.some((r) => r.kind === "missing_metrics" && r.detail?.includes("tests_pass"))).toBe(true);
  });
});
