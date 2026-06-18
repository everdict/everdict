import type { GradeContext, Grader, JudgeSpec, Score } from "@assay/core";
import { JudgeGrader, anthropicComplete, modelJudge } from "@assay/graders";

// judge 실행기 — JudgeSpec + tenant + GradeContext(트레이스) → Score. 컨트롤플레인이 트레이스 기반으로 판정.
// model 종류는 테넌트 시크릿 키로 실제 모델 호출, harness/미지원 프로바이더는 skip(요약에 보이되 판정 아님).
export interface JudgeRunner {
  run(spec: JudgeSpec, tenant: string, ctx: GradeContext): Promise<Score>;
}

// 여러 judge 를 요약에서 구분하기 위한 메트릭 키.
const metricOf = (spec: JudgeSpec): string => `judge:${spec.id}`;

// skip score — 키 없음/미지원 등. 사용자가 고른 judge 가 조용히 사라지지 않도록 detail 로 사유 명시.
function skip(spec: JudgeSpec, reason: string): Score {
  return { graderId: spec.id, metric: metricOf(spec), value: 0, pass: undefined, detail: `skipped: ${reason}` };
}

const ANTHROPIC_KEY = "ANTHROPIC_API_KEY"; // 테넌트 SecretStore 에서 model judge 가 찾는 키 이름

export interface DefaultJudgeRunnerDeps {
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries (복호화, 서버 내부 전용)
  fetchImpl?: typeof fetch;
  baseUrl?: string; // anthropic 베이스(프록시/게이트웨이로 바꿀 때)
}

// 기본 구현: model+anthropic 은 테넌트의 ANTHROPIC_API_KEY 로 실제 호출. harness/openai 는 다음 증분(skip).
export function defaultJudgeRunner(deps: DefaultJudgeRunnerDeps): JudgeRunner {
  return {
    async run(spec, tenant, ctx) {
      if (spec.kind === "harness") return skip(spec, "harness judge 실행은 다음 증분");
      if (spec.provider !== "anthropic") return skip(spec, `${spec.provider} 프로바이더는 아직 미지원`);
      const secrets = await deps.secretsFor(tenant).catch(() => ({}) as Record<string, string>);
      const apiKey = secrets[ANTHROPIC_KEY];
      if (!apiKey) return skip(spec, `${ANTHROPIC_KEY} 시크릿 미설정`);
      try {
        const judge = modelJudge(
          anthropicComplete({
            apiKey,
            model: spec.model,
            ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          }),
        );
        const grader: Grader = new JudgeGrader(judge, {
          id: spec.id,
          ...(spec.rubric ? { rubric: spec.rubric } : {}),
          useScreenshot: (spec.inputs ?? []).includes("screenshot"),
        });
        const score = await grader.grade(ctx);
        // 메트릭을 judge:<id> 로(여러 judge 구분); passThreshold 가 있으면 score→pass 재판정.
        const pass = spec.passThreshold != null ? score.value >= spec.passThreshold : score.pass;
        return { ...score, metric: metricOf(spec), ...(pass != null ? { pass } : {}) };
      } catch (err) {
        return skip(spec, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
