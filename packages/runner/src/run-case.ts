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

// 트레이스 상관 키 — 하니스가 ASSAY_RUN_ID/assay.run_id 로 주입하고, 수집(collectTrace/컨트롤플레인 pull)이
// 같은 값으로 플랫폼에서 찾는다. 호출부(runCtx.runId)가 안 주면 여기서 mint.
function newRunId(): string {
  return `assay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// os-use 스냅샷의 스크린샷이 참조(ref)로만 있으면 compute 해제 전에 base64 로 물질화한다 —
// 해제 후(또는 컨트롤플레인에서) 채점되는 judge(VLM)가 환경 접근 없이 스크린샷을 쓰게 하기 위함.
// 캡처 실패는 soft — 원본 스냅샷 그대로(현행 judge 의 "스크린샷 없음" 동작과 동일).
async function materializeScreenshot(
  snapshot: EnvSnapshot,
  compute: ComputeHandle,
  needed: boolean,
): Promise<EnvSnapshot> {
  if (!needed || snapshot.kind !== "os-use" || snapshot.screenshot || !snapshot.screenshotRef) return snapshot;
  const ref = snapshot.screenshotRef;
  const r = await compute.exec(`base64 -w0 '${ref.replace(/'/g, "'\\''")}'`);
  const base64 = r.stdout.trim();
  if (r.exitCode !== 0 || !base64) return snapshot;
  return { ...snapshot, screenshot: base64 };
}

// 한 EvalCase를 끝까지 실행한다:
// provision → seed → install → run(하니스) → snapshot → grade → (트레이스 수집).
// 채점은 두 단계 — compute-바운드(환경에서 명령 실행: tests-pass 등 needsCompute 선언)는 해제 전에,
// 관측물(trace/snapshot) 전용(steps/cost/judge 등)은 compute 를 해제한 뒤에 채점해 샌드박스 점유를
// 실행 구간으로 최소화한다(judge LLM 대기 동안 미점유).
// 플랫폼 트레이스(하니스 traceSource) 수집도 해제 후: collect="job"(기본)이면 여기서 collectTrace(runId) pull,
// "control-plane" 이면 수집+관측물 채점을 통째로 잡 밖으로 미루고 CaseResult.traceRef 만 실어 보낸다
// (executeCase 가 완성). docs/architecture/streaming-case-pipeline.md D3+D4
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

    const runId = deps.runCtx.runId ?? newRunId();
    const runCtx: RunContext = { ...deps.runCtx, runId };
    const trace: TraceEvent[] = [];
    for await (const ev of deps.harness.run(compute, evalCase.task, runCtx)) {
      trace.push(ev);
    }

    let snapshot = await deps.environment.snapshot(compute);
    const source = deps.harness.traceSource?.();
    // 수집을 잡 밖으로 미루는 모드 — 트레이스가 필요한 관측물 채점도 함께 미뤄진다(컨트롤플레인이 완성).
    const defer = source?.collect === "control-plane";

    // 점수 슬롯은 graders 배열 순서 — 두 단계로 나눠 채점해도 순서 불변. defer 로 미뤄진 슬롯만 비운다.
    const observes = deps.graders.some((g) => g.needsCompute !== true);
    const slots: Array<Score | undefined> = new Array(deps.graders.length);
    for (const [i, grader] of deps.graders.entries()) {
      if (grader.needsCompute === true) {
        slots[i] = await grader.grade({ case: evalCase, trace, snapshot, compute });
      }
    }
    const materialized = await materializeScreenshot(snapshot, compute, observes || defer);
    // defer 면 관측물 채점이 컨트롤플레인에서 일어난다 — 스크린샷을 결과 스냅샷에 실어 보낸다(오프로드가 슬림화).
    if (defer) snapshot = materialized;
    await release(); // 남은 일(플랫폼 pull·관측물 채점)은 환경이 필요 없다 — 샌드박스는 여기서 반납

    if (!defer) {
      if (deps.harness.collectTrace && source) trace.push(...(await deps.harness.collectTrace(runId)));
      for (const [i, grader] of deps.graders.entries()) {
        if (grader.needsCompute !== true) {
          slots[i] = await grader.grade({ case: evalCase, trace, snapshot: materialized });
        }
      }
    }

    return {
      caseId: evalCase.id,
      harness: `${deps.harness.id}@${deps.harness.version}`,
      trace,
      snapshot,
      scores: slots.filter((s): s is Score => s !== undefined),
      ...(defer && source
        ? {
            traceRef: {
              kind: source.kind,
              endpoint: source.endpoint,
              runId,
              // 인증은 시크릿 '이름'만 — 값은 컨트롤플레인이 collect 시 재해석(CaseResult 는 영속된다).
              ...(source.authSecret ? { authSecret: source.authSecret } : {}),
              ...(source.correlate ? { correlate: source.correlate } : {}),
              ...(source.experiment ? { experiment: source.experiment } : {}),
              ...(source.project ? { project: source.project } : {}),
            },
          }
        : {}),
    };
  } finally {
    await release();
  }
}
