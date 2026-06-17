import type {
  CaseResult,
  Driver,
  Environment,
  EvalCase,
  EvaluableHarness,
  Grader,
  RunContext,
  Score,
  TraceEvent,
} from "@assay/core";

export interface RunCaseDeps {
  driver: Driver;
  environment: Environment;
  harness: EvaluableHarness;
  graders: Grader[];
  runCtx: RunContext;
}

// 한 EvalCase를 끝까지 실행한다:
// provision → seed → install → run(하니스, 트레이스 수집) → snapshot → grade.
// compute는 무슨 일이 있어도 finally에서 해제. (나중에 이 함수가 Temporal activity가 된다)
export async function runCase(evalCase: EvalCase, deps: RunCaseDeps): Promise<CaseResult> {
  const compute = await deps.driver.provision({ os: "linux", needs: ["shell"], image: evalCase.image });
  try {
    await deps.environment.seed(compute, evalCase.env);
    await deps.harness.install(compute);

    const trace: TraceEvent[] = [];
    for await (const ev of deps.harness.run(compute, evalCase.task, deps.runCtx)) {
      trace.push(ev);
    }

    const snapshot = await deps.environment.snapshot(compute);

    const scores: Score[] = [];
    for (const grader of deps.graders) {
      scores.push(await grader.grade({ case: evalCase, trace, snapshot, compute }));
    }

    return {
      caseId: evalCase.id,
      harness: `${deps.harness.id}@${deps.harness.version}`,
      trace,
      snapshot,
      scores,
    };
  } finally {
    await compute.dispose();
  }
}
