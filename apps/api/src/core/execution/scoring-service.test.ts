import type { JudgeInvocation } from "@everdict/application-control";
import { ScoringService } from "@everdict/application-control";
import type { CaseResult, Dataset, GradeContext, JudgeSpec, Placement, Score } from "@everdict/contracts";
import { InMemoryJudgeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import type { JudgeRunner } from "./judge-runner.js";

// The judge port answers an INVOCATION now — the verdict plus whether the judge's own execution could be
// sealed as evidence (arch-review 58 follow-through). These fakes are about the verdict and have no
// trajectory to seal into, which is exactly what `not_applicable` means. A fake that still answered a bare
// array would be LESS capable than the port it stands in for.
const judgeInvocation = (scores: unknown) => ({ scores, evidence: "not_applicable" }) as never;

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
      async run(
        _spec: JudgeSpec,
        _tenant: string,
        _ctx: GradeContext,
        placement?: Placement,
      ): Promise<JudgeInvocation> {
        seenPlacement = placement;
        return judgeInvocation([{ graderId: "judge:j", metric: "judge", value: 1, pass: true }]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [result()];
    await scoring.applyJudges(
      "acme",
      DATASET,
      results,
      [{ id: "j", version: "latest" }],
      "nomad-seoul",
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
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
      ): Promise<JudgeInvocation> {
        seenSubmittedBy = submittedBy;
        return judgeInvocation([{ graderId: "j", metric: "judge:j", value: 1, pass: true }]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [result()];
    await scoring.applyJudges(
      "acme",
      DATASET,
      results,
      [{ id: "j", version: "latest" }],
      "self:r-123",
      "user-alice",
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    expect(seenSubmittedBy).toBe("user-alice");
  });

  it("applyJudges: resolves each case's child run id (trial-aware) and threads it to the runner", async () => {
    // Regression: the runner seals the judge's own execution as a judge:<id> plane on the judged case's child run —
    // without the runId the evidence has nowhere to land (metering still happens). The resolver is trial-aware
    // because caseId alone is ambiguous under trials.
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    const seenRunIds: Array<string | undefined> = [];
    const judgeRunner: JudgeRunner = {
      async run(
        _spec: JudgeSpec,
        _tenant: string,
        _ctx: GradeContext,
        _placement?: Placement,
        _submittedBy?: string,
        runId?: string,
      ): Promise<JudgeInvocation> {
        seenRunIds.push(runId);
        return judgeInvocation([{ graderId: "j", metric: "judge:j", value: 1, pass: true }]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results: CaseResult[] = [result(), { ...result(), trial: 1 }];
    await scoring.applyJudges(
      "acme",
      DATASET,
      results,
      [{ id: "j", version: "latest" }],
      undefined,
      undefined,
      (caseId, trial) => `run-${caseId}#${trial ?? 0}`,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    expect(seenRunIds.sort()).toEqual(["run-c1#0", "run-c1#1"]);
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
    await scoring.applyJudges(
      "acme",
      DATASET,
      results,
      [{ id: "j", version: "latest" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
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
      async run(spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<JudgeInvocation> {
        arrived += 1;
        if (arrived === 2) releaseAll();
        await bothArrived; // wait until the other case's judge has started
        return judgeInvocation([
          { graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true, detail: ctx.case.id },
        ]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner, caseConcurrency: 2 });
    const results = [resultFor("c1"), resultFor("c2")];

    await scoring.applyJudges(
      "acme",
      datasetWith("c1", "c2"),
      results,
      [{ id: "j", version: "latest" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );

    expect(results[0]?.scores.some((s) => s.metric === "judge:j")).toBe(true);
    expect(results[1]?.scores.some((s) => s.metric === "judge:j")).toBe(true);
  }, 5000);

  it("within a case, judge score order is deterministic in selection order (parallelism is on the case axis only)", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j1"));
    await judges.register("acme", JUDGE("j2"));
    const judgeRunner: JudgeRunner = {
      async run(spec: JudgeSpec): Promise<JudgeInvocation> {
        return judgeInvocation([{ graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true }]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const results = [resultFor("c1")];

    await scoring.applyJudges(
      "acme",
      datasetWith("c1"),
      results,
      [
        { id: "j1", version: "latest" },
        { id: "j2", version: "latest" },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );

    const judgeMetrics = results[0]?.scores.filter((s) => s.metric.startsWith("judge:")).map((s) => s.metric);
    expect(judgeMetrics).toEqual(["judge:j1", "judge:j2"]);
  });

  it("createJudgeStream: a caseId not in the dataset is skipped, and settle re-throws a task error", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    const seen: string[] = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<JudgeInvocation> {
        seen.push(ctx.case.id);
        if (ctx.case.id === "boom") throw new Error("judge boom");
        return judgeInvocation([{ graderId: "j", metric: "judge:j", value: 1, pass: true }]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const stream = await scoring.createJudgeStream(
      "acme",
      datasetWith("c1", "boom"),
      [{ id: "j", version: "latest" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );

    stream.push(resultFor("unknown")); // not in the dataset — not fired
    stream.push(resultFor("c1"));
    stream.push(resultFor("boom"));

    await expect(stream.settle()).rejects.toThrow("judge boom");
    expect(seen).not.toContain("unknown");
    expect(seen).toContain("c1");
  });

  it("with no judge selected, a no-op stream (push ignored · settle completes immediately)", async () => {
    const scoring = new ScoringService({});
    const stream = await scoring.createJudgeStream(
      "acme",
      datasetWith("c1"),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    stream.push(resultFor("c1"));
    await stream.settle(); // completes immediately without throwing
  });

  // A pre-trace failure carries a classified `failure` — the judge has no produced outcome to grade.
  const failedResultFor = (caseId: string): CaseResult => ({
    ...resultFor(caseId),
    trace: [{ t: 0, kind: "error", message: "dispatch died" }],
    scores: [],
    failure: { stage: "dispatch", class: "infra", code: "UPSTREAM_ERROR", message: "died", retryable: false },
  });

  it("createJudgeStream: a pre-trace failure is skipped (no judge call, no spurious score) and counted in stats", async () => {
    // Regression: a case that died at/before dispatch was still pushed through the judge, so the model judge burned
    // provider tokens on an error-only trace AND attached a spurious judge:<id> score, while the phase said "judges
    // applied". The judge is downstream of a produced outcome — skip failures, judge only real outcomes, count both.
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    const judged: string[] = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec: JudgeSpec, _t: string, ctx: GradeContext): Promise<JudgeInvocation> {
        judged.push(ctx.case.id);
        return judgeInvocation([{ graderId: "judge:j", metric: "judge", value: 1, pass: true }]);
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const ok = resultFor("c1");
    const failed = failedResultFor("c2");
    const stream = await scoring.createJudgeStream(
      "acme",
      datasetWith("c1", "c2"),
      [{ id: "j", version: "latest" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    await stream.push(ok);
    await stream.push(failed);
    await stream.settle();

    expect(judged).toEqual(["c1"]); // only the gradeable case reached the judge
    expect(failed.scores.some((s) => s.metric === "judge")).toBe(false); // no spurious judge score on the failure
    expect(stream.stats()).toEqual({ pushed: 2, gradeable: 1, skipped: 1 });
  });

  it("createJudgeStream: judge starvation — every case failed pre-trace → 0 gradeable, judge never runs", async () => {
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", JUDGE("j"));
    const judgeRunner: JudgeRunner = {
      async run(): Promise<JudgeInvocation> {
        throw new Error("judge must not run on a pre-trace failure");
      },
    };
    const scoring = new ScoringService({ judges, judgeRunner });
    const stream = await scoring.createJudgeStream(
      "acme",
      datasetWith("c1"),
      [{ id: "j", version: "latest" }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { passId: "pass-test" },
    );
    await stream.push(failedResultFor("c1"));
    await stream.settle(); // must not throw — the judge never ran
    expect(stream.stats()).toEqual({ pushed: 1, gradeable: 0, skipped: 1 });
  });
});
