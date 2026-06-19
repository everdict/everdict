import { type BackendRegistry, type Dispatcher, buildRuntimeBackend } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import type { RuntimeRegistry } from "@assay/registry";

export interface RuntimeDispatcherDeps {
  inner: Dispatcher; // 글로벌 Scheduler — 공정성/예산/용량은 그대로 위임
  backends: BackendRegistry; // Scheduler 의 레지스트리 — 빌드한 테넌트 백엔드를 여기 등록
  runtimes: RuntimeRegistry; // 테넌트 등록 Runtime 해석
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries → 백엔드 secretEnv
}

// placement.target 이 "테넌트가 등록한 Runtime" 이면: 그 spec + 테넌트 시크릿으로 Backend 를 빌드해 Scheduler
// 레지스트리에 (rt:tenant:id@version 이름으로) 등록하고 target 을 그 이름으로 재작성 → inner(Scheduler)가 라우팅.
// 공정성/예산/용량/격리는 Scheduler 가 그대로 처리. target 이 없거나 이미 글로벌 백엔드면 그대로 통과(기존 동작).
export class RuntimeDispatcher implements Dispatcher {
  constructor(private readonly deps: RuntimeDispatcherDeps) {}

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const tenant = job.tenant ?? "default";
    const target = job.evalCase.placement?.target;
    let routed = job;
    // target 이 글로벌 백엔드 이름이면 그대로(기존 정적 백엔드). 아니면 테넌트 Runtime 으로 해석 시도.
    if (target && !this.deps.backends.has(target)) {
      const spec = await this.deps.runtimes.get(tenant, target).catch(() => undefined);
      if (spec) {
        const name = `rt:${tenant}:${spec.id}@${spec.version}`; // 테넌트·버전별 1 백엔드 인스턴스(재사용)
        if (!this.deps.backends.has(name)) {
          const secretEnv = await this.deps.secretsFor(tenant).catch(() => ({}) as Record<string, string>);
          this.deps.backends.register(name, buildRuntimeBackend(spec, { secretEnv }));
        }
        routed = { ...job, evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } } };
      }
      // spec 못 찾으면 target 그대로 → Scheduler 가 미등록 백엔드로 NOT_FOUND(명시적 실패).
    }
    return this.deps.inner.dispatch(routed);
  }
}
