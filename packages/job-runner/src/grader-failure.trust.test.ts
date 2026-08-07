import { runCase } from "@everdict/application-execution";
import type { EvalCase, Grader, MetricSummary, Score } from "@everdict/contracts";
import { isMeasured } from "@everdict/contracts";
import { measurementCoverage, summarizeScorecard } from "@everdict/domain";
import { LocalDriver } from "@everdict/drivers";
import { RepoEnvironment } from "@everdict/environments";
import { ScriptedHarness } from "@everdict/harnesses";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-01 / TRUST-04.
//
// The invariant: NO FAILURE BECOMES A NUMBER. A grader that dies and a grader that returns garbage are two
// different accidents, and neither of them is a score of zero. This runs the REAL loop (LocalDriver spawns a
// real shell, RepoEnvironment seeds and diffs a real git tree, the scripted harness really edits a file) so
// the assertion covers the composed path a nightly must certify — not a hand-built CaseResult.
//
// Why it is a trust test rather than a unit test: safe-grade.test.ts already pins the conversion in
// isolation. What only the composed run can show is that the conversion SURVIVES the loop and that the batch
// aggregate downstream of it still reports the surviving measurement honestly.
const ENABLED = process.env.EVERDICT_TRUST_SUITE === "1";

const HEALTHY_METRIC = "steps-observed";

const evalCase = (id: string): EvalCase => ({
  id,
  env: { kind: "repo", source: { files: { "value.txt": "0\n" } } },
  task: "change the value in value.txt to 42",
  graders: [],
  timeoutSec: 120,
  tags: [],
});

// A grader that dies mid-grade. safeGrade must turn the throw into an UNMEASURED score.
const dyingGrader: Grader = {
  id: "flaky-judge",
  async grade(): Promise<Score> {
    throw new Error("upstream judge returned 503");
  },
};

// A grader that returns a value that is not a number. sanitizeScore must turn it into an INVALID score.
const nanGrader: Grader = {
  id: "ratio",
  async grade(): Promise<Score> {
    return { graderId: "ratio", metric: "ratio", value: Number.NaN, pass: true };
  },
};

// The one grader that actually measures — its number is the only one any aggregate may read.
const healthyGrader: Grader = {
  id: "observed",
  async grade(ctx): Promise<Score> {
    return { graderId: "observed", metric: HEALTHY_METRIC, value: ctx.trace.length, pass: true };
  },
};

const summaryFor = (summaries: MetricSummary[], metric: string): MetricSummary => {
  const found = summaries.find((s) => s.metric === metric);
  if (!found) throw new Error(`no summary for metric ${metric}`);
  return found;
};

describe.skipIf(!ENABLED)(
  "TRUST-01/04 — a dead grader is unmeasured, a broken grader is invalid, neither is a zero",
  () => {
    it("runs three real cases whose judge dies and whose ratio grader returns NaN, and the batch mean stays the mean of what was measured", async () => {
      // Given: three real cases, each graded by one dying grader, one NaN grader and one healthy grader.
      const results = [];
      for (const id of ["trust-1", "trust-2", "trust-3"]) {
        results.push(
          await runCase(evalCase(id), {
            driver: new LocalDriver(),
            environment: new RepoEnvironment(),
            harness: new ScriptedHarness("0.0.0", () => [{ tool: "bash", cmd: "echo 42 > value.txt" }]),
            graders: [dyingGrader, nanGrader, healthyGrader],
            runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
          }),
        );
      }

      // Then: the dead grader produced a non-measurement carrying WHY, and no `value` field at all.
      for (const result of results) {
        const dead = result.scores.find((s) => s.graderId === "flaky-judge");
        if (dead === undefined) throw new Error("the dying grader produced no score at all");
        expect(isMeasured(dead)).toBe(false);
        expect(dead.status).toBe("unmeasured");
        expect(Object.hasOwn(dead, "value")).toBe(false);

        const broken = result.scores.find((s) => s.graderId === "ratio");
        if (broken === undefined) throw new Error("the NaN grader produced no score at all");
        expect(isMeasured(broken)).toBe(false);
        expect(broken.status).toBe("invalid");
        expect(Object.hasOwn(broken, "value")).toBe(false);
      }

      // Then: the batch aggregate. The healthy metric keeps its own mean; the two broken metrics have NO mean
      // (a metric nobody measured has no average — 0 there would crown a dead grader on a lower-is-better board).
      const summaries = summarizeScorecard({ suiteId: "trust", harness: "scripted@0.0.0", results });
      const healthy = summaryFor(summaries, HEALTHY_METRIC);
      expect(healthy.count).toBe(3);
      expect(healthy.mean).toBeGreaterThan(0);
      expect(healthy.unmeasured).toBeUndefined();

      for (const metric of ["flaky-judge", "ratio"]) {
        const dead = summaryFor(summaries, metric);
        expect(dead.count).toBe(0);
        expect(dead.mean).toBeUndefined();
        expect(dead.unmeasured).toBe(3);
      }

      // Then: the batch STATES how hollow it is. Every surviving number is real; there are just two thirds
      // fewer of them than were asked for, and a release gate reads that ratio as an input rather than a
      // footnote.
      const coverage = measurementCoverage({ results });
      expect(coverage.scores).toBe(9);
      expect(coverage.unmeasured).toBe(6);
      expect(coverage.unmeasuredFraction).toBeCloseTo(2 / 3);
    });
  },
);
