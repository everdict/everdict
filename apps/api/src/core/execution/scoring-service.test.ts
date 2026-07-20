import { ScoringService } from "@everdict/application-control";
import type { CaseResult, Dataset, GradeContext, JudgeSpec, Placement, Score } from "@everdict/contracts";
import { InMemoryJudgeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import type { JudgeRunner } from "./judge-runner.js";

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

describe("ScoringService — scoring unit decoupled from execution", () => {
  it("applyJudges: appends the JudgeRunner's verdict score to each case (fake runner)", async () => {
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
      async run(_spec: JudgeSpec, _tenant: string, _ctx: GradeContext, placement?: Placement): Promise<Score[]> {
        seenPlacement = placement;
        return [{ graderId: "judge:j", metric: "judge", value: 1, pass: true }];
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [result()];
    await scoring.applyJudges("acme", DATASET, results, [{ id: "j", version: "latest" }], "nomad-seoul");
    expect(results[0]?.scores.some((s) => s.metric === "judge")).toBe(true);
    expect(seenPlacement?.target).toBe("nomad-seoul"); // runtime co-locate injection
  });

  it("applyJudges: threads the submitter to the runner so a code/harness judge owns its co-located self:<runnerId> dispatch", async () => {
    // Regression: the wrapper job a code/harness judge dispatches inherits the run's self:<runnerId> placement, and
    // RuntimeDispatcher resolves that runner's owner from submittedBy. When applyJudges dropped submittedBy, the
    // wrapper dispatched with owner=undefined → "Self-hosted runner not found" → every code judge on a self-hosted
    // scorecard silently skipped. Assert the submitter reaches JudgeRunner.run.
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    let seenSubmittedBy: string | undefined = "UNSET";
    const judgeRunner: JudgeRunner = {
      async run(
        _spec: JudgeSpec,
        _tenant: string,
        _ctx: GradeContext,
        _placement?: Placement,
        submittedBy?: string,
      ): Promise<Score[]> {
        seenSubmittedBy = submittedBy;
        return [{ graderId: "j", metric: "judge:j", value: 1, pass: true }];
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [result()];
    await scoring.applyJudges("acme", DATASET, results, [{ id: "j", version: "latest" }], "self:r-123", "user-alice");
    expect(seenSubmittedBy).toBe("user-alice");
  });

  it("collectJudgeModels: distinct models of inline + registered model-judges (sorted)", async () => {
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

  it("with no registry/runner configured it is a no-op (same as selecting no scoring)", async () => {
    const scoring = new ScoringService({});
    const results = [result()];
    await scoring.applyJudges("acme", DATASET, results, [{ id: "j", version: "latest" }]);
    expect(results[0]?.scores).toHaveLength(1); // only the original grader score
    expect(await scoring.collectJudgeModels("acme", [], undefined)).toEqual([]);
  });
});

// ── case streaming / parallel scoring — docs/architecture/streaming-case-pipeline.md D1 ──

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

describe("ScoringService — case streaming / parallel judge application", () => {
  it("applyJudges: runs in parallel across the case axis (two cases in-flight at once — a serial impl would hang this test)", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    // a rendezvous where the two cases' judge calls wait for each other — serial (one await at a time) never meets.
    let arrived = 0;
    let releaseAll: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const judgeRunner: JudgeRunner = {
      async run(spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<Score[]> {
        arrived += 1;
        if (arrived === 2) releaseAll();
        await bothArrived; // wait until the other case's judge has started
        return [{ graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true, detail: ctx.case.id }];
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner, caseConcurrency: 2 });
    const results = [resultFor("c1"), resultFor("c2")];

    await scoring.applyJudges("acme", datasetWith("c1", "c2"), results, [{ id: "j", version: "latest" }]);

    expect(results[0]?.scores.some((s) => s.metric === "judge:j")).toBe(true);
    expect(results[1]?.scores.some((s) => s.metric === "judge:j")).toBe(true);
  }, 5000);

  it("within a case, judge score order is deterministic in selection order (parallelism is on the case axis only)", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j1"));
    await judges.register("acme", JUDGE("j2"));
    const judgeRunner: JudgeRunner = {
      async run(spec: JudgeSpec): Promise<Score[]> {
        return [{ graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true }];
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

  it("createJudgeStream: a caseId not in the dataset is skipped, and settle re-throws a task error", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    const seen: string[] = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<Score[]> {
        seen.push(ctx.case.id);
        if (ctx.case.id === "boom") throw new Error("judge boom");
        return [{ graderId: "j", metric: "judge:j", value: 1, pass: true }];
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const stream = await scoring.createJudgeStream("acme", datasetWith("c1", "boom"), [{ id: "j", version: "latest" }]);

    stream.push(resultFor("unknown")); // not in the dataset — not fired
    stream.push(resultFor("c1"));
    stream.push(resultFor("boom"));

    await expect(stream.settle()).rejects.toThrow("judge boom");
    expect(seen).not.toContain("unknown");
    expect(seen).toContain("c1");
  });

  it("with no judge selected, a no-op stream (push ignored · settle completes immediately)", async () => {
    const scoring = new ScoringService({});
    const stream = await scoring.createJudgeStream("acme", datasetWith("c1"), []);
    stream.push(resultFor("c1"));
    await stream.settle(); // completes immediately without throwing
  });
});
