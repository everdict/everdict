import type { AgentJob, CaseResult, Scorecard, Suite } from "@assay/core";
import { describe, expect, it } from "vitest";
import { runSuite } from "./run-suite.js";
import { caseVerdict, diffScorecards, scorecardPassRate, summarizeScorecard } from "./scorecard.js";

function caseResult(caseId: string, harness: string, pass: boolean, steps: number): CaseResult {
  return {
    caseId,
    harness,
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [
      { graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass },
      { graderId: "steps", metric: "tool_calls", value: steps },
    ],
  };
}

const SUITE: Suite = {
  id: "s1",
  harness: { id: "claude-code" },
  cases: [
    { id: "a", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
    { id: "b", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  ],
};

describe("runSuite", () => {
  it("케이스마다 하니스 버전을 붙여 dispatch 하고 Scorecard 로 모은다", async () => {
    const seen: AgentJob[] = [];
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      seen.push(job);
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 3);
    };
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 2 });
    expect(sc.harness).toBe("claude-code@1.0.0");
    expect(sc.results.map((r) => r.caseId).sort()).toEqual(["a", "b"]);
    expect(seen.every((j) => j.harness.version === "1.0.0")).toBe(true);
  });

  it("한 케이스 dispatch 가 던져도 배치를 멈추지 않고 실패 CaseResult 로 기록한다", async () => {
    // Given: 케이스 a 는 던지고 b 는 성공하는 dispatch
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      if (job.evalCase.id === "a") throw new Error("boom");
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 3);
    };
    // When: 스위트를 돌리면
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 2 });
    // Then: 두 케이스 모두 결과가 있고, a 는 error trace + pass:false 로 박제된다
    expect(sc.results.map((r) => r.caseId).sort()).toEqual(["a", "b"]);
    const failed = sc.results.find((r) => r.caseId === "a");
    expect(failed?.harness).toBe("claude-code@1.0.0");
    expect(failed?.trace).toEqual([{ t: 0, kind: "error", message: "boom" }]);
    expect(failed?.scores).toEqual([{ graderId: "dispatch", metric: "error", value: 0, pass: false, detail: "boom" }]);
    expect(caseVerdict(failed ?? { scores: [] })).toBe(false);
    // 성공 케이스는 정상 집계
    expect(caseVerdict(sc.results.find((r) => r.caseId === "b") ?? { scores: [] })).toBe(true);
  });
});

describe("summarizeScorecard", () => {
  it("메트릭별 통과율/평균을 집계한다", () => {
    const sc: Scorecard = {
      suiteId: "s1",
      harness: "h@1",
      results: [caseResult("a", "h@1", true, 2), caseResult("b", "h@1", false, 4)],
    };
    const summary = summarizeScorecard(sc);
    const tests = summary.find((s) => s.metric === "tests_pass");
    expect(tests?.passRate).toBe(0.5);
    const steps = summary.find((s) => s.metric === "tool_calls");
    expect(steps?.mean).toBe(3);
  });
});

describe("diffScorecards", () => {
  it("pass 전이로 회귀/개선을 잡고 메트릭 delta 를 낸다", () => {
    const base: Scorecard = {
      suiteId: "s1",
      harness: "h@1",
      results: [caseResult("a", "h@1", true, 2), caseResult("b", "h@1", false, 5)],
    };
    const cand: Scorecard = {
      suiteId: "s1",
      harness: "h@2",
      results: [caseResult("a", "h@2", false, 3), caseResult("b", "h@2", true, 4)],
    };
    const diff = diffScorecards(base, cand);
    expect(diff.regressions.map((d) => d.caseId)).toEqual(["a"]); // a: pass→fail
    expect(diff.improvements.map((d) => d.caseId)).toEqual(["b"]); // b: fail→pass
    const steps = diff.metrics.find((m) => m.metric === "tool_calls");
    expect(steps?.baselineMean).toBe(3.5);
    expect(steps?.candidateMean).toBe(3.5);
  });
});

describe("caseVerdict (권위 기준)", () => {
  const sc = (scores: { metric: string; pass?: boolean; value?: number }[]): { scores: never } =>
    ({
      scores: scores.map((s) => ({ graderId: s.metric, metric: s.metric, value: s.value ?? 0, pass: s.pass })),
    }) as never;

  it("ground-truth(state)가 judge 를 이긴다 — OSWorld 파일저장: state PASS + judge FAIL → PASS", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "state", pass: true },
          { metric: "judge", pass: false },
        ]),
      ),
    ).toBe(true);
  });
  it("객관(answer_match)이 judge 보다 우선", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "answer_match", pass: false },
          { metric: "judge", pass: true },
        ]),
      ),
    ).toBe(false);
  });
  it("객관 그레이더가 여럿이면 모두 pass 여야", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "url_matches", pass: true },
          { metric: "dom_contains", pass: false },
        ]),
      ),
    ).toBe(false);
  });
  it("객관/ground-truth 없으면 judge 가 결정", () => {
    expect(caseVerdict(sc([{ metric: "judge", pass: true }, { metric: "tool_calls" }]))).toBe(true);
  });
  it("pass 판정 그레이더가 없으면 undefined", () => {
    expect(caseVerdict(sc([{ metric: "tool_calls", value: 5 }]))).toBeUndefined();
  });
  it("scorecardPassRate: 권위 기준 케이스 통과율", () => {
    const card: Scorecard = {
      suiteId: "s",
      harness: "h",
      results: [
        caseResult("a", "h", true, 3), // tests_pass PASS → PASS
        {
          ...caseResult("b", "h", true, 3),
          scores: [
            { graderId: "state", metric: "state", value: 1, pass: true },
            { graderId: "judge", metric: "judge", value: 0, pass: false },
          ],
        }, // state PASS / judge FAIL → PASS
      ],
    };
    expect(scorecardPassRate(card)).toEqual({ pass: 2, total: 2, rate: 1 });
  });
});
