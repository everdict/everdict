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

describe("runCase — 실제 하니스 실행 → 트레이스 → 채점 (전체 루프)", () => {
  it("스크립트 하니스가 버그를 고치면 tests-pass 그레이더가 통과한다", async () => {
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
      task: "value.txt 의 값을 42 로 고쳐줘",
      graders: [{ id: "tests-pass", config: { cmd: "sh check.sh" } }, { id: "steps" }, { id: "cost" }],
      timeoutSec: 120,
      tags: [],
    };

    const result = await runCase(evalCase, {
      driver: new LocalDriver(),
      environment: new RepoEnvironment(),
      // 하니스가 task를 받아 compute에서 실제 명령을 실행한다.
      harness: new ScriptedHarness("0.0.0", () => [{ tool: "bash", cmd: "echo 42 > value.txt" }]),
      graders: [new TestsPassGrader("sh check.sh"), stepsGrader, costGrader],
      runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
    });

    if (result.snapshot.kind !== "repo") throw new Error("repo 스냅샷이 기대됨");
    // 실제 실행에서 나온 산출물을 눈으로 확인 (테스트가 곧 데모).
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

// ── compute 조기 해제 — 관측물 전용 grader 는 샌드박스 반납 후 채점 ──
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
    async *run() {}, // 트레이스 없는 페이크 하니스(yield 없음)
  };
  return { driver, environment, harness, graders, runCtx: { apiKeyEnv: {}, timeoutSec: 60 } };
}

const REPO_SNAPSHOT: EnvSnapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" };

describe("runCase — compute 조기 해제(관측물 전용 grader 는 샌드박스 반납 후 채점)", () => {
  it("needsCompute grader 는 해제 전(compute 동봉)·미선언 grader 는 해제 후(compute 없음) 채점되고 점수 순서는 grader 배열 순서를 유지한다", async () => {
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
    // 관측물 전용 grader 를 앞에 둬서 "순서 유지"가 채점 시점과 독립임을 같이 검증한다.
    const graders = [grader("trace-only"), grader("outcome", true)];

    const result = await runCase(CASE, fakeDeps(compute, REPO_SNAPSHOT, graders));

    // compute-바운드는 해제 전에 compute 를 들고 채점, 관측물 전용은 해제 후 compute 없이 채점.
    expect(seen).toEqual([
      { id: "outcome", disposedAtGrade: false, hadCompute: true },
      { id: "trace-only", disposedAtGrade: true, hadCompute: false },
    ]);
    // 점수 배열은 grader 배열 순서 그대로.
    expect(result.scores.map((s) => s.graderId)).toEqual(["trace-only", "outcome"]);
    expect(compute.disposed).toBe(true);
  });

  it("os-use ref-only 스크린샷은 해제 전에 물질화되어 채점 스냅샷에만 동봉된다(저장 스냅샷은 ref 그대로)", async () => {
    const compute = fakeCompute({
      async exec(cmd: string) {
        // materialize 의 base64 캡처 명령 — 해제 후 호출되면 이 페이크가 아니라 disposed 검증에서 걸린다.
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

    // 채점 컨텍스트에는 물질화된 base64 스크린샷이 동봉된다(해제 후에도 VLM judge 가 쓸 수 있게).
    expect(judged?.kind === "os-use" && judged.screenshot).toBe("UE5H");
    // 저장 스냅샷(CaseResult)은 현행대로 ref-only — 레코드 비대 없음.
    expect(result.snapshot.kind === "os-use" && result.snapshot.screenshot).toBe("");
  });

  it("플랫폼 트레이스(collect=job)는 compute 해제 후 collectTrace(runId) 로 수집되고 관측물 grader 가 그걸 본다", async () => {
    const compute = fakeCompute();
    let collectedAt: { disposed: boolean; runId: string } | undefined;
    const harness: EvaluableHarness = {
      id: "cmd",
      version: "1",
      install: async () => {},
      // 페이크 — 주입된 runId 를 하나의 이벤트로 방출
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

    // pull 은 해제 후(플러시 지연 동안 샌드박스 미점유) + run 에 주입된 runId 와 같은 키로 상관.
    expect(collectedAt?.disposed).toBe(true);
    const injected = result.trace.find((e) => e.kind === "message");
    expect(injected && "text" in injected && injected.text).toBe(collectedAt?.runId);
    // 관측물 grader 는 수집된 플랫폼 이벤트까지 본다(run 이벤트 1 + 플랫폼 1).
    expect(seenTraceLen).toBe(2);
    expect(result.traceRef).toBeUndefined(); // job 수집 — 미룸 없음
  });

  it("collect=control-plane 이면 수집·관측물 채점을 통째로 미루고 traceRef 만 실어 보낸다(잡=실행에서 끝)", async () => {
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

    expect(pulled).toBe(false); // 잡 안 pull 없음 — 컨트롤플레인 몫
    expect(observationGraded).toBe(false); // 관측물 채점도 미룸(트레이스가 없으니 여기서 돌리면 틀린 채점)
    expect(result.scores.map((s) => s.graderId)).toEqual(["outcome"]); // ground-truth 점수만 잡에서
    expect(result.traceRef?.kind).toBe("mlflow");
    expect(result.traceRef?.endpoint).toBe("http://mlflow");
    expect(typeof result.traceRef?.runId).toBe("string"); // run 에 주입된 상관 키가 그대로 실린다
    expect(compute.disposed).toBe(true);
  });

  it("grader 가 던져도 compute 는 해제된다(조기 해제 이후 finally 는 no-op — 이중 dispose 없음)", async () => {
    let disposeCount = 0;
    const compute = fakeCompute({
      async dispose() {
        disposeCount += 1;
      },
    });
    const failing: Grader = {
      id: "boom",
      async grade(): Promise<Score> {
        throw new Error("boom");
      },
    };

    await expect(runCase(CASE, fakeDeps(compute, REPO_SNAPSHOT, [failing]))).rejects.toThrow("boom");
    expect(disposeCount).toBe(1);
  });
});
