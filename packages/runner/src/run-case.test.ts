import type {
  ComputeHandle,
  Driver,
  EnvSnapshot,
  Environment,
  EvalCase,
  EvaluableHarness,
  GradeContext,
  Grader,
  Score,
} from "@everdict/core";
import { LocalDriver } from "@everdict/drivers";
import { RepoEnvironment } from "@everdict/environments";
import { TestsPassGrader, costGrader, stepsGrader } from "@everdict/graders";
import { ScriptedHarness } from "@everdict/harnesses";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

describe("runCase — real harness execution → trace → scoring (full loop)", () => {
  it("when the scripted harness fixes the bug, the tests-pass grader passes", async () => {
    const evalCase: EvalCase = {
      id: "demo-1",
      env: {
        kind: "repo",
        source: {
          files: {
            "value.txt": "0\n",
            "check.sh": 'test "$(cat value.txt)" = "42"\n',
          },
        },
      },
      task: "change the value in value.txt to 42",
      graders: [{ id: "tests-pass", config: { cmd: "sh check.sh" } }, { id: "steps" }, { id: "cost" }],
      timeoutSec: 120,
      tags: [],
    };

    const result = await runCase(evalCase, {
      driver: new LocalDriver(),
      environment: new RepoEnvironment(),
      // The harness takes the task and runs a real command on compute.
      harness: new ScriptedHarness("0.0.0", () => [{ tool: "bash", cmd: "echo 42 > value.txt" }]),
      graders: [new TestsPassGrader("sh check.sh"), stepsGrader, costGrader],
      runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
    });

    if (result.snapshot.kind !== "repo") throw new Error("expected a repo snapshot");
    // Eyeball the artifacts from the real run (the test doubles as a demo).
    console.log(`\n=== TRACE ===\n${result.trace.map((e) => JSON.stringify(e)).join("\n")}`);
    console.log(`\n=== SCORES ===\n${result.scores.map((s) => JSON.stringify(s)).join("\n")}`);
    console.log(`\n=== DIFF ===\n${result.snapshot.diff}`);

    expect(result.harness).toBe("scripted@0.0.0");
    const pass = result.scores.find((s) => s.graderId === "tests-pass");
    expect(pass?.pass).toBe(true);
    const steps = result.scores.find((s) => s.graderId === "steps");
    expect(steps?.value).toBeGreaterThan(0);
    expect(result.snapshot.changedFiles).toContain("value.txt");
  });
});

// ── Early compute release — observation-only graders score after the sandbox is released ──
// docs/architecture/streaming-case-pipeline.md D3

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

function fakeCompute(overrides: Partial<ComputeHandle> = {}): ComputeHandle & { disposed: boolean } {
  const handle = {
    disposed: false,
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {
      handle.disposed = true;
    },
    ...overrides,
  };
  return handle;
}

function fakeDeps(compute: ComputeHandle, snapshot: EnvSnapshot, graders: Grader[]) {
  const driver: Driver = { id: "fake", provision: async () => compute };
  const environment: Environment = { kind: snapshot.kind, seed: async () => {}, snapshot: async () => snapshot };
  const harness: EvaluableHarness = {
    id: "fake",
    version: "0",
    install: async () => {},
    async *run() {}, // Fake harness with no trace (no yield)
  };
  return { driver, environment, harness, graders, runCtx: { apiKeyEnv: {}, timeoutSec: 60 } };
}

const REPO_SNAPSHOT: EnvSnapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" };

describe("runCase — early compute release (observation-only graders score after the sandbox is released)", () => {
  it("needsCompute graders score before release (with compute); undeclared graders score after release (without compute); score order preserves the grader array order", async () => {
    const compute = fakeCompute();
    const seen: Array<{ id: string; disposedAtGrade: boolean; hadCompute: boolean }> = [];
    const grader = (id: string, needsCompute?: boolean): Grader => ({
      id,
      ...(needsCompute ? { needsCompute } : {}),
      async grade(ctx: GradeContext): Promise<Score> {
        seen.push({ id, disposedAtGrade: compute.disposed, hadCompute: ctx.compute !== undefined });
        return { graderId: id, metric: id, value: 1, pass: true };
      },
    });
    // Put the observation-only grader first, to also verify that "order preservation" is independent of scoring time.
    const graders = [grader("trace-only"), grader("outcome", true)];

    const result = await runCase(CASE, fakeDeps(compute, REPO_SNAPSHOT, graders));

    // Compute-bound graders score before release holding compute; observation-only graders score after release without compute.
    expect(seen).toEqual([
      { id: "outcome", disposedAtGrade: false, hadCompute: true },
      { id: "trace-only", disposedAtGrade: true, hadCompute: false },
    ]);
    // The score array keeps the grader array order.
    expect(result.scores.map((s) => s.graderId)).toEqual(["trace-only", "outcome"]);
    expect(compute.disposed).toBe(true);
  });

  it("an os-use ref-only screenshot is materialized before release and included only in the scoring snapshot (the stored snapshot keeps the ref)", async () => {
    const compute = fakeCompute({
      async exec(cmd: string) {
        // materialize's base64 capture command — if called after release, the disposed check (not this fake) catches it.
        expect(cmd).toContain("base64");
        expect(compute.disposed).toBe(false);
        return { exitCode: 0, stdout: "UE5H\n", stderr: "" };
      },
    });
    const osUse: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/shot.png", screenshot: "", windows: [] };
    let judged: EnvSnapshot | undefined;
    const vlmJudge: Grader = {
      id: "judge",
      async grade(ctx: GradeContext): Promise<Score> {
        judged = ctx.snapshot;
        return { graderId: "judge", metric: "judge", value: 1, pass: true };
      },
    };

    const result = await runCase(CASE, fakeDeps(compute, osUse, [vlmJudge]));

    // The scoring context includes the materialized base64 screenshot (so the VLM judge can use it even after release).
    expect(judged?.kind === "os-use" && judged.screenshot).toBe("UE5H");
    // The stored snapshot (CaseResult) stays ref-only as before — no record bloat.
    expect(result.snapshot.kind === "os-use" && result.snapshot.screenshot).toBe("");
  });

  it("a platform trace (collect=job) is collected via collectTrace(runId) after compute release, and the observation grader sees it", async () => {
    const compute = fakeCompute();
    let collectedAt: { disposed: boolean; runId: string } | undefined;
    const harness: EvaluableHarness = {
      id: "cmd",
      version: "1",
      install: async () => {},
      // Fake — emits the injected runId as a single event
      async *run(_c, _t, runCtx) {
        yield { t: 0, kind: "message", role: "assistant", text: runCtx.runId ?? "no-run-id" };
      },
      traceSource: () => ({ kind: "otel", endpoint: "http://collector", collect: "job" }),
      async collectTrace(runId) {
        collectedAt = { disposed: compute.disposed, runId };
        return [{ t: 1, kind: "llm_call", model: "m" }];
      },
    };
    let seenTraceLen = 0;
    const traceOnly: Grader = {
      id: "steps",
      async grade(gradeCtx: GradeContext): Promise<Score> {
        seenTraceLen = gradeCtx.trace.length;
        return { graderId: "steps", metric: "steps", value: gradeCtx.trace.length, pass: true };
      },
    };
    const deps = { ...fakeDeps(compute, REPO_SNAPSHOT, [traceOnly]), harness };

    const result = await runCase(CASE, deps);

    // The pull happens after release (sandbox not held during the flush delay) + correlates by the same runId injected into run.
    expect(collectedAt?.disposed).toBe(true);
    const injected = result.trace.find((e) => e.kind === "message");
    expect(injected && "text" in injected && injected.text).toBe(collectedAt?.runId);
    // The observation grader sees the collected platform events too (1 run event + 1 platform).
    expect(seenTraceLen).toBe(2);
    expect(result.traceRef).toBeUndefined(); // job collection — nothing deferred
  });

  it("with collect=control-plane, defer collection and observation scoring entirely and just carry traceRef (the job ends at execution)", async () => {
    const compute = fakeCompute();
    let pulled = false;
    const harness: EvaluableHarness = {
      id: "cmd",
      version: "1",
      install: async () => {},
      async *run() {},
      traceSource: () => ({ kind: "mlflow", endpoint: "http://mlflow", collect: "control-plane" }),
      async collectTrace() {
        pulled = true;
        return [];
      },
    };
    let observationGraded = false;
    const graders: Grader[] = [
      {
        id: "outcome",
        needsCompute: true,
        async grade(): Promise<Score> {
          return { graderId: "outcome", metric: "outcome", value: 1, pass: true };
        },
      },
      {
        id: "steps",
        async grade(): Promise<Score> {
          observationGraded = true;
          return { graderId: "steps", metric: "steps", value: 0 };
        },
      },
    ];
    const deps = { ...fakeDeps(compute, REPO_SNAPSHOT, graders), harness };

    const result = await runCase(CASE, deps);

    expect(pulled).toBe(false); // no pull inside the job — that's the control plane's job
    expect(observationGraded).toBe(false); // observation scoring is deferred too (no trace here, so running it would score wrong)
    expect(result.scores.map((s) => s.graderId)).toEqual(["outcome"]); // only ground-truth scores from the job
    expect(result.traceRef?.kind).toBe("mlflow");
    expect(result.traceRef?.endpoint).toBe("http://mlflow");
    expect(typeof result.traceRef?.runId).toBe("string"); // the correlation key injected into run is carried verbatim
    expect(compute.disposed).toBe(true);
  });

  it("isolates a grader that throws — the case survives with a visible error score, sibling graders still score, and compute is released exactly once", async () => {
    // Given: a throwing grader (a transient judge LLM hiccup) alongside a healthy one
    let disposeCount = 0;
    const compute = fakeCompute({
      async dispose() {
        disposeCount += 1;
      },
    });
    const failing: Grader = {
      id: "judge",
      async grade(): Promise<Score> {
        throw new Error("judge upstream 503");
      },
    };
    const healthy: Grader = {
      id: "steps",
      async grade(): Promise<Score> {
        return { graderId: "steps", metric: "tool_calls", value: 3, pass: true };
      },
    };

    // When: the case is graded — the throw must NOT propagate out of runCase.
    // (Pre-fix this rejected, dropping the whole case + the healthy grader's real score.)
    const result = await runCase(CASE, fakeDeps(compute, REPO_SNAPSHOT, [failing, healthy]));

    // Then: the throw becomes a visible error score (pass undefined → excluded from passRate, not a false FAIL),
    // the sibling score is intact, and the grader-array order is preserved.
    expect(result.scores.map((s) => s.graderId)).toEqual(["judge", "steps"]);
    const judge = result.scores.find((s) => s.graderId === "judge");
    expect(judge?.pass).toBeUndefined();
    expect(judge?.detail).toContain("judge upstream 503");
    expect(result.scores.find((s) => s.graderId === "steps")?.pass).toBe(true);
    // And compute is still released exactly once (finally is a no-op after early release — no double dispose).
    expect(disposeCount).toBe(1);
  });
});
