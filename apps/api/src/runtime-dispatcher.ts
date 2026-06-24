import { type Backend, type BackendRegistry, type Dispatcher, buildRuntimeBackend } from "@assay/backends";
import { type AgentJob, type CaseResult, NotFoundError, type RuntimeSpec } from "@assay/core";
import type { RuntimeRegistry } from "@assay/registry";
import { type SelfHostedKey, selfHostedBackendName } from "./runner-hub.js";

export interface RuntimeDispatcherDeps {
  inner: Dispatcher; // 글로벌 Scheduler — 공정성/예산/용량은 그대로 위임
  backends: BackendRegistry; // Scheduler 의 레지스트리 — 빌드한 테넌트 백엔드를 여기 등록
  runtimes: RuntimeRegistry; // 테넌트 등록 Runtime 해석
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries → 백엔드 secretEnv
  // RuntimeSpec → Backend 빌더(기본 buildRuntimeBackend = local/docker/nomad/k8s). topology 처럼 @assay/backends 가
  // 의존할 수 없는 백엔드(순환)는 apps/api 가 이걸 주입해 처리한다(buildRuntimeBackend 로 폴백).
  buildBackend?: (spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> }) => Backend;
  // self:<runnerId> 타깃 — 개인 소유 셀프호스티드 러너. owner(=submittedBy) 가 runnerId 를 소유하는지 확인(미소유=404).
  resolveSelfRunner?: (owner: string, runnerId: string) => Promise<boolean>;
  // SelfHostedKey → Backend(Slice 2 스텁 → Slice 3 lease 큐). 주입 없으면 self: 는 일반 경로로 폴백(미설정).
  buildSelfHostedBackend?: (key: SelfHostedKey) => Backend;
}

// placement.target 이 "테넌트가 등록한 Runtime" 이면: 그 spec + 테넌트 시크릿으로 Backend 를 빌드해 Scheduler
// 레지스트리에 (rt:tenant:id@version 이름으로) 등록하고 target 을 그 이름으로 재작성 → inner(Scheduler)가 라우팅.
// 공정성/예산/용량/격리는 Scheduler 가 그대로 처리. target 이 없거나 이미 글로벌 백엔드면 그대로 통과(기존 동작).
export class RuntimeDispatcher implements Dispatcher {
  constructor(private readonly deps: RuntimeDispatcherDeps) {}

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const tenant = job.tenant ?? "default";
    const target = job.evalCase.placement?.target;

    // self:<runnerId> — 개인 소유 셀프호스티드 러너. 제출자(submittedBy)가 그 러너를 소유하는지 확인 후
    // (tenant,owner,runnerId) 백엔드로 라우팅. 남의 러너/미상 소유자 타깃은 404(존재 누설 없음 + D3 격리).
    if (target?.startsWith("self:") && this.deps.resolveSelfRunner && this.deps.buildSelfHostedBackend) {
      const runnerId = target.slice("self:".length);
      const owner = job.submittedBy;
      if (!owner || !runnerId || !(await this.deps.resolveSelfRunner(owner, runnerId)))
        throw new NotFoundError(
          "NOT_FOUND",
          { runnerId, resource: "runner" },
          "셀프호스티드 러너를 찾을 수 없습니다 — 내가 소유한 러너만 타깃할 수 있습니다.",
        );
      const key: SelfHostedKey = { tenant, owner, runnerId };
      const name = selfHostedBackendName(key);
      if (!this.deps.backends.has(name)) this.deps.backends.register(name, this.deps.buildSelfHostedBackend(key));
      return this.deps.inner.dispatch({
        ...job,
        evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } },
      });
    }

    let routed = job;
    // target 이 글로벌 백엔드 이름이면 그대로(기존 정적 백엔드). 아니면 테넌트 Runtime 으로 해석 시도.
    if (target && !this.deps.backends.has(target)) {
      const spec = await this.deps.runtimes.get(tenant, target).catch(() => undefined);
      if (spec) {
        const name = `rt:${tenant}:${spec.id}@${spec.version}`; // 테넌트·버전별 1 백엔드 인스턴스(재사용)
        if (!this.deps.backends.has(name)) {
          const secretEnv = await this.deps.secretsFor(tenant).catch(() => ({}) as Record<string, string>);
          const build = this.deps.buildBackend ?? buildRuntimeBackend;
          this.deps.backends.register(name, build(spec, { secretEnv }));
        }
        routed = { ...job, evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } } };
      }
      // spec 못 찾으면 target 그대로 → Scheduler 가 미등록 백엔드로 NOT_FOUND(명시적 실패).
    }
    return this.deps.inner.dispatch(routed);
  }
}
