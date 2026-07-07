import type {
  AgentJob,
  CaseResult,
  EvalCase,
  GradeContext,
  Grader,
  HarnessSpec,
  JudgeSpec,
  Placement,
  Score,
} from "@everdict/core";
import {
  type JudgeCompletion,
  JudgeGrader,
  anthropicComplete,
  harnessComplete,
  modelJudge,
  openaiComplete,
} from "@everdict/graders";
import type { HarnessInstanceRegistry, ModelRegistry } from "@everdict/registry";

// judge 실행기 — JudgeSpec + tenant + GradeContext(트레이스) → Score. 컨트롤플레인이 트레이스 기반으로 판정.
// model(anthropic/openai)·harness 모두 modelJudge(전송)로 통일 — 전송만 다르다(API 호출 / 에이전트 디스패치).
export interface JudgeRunner {
  // placement = 산출 run 의 배치(관측물이 있는 곳). harness judge 는 spec.runtime 우선, 없으면 이걸 상속(co-locate).
  run(spec: JudgeSpec, tenant: string, ctx: GradeContext, placement?: Placement): Promise<Score>;
}

// 여러 judge 를 요약에서 구분하기 위한 메트릭 키.
const metricOf = (spec: JudgeSpec): string => `judge:${spec.id}`;

// skip score — 키 없음/디스패치 없음 등. 사용자가 고른 judge 가 조용히 사라지지 않도록 detail 로 사유 명시.
function skip(spec: JudgeSpec, reason: string): Score {
  return { graderId: spec.id, metric: metricOf(spec), value: 0, pass: undefined, detail: `skipped: ${reason}` };
}

const ANTHROPIC_KEY = "ANTHROPIC_API_KEY"; // 테넌트 SecretStore 에서 찾는 키 이름
const OPENAI_KEY = "OPENAI_API_KEY";
const OPENAI_BASE_URL = "OPENAI_BASE_URL"; // LiteLLM 등 OpenAI-호환 프록시 베이스(선택)

export interface DefaultJudgeRunnerDeps {
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries (복호화, 서버 내부 전용)
  dispatch?: (job: AgentJob) => Promise<CaseResult>; // harness judge 용 에이전트 디스패치(단일 run 과 동일 경로)
  harnesses?: HarnessInstanceRegistry; // judge 가 참조하는 하니스 인스턴스 해석(template+pins→resolved)
  models?: ModelRegistry; // judge.model 이 등록된 model id 면 provider/baseUrl/하부모델을 해석(없으면 raw 문자열)
  fetchImpl?: typeof fetch;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
}

// 참조 하니스 해석: 구체 버전 + (선언형) spec. 빌트인/미등록은 as-given.
async function resolveJudgeHarness(
  harnesses: HarnessInstanceRegistry | undefined,
  tenant: string,
  ref: { id: string; version: string },
): Promise<{ version: string; spec?: HarnessSpec }> {
  if (!harnesses) return { version: ref.version || "latest" };
  try {
    const spec = await harnesses.get(tenant, ref.id, ref.version || "latest");
    return { version: spec.version, spec };
  } catch {
    return { version: ref.version || "latest" };
  }
}

// 기본 구현: model 은 테넌트 시크릿 키로 프로바이더 호출(anthropic/openai), harness 는 참조 에이전트를 띄워 판정.
export function defaultJudgeRunner(deps: DefaultJudgeRunnerDeps): JudgeRunner {
  return {
    async run(spec, tenant, ctx, placement) {
      // 1) 전송 선택. 키/디스패처 없으면 skip(사유 명시).
      let complete: JudgeCompletion;
      if (spec.kind === "harness") {
        if (!deps.dispatch) return skip(spec, "harness judge dispatch 미설정");
        const dispatch = deps.dispatch;
        const ref = spec.harness;
        const resolved = await resolveJudgeHarness(deps.harnesses, tenant, ref);
        // 배치 결정: spec.runtime(명시) 우선 → 없으면 산출 run 의 placement 상속(co-locate, 관측물 옆에서 판정).
        // 둘 다 없으면 placement 없음(기본 백엔드). 미등록 런타임이면 디스패처가 throw → 아래 try/catch 가 skip 처리.
        const judgePlacement: Placement | undefined = spec.runtime ? { target: spec.runtime } : placement;
        complete = harnessComplete({
          dispatch: async (task) => {
            const evalCase: EvalCase = {
              id: `judge-${spec.id}-${ctx.case.id}`,
              env: { kind: "repo", source: { files: {} } },
              task, // 판정 프롬프트(rubric + 트레이스 + JSON 요구)를 에이전트에 그대로 전달
              graders: [],
              timeoutSec: 300,
              tags: ["judge"],
              ...(judgePlacement ? { placement: judgePlacement } : {}),
            };
            const job: AgentJob = {
              evalCase,
              harness: { id: ref.id, version: resolved.version },
              tenant,
              ...(resolved.spec ? { harnessSpec: resolved.spec } : {}),
            };
            return (await dispatch(job)).trace;
          },
        });
      } else {
        // 시크릿 복호화 실패(예: EVERDICT_SECRETS_KEY / 암호화 키 불일치)를 빈 맵으로 삼키면, 시크릿이
        // 실제로 있는데도 아래 `secrets[KEY]` 가 undefined 라 "미설정"으로 오판돼 judge 가 조용히 skip 된다.
        // throw 를 잡되 빈 맵 폴백 없이 실제 복호화 사유를 그대로 노출해 skip.
        let secrets: Record<string, string>;
        try {
          secrets = await deps.secretsFor(tenant);
        } catch (err) {
          return skip(spec, `시크릿 복호화 실패: ${err instanceof Error ? err.message : String(err)}`);
        }
        // judge.model 이 등록된 model id 면 그 spec(provider/하부모델/baseUrl)으로 해석 — 아니면 raw 모델 문자열 그대로.
        let provider: "anthropic" | "openai" = spec.provider;
        let model = spec.model;
        let modelBaseUrl: string | undefined;
        if (deps.models) {
          try {
            const m = await deps.models.get(tenant, spec.model, "latest");
            provider = m.provider;
            model = m.model;
            modelBaseUrl = m.baseUrl;
          } catch {
            // 등록된 model id 가 아님 → spec.model 을 raw 모델 문자열로 사용.
          }
        }
        if (provider === "anthropic") {
          const apiKey = secrets[ANTHROPIC_KEY];
          if (!apiKey) return skip(spec, `${ANTHROPIC_KEY} 시크릿 미설정`);
          const baseUrl = modelBaseUrl ?? deps.anthropicBaseUrl;
          complete = anthropicComplete({
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        } else {
          const apiKey = secrets[OPENAI_KEY];
          if (!apiKey) return skip(spec, `${OPENAI_KEY} 시크릿 미설정`);
          const baseUrl = secrets[OPENAI_BASE_URL] ?? modelBaseUrl ?? deps.openaiBaseUrl;
          complete = openaiComplete({
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        }
      }

      // 2) 통일된 판정: modelJudge(전송)을 JudgeGrader 로 감싸 트레이스 채점 → judge:<id> 점수.
      try {
        const rubric = spec.rubric;
        const useScreenshot = spec.kind === "model" && (spec.inputs ?? []).includes("screenshot");
        const grader: Grader = new JudgeGrader(modelJudge(complete), {
          id: spec.id,
          ...(rubric ? { rubric } : {}),
          useScreenshot,
        });
        const score = await grader.grade(ctx);
        const threshold = spec.kind === "model" ? spec.passThreshold : undefined;
        const pass = threshold != null ? score.value >= threshold : score.pass;
        return { ...score, metric: metricOf(spec), ...(pass != null ? { pass } : {}) };
      } catch (err) {
        return skip(spec, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
