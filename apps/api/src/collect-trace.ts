import type { CaseResult, EvalCase, GradeContext, Grader, Score } from "@assay/core";
import { makeGraders } from "@assay/graders";
import type { TraceSource, TraceSourceConfig } from "@assay/trace";

// 잡 밖 트레이스 수집(2-페이즈의 수집 페이즈, D4) — spec.trace.collect="control-plane" 케이스의 완성 단계.
// 잡은 실행에서 끝났고(CaseResult.traceRef 만 들고 옴), 여기서: 플랫폼 pull(runId 상관) → 잡이 미룬
// 관측물 채점(case.graders 중 needsCompute 아닌 것 — 에이전트와 같은 분리 규칙) → 완성된 CaseResult.
// executeCase 가 dispatch 직후 호출하므로 정산(costOf)·judge 스트림은 수집된 트레이스를 그대로 본다.
// docs/architecture/streaming-case-pipeline.md D4
export interface CollectTraceDeps {
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
}

// 재구성 불가 grader(inline judge 등)의 명시 skip — 사용자가 고른 grader 가 조용히 사라지지 않게.
function skipScore(graderId: string, reason: string): Score {
  return { graderId, metric: graderId, value: 0, detail: `skipped: ${reason}` };
}

export async function collectDeferredTrace(
  deps: CollectTraceDeps,
  evalCase: EvalCase,
  result: CaseResult,
): Promise<CaseResult> {
  const ref = result.traceRef;
  if (!ref) return result; // 수집이 미뤄지지 않은 결과(기본) — 그대로(무회귀)

  // 1) 플랫폼 pull. 실패는 soft — 실행 산출물(스냅샷·ground-truth 점수)을 버리지 않고 error 이벤트로 가시화
  //    (caseVerdict 권위 랭킹상 트레이스 부재가 ground-truth 판정을 뒤집지 못한다).
  const trace = [...result.trace];
  if (deps.buildTraceSource) {
    try {
      trace.push(...(await deps.buildTraceSource({ kind: ref.kind, endpoint: ref.endpoint }).fetch(ref.runId)));
    } catch (err) {
      trace.push({
        t: Date.now(),
        kind: "error",
        message: `트레이스 수집 실패(${ref.kind} ${ref.endpoint}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    trace.push({ t: Date.now(), kind: "error", message: "트레이스 수집 불가 — buildTraceSource 미설정" });
  }

  // 2) 잡이 미룬 관측물 채점 — 분리 규칙은 에이전트와 동일(needsCompute=true 는 잡에서 이미 채점됨).
  //    inline judge 는 Judge 주입 없이 재구성 불가 → 명시 skip(등록 judge 는 judge 스트림이 별도 처리).
  const scores = [...result.scores];
  const ctx: GradeContext = { case: evalCase, trace, snapshot: result.snapshot };
  for (const spec of evalCase.graders) {
    let grader: Grader;
    try {
      const built = makeGraders([spec]);
      const first = built[0];
      if (!first) continue;
      grader = first;
    } catch {
      scores.push(skipScore(spec.id, "control-plane 수집 모드에서 재구성 불가(inline judge 는 등록 judge 사용)"));
      continue;
    }
    if (grader.needsCompute === true) continue; // 잡(compute 해제 전)에서 이미 채점됨
    scores.push(await grader.grade(ctx));
  }

  return { ...result, trace, scores };
}
