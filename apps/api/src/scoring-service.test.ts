import type { CaseResult, Dataset, GradeContext, JudgeSpec, Placement, Score } from "@assay/core";
import { InMemoryJudgeRegistry, InMemoryMetricRegistry } from "@assay/registry";
import { describe, expect, it } from "vitest";
import type { JudgeRunner } from "./judge-runner.js";
import { ScoringService } from "./scoring-service.js";

const DATASET: Dataset = {
  id: "d",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
  tags: [],
};

const result = (): CaseResult => ({
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
});

describe("ScoringService — 실행과 분리된 채점 유닛", () => {
  it("applyMetrics: 등록 임계 metric 을 이미 산출된 score 위에 적용해 새 점수를 덧붙인다", async () => {
    const metrics = new InMemoryMetricRegistry();
    await metrics.register("acme", {
      kind: "threshold",
      id: "must-pass",
      version: "1.0.0",
      source: "tests-pass",
      op: "gte",
      threshold: 1,
      tags: [],
    });
    const scoring = new ScoringService({ metrics });
    const results = [result()];
    await scoring.applyMetrics("acme", results, [{ id: "must-pass", version: "latest" }]);
    expect(results[0]?.scores.some((s) => s.metric === "must-pass")).toBe(true);
  });

  it("applyJudges: JudgeRunner 판정 점수를 각 케이스에 덧붙인다(fake runner)", async () => {
    const judges = new InMemoryJudgeRegistry();
    const spec: JudgeSpec = {
      kind: "model",
      id: "j",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    };
    await judges.register("acme", spec);
    let seenPlacement: Placement | undefined;
    const judgeRunner: JudgeRunner = {
      async run(_spec: JudgeSpec, _tenant: string, _ctx: GradeContext, placement?: Placement): Promise<Score> {
        seenPlacement = placement;
        return { graderId: "judge:j", metric: "judge", value: 1, pass: true };
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [result()];
    await scoring.applyJudges("acme", DATASET, results, [{ id: "j", version: "latest" }], "nomad-seoul");
    expect(results[0]?.scores.some((s) => s.metric === "judge")).toBe(true);
    expect(seenPlacement?.target).toBe("nomad-seoul"); // runtime co-locate 주입
  });

  it("collectJudgeModels: inline + 등록 model-judge 의 distinct 모델(정렬)", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "j",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-5",
      rubric: "r",
      inputs: ["trace"],
      tags: [],
    });
    const scoring = new ScoringService({ judges });
    const models = await scoring.collectJudgeModels("acme", [{ id: "j", version: "latest" }], {
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(models).toEqual(["claude-opus-4-8", "gpt-5"]);
  });

  it("레지스트리/러너 미설정이면 no-op(채점 미선택과 동일)", async () => {
    const scoring = new ScoringService({});
    const results = [result()];
    await scoring.applyJudges("acme", DATASET, results, [{ id: "j", version: "latest" }]);
    await scoring.applyMetrics("acme", results, [{ id: "m", version: "latest" }]);
    expect(results[0]?.scores).toHaveLength(1); // 원본 grader 점수만
    expect(await scoring.collectJudgeModels("acme", [], undefined)).toEqual([]);
  });
});
