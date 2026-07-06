import type {
  CaseResult,
  ComputeHandle,
  Driver,
  EnvSnapshot,
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

// os-use 스냅샷의 스크린샷이 참조(ref)로만 있으면 compute 해제 전에 base64 로 물질화한다 —
// 해제 후 채점되는 judge(VLM)가 환경 접근 없이 스크린샷을 쓰게 하기 위함. 채점용 스냅샷에만 동봉하고
// 저장 스냅샷(CaseResult)은 그대로 둔다(레코드 비대 방지 — 현행과 동일하게 ref 만 저장).
// 캡처 실패는 soft — 원본 스냅샷 그대로(현행 judge 의 "스크린샷 없음" 동작과 동일).
async function materializeScreenshot(
  snapshot: EnvSnapshot,
  compute: ComputeHandle,
  graders: Grader[],
): Promise<EnvSnapshot> {
  const hasDeferred = graders.some((g) => g.needsCompute !== true);
  if (!hasDeferred || snapshot.kind !== "os-use" || snapshot.screenshot || !snapshot.screenshotRef) return snapshot;
  const ref = snapshot.screenshotRef;
  const r = await compute.exec(`base64 -w0 '${ref.replace(/'/g, "'\\''")}'`);
  const base64 = r.stdout.trim();
  if (r.exitCode !== 0 || !base64) return snapshot;
  return { ...snapshot, screenshot: base64 };
}

// 한 EvalCase를 끝까지 실행한다:
// provision → seed → install → run(하니스, 트레이스 수집) → snapshot → grade.
// 채점은 두 단계 — compute-바운드(환경에서 명령 실행: tests-pass 등 needsCompute 선언)는 해제 전에,
// 관측물(trace/snapshot) 전용(steps/cost/judge 등)은 compute 를 해제한 뒤에 채점해 샌드박스 점유를
// 실행 구간으로 최소화한다(judge LLM 대기 동안 미점유). docs/architecture/streaming-case-pipeline.md
// compute 는 무슨 일이 있어도 finally 에서 해제(조기 해제 후엔 no-op — 플래그로 멱등화).
// (나중에 이 함수가 Temporal activity가 된다)
export async function runCase(evalCase: EvalCase, deps: RunCaseDeps): Promise<CaseResult> {
  const compute = await deps.driver.provision({ os: "linux", needs: ["shell"], image: evalCase.image });
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await compute.dispose();
  };
  try {
    await deps.environment.seed(compute, evalCase.env);
    await deps.harness.install(compute);

    const trace: TraceEvent[] = [];
    for await (const ev of deps.harness.run(compute, evalCase.task, deps.runCtx)) {
      trace.push(ev);
    }

    const snapshot = await deps.environment.snapshot(compute);

    // 점수 순서는 graders 배열 순서를 유지한다(두 단계로 나눠 채점해도 결과 순서는 불변).
    const scores: Score[] = new Array(deps.graders.length);
    for (const [i, grader] of deps.graders.entries()) {
      if (grader.needsCompute === true) {
        scores[i] = await grader.grade({ case: evalCase, trace, snapshot, compute });
      }
    }
    const gradeSnapshot = await materializeScreenshot(snapshot, compute, deps.graders);
    await release(); // 남은 채점은 관측물 전용 — 샌드박스는 여기서 반납
    for (const [i, grader] of deps.graders.entries()) {
      if (grader.needsCompute !== true) {
        scores[i] = await grader.grade({ case: evalCase, trace, snapshot: gradeSnapshot });
      }
    }

    return {
      caseId: evalCase.id,
      harness: `${deps.harness.id}@${deps.harness.version}`,
      trace,
      snapshot,
      scores,
    };
  } finally {
    await release();
  }
}
