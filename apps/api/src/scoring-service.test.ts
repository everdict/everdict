import type { CaseResult, Dataset, GradeContext, JudgeSpec, Placement, Score } from "@everdict/core";
import { InMemoryJudgeRegistry } from "@everdict/registry";
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
    expect(results[0]?.scores).toHaveLength(1); // 원본 grader 점수만
    expect(await scoring.collectJudgeModels("acme", [], undefined)).toEqual([]);
  });
});

// ── 케이스 스트리밍/병렬 채점 — docs/architecture/streaming-case-pipeline.md D1 ──

const JUDGE = (id: string): JudgeSpec => ({
  kind: "model",
  id,
  version: "1.0.0",
  provider: "anthropic",
  model: "claude-opus-4-8",
  rubric: "good?",
  inputs: ["trace"],
  tags: [],
});

const resultFor = (caseId: string): CaseResult => ({ ...result(), caseId });

const datasetWith = (...caseIds: string[]): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: caseIds.map((id) => ({
    id,
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  })),
  tags: [],
});

describe("ScoringService — 케이스 스트리밍/병렬 judge 적용", () => {
  it("applyJudges: 케이스 축으로 병렬 실행된다(두 케이스가 동시에 in-flight — 직렬이면 이 테스트는 행)", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    // 두 케이스의 judge 호출이 서로를 기다리는 rendezvous — 직렬(await 한 번에 하나)이면 영원히 못 만난다.
    let arrived = 0;
    let releaseAll: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const judgeRunner: JudgeRunner = {
      async run(spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<Score> {
        arrived += 1;
        if (arrived === 2) releaseAll();
        await bothArrived; // 다른 케이스의 judge 가 시작될 때까지 대기
        return { graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true, detail: ctx.case.id };
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner, caseConcurrency: 2 });
    const results = [resultFor("c1"), resultFor("c2")];

    await scoring.applyJudges("acme", datasetWith("c1", "c2"), results, [{ id: "j", version: "latest" }]);

    expect(results[0]?.scores.some((s) => s.metric === "judge:j")).toBe(true);
    expect(results[1]?.scores.some((s) => s.metric === "judge:j")).toBe(true);
  }, 5000);

  it("케이스 내 judge 점수 순서는 선택 순서 그대로 결정적이다(병렬은 케이스 축에서만)", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j1"));
    await judges.register("acme", JUDGE("j2"));
    const judgeRunner: JudgeRunner = {
      async run(spec: JudgeSpec): Promise<Score> {
        return { graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true };
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [resultFor("c1")];

    await scoring.applyJudges("acme", datasetWith("c1"), results, [
      { id: "j1", version: "latest" },
      { id: "j2", version: "latest" },
    ]);

    const judgeMetrics = results[0]?.scores.filter((s) => s.metric.startsWith("judge:")).map((s) => s.metric);
    expect(judgeMetrics).toEqual(["judge:j1", "judge:j2"]);
  });

  it("createJudgeStream: 데이터셋에 없는 caseId 는 스킵되고, settle 은 태스크 에러를 다시 던진다", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    const seen: string[] = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<Score> {
        seen.push(ctx.case.id);
        if (ctx.case.id === "boom") throw new Error("judge 폭발");
        return { graderId: "j", metric: "judge:j", value: 1, pass: true };
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const stream = await scoring.createJudgeStream("acme", datasetWith("c1", "boom"), [{ id: "j", version: "latest" }]);

    stream.push(resultFor("unknown")); // 데이터셋에 없음 — 발사 안 됨
    stream.push(resultFor("c1"));
    stream.push(resultFor("boom"));

    await expect(stream.settle()).rejects.toThrow("judge 폭발");
    expect(seen).not.toContain("unknown");
    expect(seen).toContain("c1");
  });

  it("judge 미선택이면 no-op 스트림(push 무시·settle 즉시 완료)", async () => {
    const scoring = new ScoringService({});
    const stream = await scoring.createJudgeStream("acme", datasetWith("c1"), []);
    stream.push(resultFor("c1"));
    await stream.settle(); // 던지지 않고 즉시 완료
  });
});
