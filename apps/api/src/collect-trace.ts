import type { CaseResult, EvalCase, GradeContext, Grader, Score } from "@assay/core";
import { makeGraders } from "@assay/graders";
import type { TraceSource, TraceSourceConfig } from "@assay/trace";

// 잡 밖 트레이스 수집(2-페이즈의 수집 페이즈, D4) — spec.trace.collect="control-plane" 케이스의 완성 단계.
// 잡은 실행에서 끝났고(CaseResult.traceRef 만 들고 옴), 여기서: 플랫폼 pull(runId 상관, 플러시 지연은
// 짧은 재시도로 흡수) → 잡이 미룬 관측물 채점(case.graders 중 needsCompute 아닌 것 — 에이전트와 같은
// 분리 규칙) → 완성된 CaseResult. 인증은 traceRef.authSecret(이름)을 테넌트 SecretStore 에서 재해석해
// verbatim Authorization 헤더로(pull-ingest 와 동일 관례). mlflow correlate="tag" 면 assay.run_id 태그 검색.
// executeCase 가 dispatch 직후 호출하므로 정산(costOf)·judge 스트림은 수집된 트레이스를 그대로 본다.
// docs/architecture/streaming-case-pipeline.md D4
export interface CollectTraceDeps {
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // traceRef.authSecret 재해석(SecretStore)
  sleep?: (ms: number) => Promise<void>; // 재시도 백오프(테스트 주입, 기본 setTimeout)
}

// 재구성 불가 grader(inline judge 등)의 명시 skip — 사용자가 고른 grader 가 조용히 사라지지 않게.
function skipScore(graderId: string, reason: string): Score {
  return { graderId, metric: graderId, value: 0, detail: `skipped: ${reason}` };
}

const COLLECT_ATTEMPTS = 3; // 플러시 지연 흡수 — 잡 종료→결과 수송이 이미 수 초를 벌어주지만, 느린 플랫폼 대비

export async function collectDeferredTrace(
  deps: CollectTraceDeps,
  tenant: string | undefined,
  evalCase: EvalCase,
  result: CaseResult,
): Promise<CaseResult> {
  const ref = result.traceRef;
  if (!ref) return result; // 수집이 미뤄지지 않은 결과(기본) — 그대로(무회귀)

  // 1) 플랫폼 pull. 실패는 soft — 실행 산출물(스냅샷·ground-truth 점수)을 버리지 않고 error 이벤트로 가시화
  //    (caseVerdict 권위 랭킹상 트레이스 부재가 ground-truth 판정을 뒤집지 못한다). 0건도 재시도 후 가시화
  //    (플러시 지연/상관 키 문제를 조용히 0점으로 삼키지 않는다).
  const trace = [...result.trace];
  if (deps.buildTraceSource) {
    try {
      // 인증: authSecret 이름 → 테넌트 SecretStore 값 → verbatim Authorization(pull-ingest 관례).
      let headers: Record<string, string> | undefined;
      if (ref.authSecret) {
        const secrets = tenant && deps.secretsFor ? await deps.secretsFor(tenant) : {};
        const auth = secrets[ref.authSecret];
        if (auth === undefined)
          throw new Error(`인증 시크릿 '${ref.authSecret}' 미등록(워크스페이스 SecretStore) — 수집 불가`);
        headers = { authorization: auth };
      }
      // 검색 범위: mlflow tag 상관의 experiment | phoenix 의 project — TraceSourceConfig.project 로 수렴.
      const project = ref.experiment ?? ref.project;
      const source = deps.buildTraceSource({
        kind: ref.kind,
        endpoint: ref.endpoint,
        ...(headers ? { headers } : {}),
        ...(ref.correlate ? { correlate: ref.correlate } : {}),
        ...(project ? { project } : {}),
      });
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let events: Awaited<ReturnType<TraceSource["fetch"]>> = [];
      for (let attempt = 0; attempt < COLLECT_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(2000);
        events = await source.fetch(ref.runId);
        if (events.length > 0) break;
      }
      if (events.length === 0) {
        trace.push({
          t: Date.now(),
          kind: "error",
          message: `트레이스 수집 0건(${COLLECT_ATTEMPTS}회 시도, ${ref.kind} ${ref.endpoint}) — 상관 키(${ref.runId})/플러시 지연 확인`,
        });
      }
      trace.push(...events);
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
