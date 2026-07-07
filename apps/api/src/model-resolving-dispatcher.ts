import type { Dispatcher } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/core";
import type { ModelRegistry } from "@everdict/registry";

// command 하니스의 {{model}} 슬롯(CommandHarnessSpec.model)이 등록된 Model id 면 그 하부 모델 식별자로 해석한다.
// judge.model 해석과 같은 규율 — 등록 Model 을 1급 참조로 쓰되, 매칭되는 id 가 없으면 raw 모델 문자열로 폴백.
// baseUrl/params 는 CLI 마다 env 계약이 달라 여기서 주입하지 않는다(하니스의 command.env 가 베이스 URL 을 관장).
export async function resolveJobModel(models: ModelRegistry, job: AgentJob): Promise<AgentJob> {
  const spec = job.harnessSpec;
  if (spec?.kind !== "command" || !spec.model) return job;
  const tenant = job.tenant ?? "default";
  let resolved: string;
  try {
    resolved = (await models.get(tenant, spec.model, "latest")).model;
  } catch {
    return job; // 등록된 model id 가 아님 → command.model 을 raw 모델 문자열로 그대로 사용.
  }
  if (resolved === spec.model) return job;
  return { ...job, harnessSpec: { ...spec, model: resolved } };
}

// 디스패치 직전 단일 지점에서 command 하니스 모델을 해석하는 Dispatcher 데코레이터. 배치(placement) 관심사인
// RuntimeDispatcher 와 분리해 둔다 — run/scorecard/harness-judge 모든 경로가 같은 디스패처를 공유하므로
// 한 곳에서 감싸면 어디로 디스패치되든 동일하게 해석된 모델로 실행되고 결과 provenance("어떤 모델로 돌렸나")가 일치한다.
export class ModelResolvingDispatcher implements Dispatcher {
  constructor(
    private readonly models: ModelRegistry,
    private readonly inner: Dispatcher,
  ) {}

  async dispatch(job: AgentJob): Promise<CaseResult> {
    return this.inner.dispatch(await resolveJobModel(this.models, job));
  }
}
