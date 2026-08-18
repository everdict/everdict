import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialScoringPassId, judgeEvidenceEmitter, judgmentReceiptsFromPlane } from "@everdict/domain";
import { describe, expect, it } from "vitest";

// ── EVERY LANE THAT JUDGES ALSO SAYS UNDER WHAT (arch-review 56, Wave E) ─────────────────────────────
//
// Review 55 Wave 4 fixed the Temporal lane's receipts and made `claimFor` a REQUIRED parameter, because an
// optional one carrying identity is one that gets forgotten. It left the OTHER half of the same pair
// optional: `ScoringService.applyJudges`'s eleventh positional argument, `scoringPass`, is what scopes the
// evidence plane the judge seals under.
//
// Two lanes forgot it, and both then wrote receipts naming a plane nothing had sealed:
//
//   INGEST      applyJudges(tenant, dataset, results, judges, undefined, submittedBy)   ← six arguments
//               …seals `judge:<id>`
//               …and its revision writes `judgmentReceiptsFromPlane(results, initialScoringPassId(id), …)`
//               …which names `judge:<id>#initial:<sc>`
//
//   RECOVERY    RecoveryPlanner re-judges an adopted result with ten arguments and no scope, so the batch it
//               is recovering seals bare emitters into a revision whose receipts are pass-scoped.
//
// The ingest one is mine: Wave 4 wrote `() => undefined` there under the comment "an ingest judges the pushed
// plane ONCE, in this process, so the pass id alone is the invocation". That is a claim about the JUDGING
// site — and the judging site passes no pass id at all. Fourth instance of a comment promising another
// component's behaviour, which is now a rule.
//
// The fix is the one the last review already proved out: make the parameter REQUIRED so the compiler asks
// every lane, and derive both sides of the join from one place. These assertions are what makes the pairing
// checkable rather than a convention — the structural arm is the one that fails when a NEW lane forgets.

const SCORECARD_ID = "sc-1";

const results = [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "j1", metric: "judge:j1", value: 1, pass: true }],
  },
] as never;

// RED as of 2931081c, observed:
//   a lane judges without saying under what pass: expected [ '…applyJudges(tenant, effectiveDataset, …' ] to
//   have a length of 0 but got 1
describe("[R56 WAVE-E COUNTEREXAMPLE #6 — CLOSED] a judging lane names the pass it seals under", () => {
  it("agrees with its own receipts: the emitter sealed IS the emitter named", () => {
    // The join, stated once. A lane that passes `{ passId }` seals `judge:<id>#<passId>`, and its receipts —
    // built with no per-invocation claim — name exactly that. This is the property the two lanes below broke
    // by passing no scope at all, which seals `judge:<id>` and names `judge:<id>#<passId>`.
    const passId = initialScoringPassId(SCORECARD_ID);
    const sealed = judgeEvidenceEmitter("j1", { passId });
    const named = judgmentReceiptsFromPlane(results, passId, () => undefined).map((r) => r.evidenceEmitter);
    expect(named).toEqual([sealed]);
    // …and the scopeless seal is a DIFFERENT plane, which is what made the mismatch invisible: both strings
    // are well-formed and only a join notices.
    expect(judgeEvidenceEmitter("j1")).not.toBe(sealed);
  });

  it("has no lane calling applyJudges without a pass scope", () => {
    // The structural arm, and the one that survives the next lane. `scoringPass` is the last parameter, so a
    // call that omits it is a call whose argument list ends before it — matched on the source rather than the
    // types because the point is to fail loudly at review time, with the file named.
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    for (const relative of [
      "scorecard/scorecard-ingest-service.ts",
      "scorecard/recovery-planner.ts",
      "scorecard/workflow-batch-driver.ts",
      "scorecard/retry-failed-batch.ts",
      "scorecard/scorecard-score-service.ts",
    ]) {
      const source = readFileSync(join(root, relative), "utf8");
      // Each `applyJudges(` call, up to its closing `);` — enough to see whether a scope rides it.
      for (const call of source.split("applyJudges(").slice(1)) {
        const body = call.slice(0, call.indexOf("\n    );") + 1 || call.indexOf(");") + 1);
        if (!/passId/.test(body)) offenders.push(`${relative}: ${body.split("\n")[0]?.trim()}`);
      }
    }
    expect(
      offenders,
      "a lane judges without saying under what pass, so its evidence seals under a name its receipts do not use",
    ).toEqual([]);
  });
});
