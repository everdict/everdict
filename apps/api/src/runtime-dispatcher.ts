import { type Backend, type BackendRegistry, type Dispatcher, buildRuntimeBackend } from "@assay/backends";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  NotFoundError,
  type RegistryAuth,
  type RuntimeSpec,
  imageUsesRegistryHost,
} from "@assay/core";
import type { RuntimeRegistry } from "@assay/registry";
import { jobImages } from "./execute-case.js";
import { type SelfHostedKey, poolKeyFor, selfHostedBackendName } from "./runner-hub.js";

export interface RuntimeDispatcherDeps {
  inner: Dispatcher; // 글로벌 Scheduler — 공정성/예산/용량은 그대로 위임
  backends: BackendRegistry; // Scheduler 의 레지스트리 — 빌드한 테넌트 백엔드를 여기 등록
  runtimes: RuntimeRegistry; // 테넌트 등록 Runtime 해석
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries → 백엔드 secretEnv
  // RuntimeSpec → Backend 빌더(기본 buildRuntimeBackend = local/docker/nomad/k8s). topology 처럼 @assay/backends 가
  // 의존할 수 없는 백엔드(순환)는 apps/api 가 이걸 주입해 처리한다(buildRuntimeBackend 로 폴백).
  buildBackend?: (
    spec: RuntimeSpec,
    opts: { secretEnv?: Record<string, string>; registryAuth?: RegistryAuth },
  ) => Backend;
  // 워크스페이스 이미지 레지스트리 pull 자격증명(best-effort) — topology 백엔드 빌드에 실어 서비스 이미지 인증 pull.
  registryAuthsFor?: (tenant: string) => Promise<RegistryAuth[]>;
  // self:<runnerId> 타깃 — 개인 소유 셀프호스티드 러너. 미소유=undefined(404), 소유=그 러너의 capabilities[]
  // (소유 확인 + capability 게이트를 한 번에). service 하니스는 docker capability 가 필요(아래 게이트).
  resolveSelfRunner?: (owner: string, runnerId: string) => Promise<string[] | undefined>;
  // self:ws(러너 id 없이) 풀 타깃 — 그 owner(=ws:<tenant>)가 러너를 하나라도 가졌는지. 아무 러너나 lease 로 가져간다.
  poolHasRunners?: (owner: string) => Promise<boolean>;
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

    // 풀 타깃(러너 id 없이 "아무 러너나", N 러너 드레인):
    //  - self:ws = 워크스페이스 풀(owner=ws:<tenant> — 멤버 누구나; owner 를 잡 tenant 에서 파생 → 멤버십=접근권).
    //  - self    = 개인 풀(owner=제출자 — 내 러너 아무거나; 여러 프로세스/머신을 한 개인 풀에 붙일 수 있다).
    // ⚠️ 아래 self:<runnerId> 블록보다 먼저 — self:ws 는 그 블록에서 runnerId="ws" 로 오인될 수 있다.
    if ((target === "self:ws" || target === "self") && this.deps.poolHasRunners && this.deps.buildSelfHostedBackend) {
      const owner = target === "self:ws" ? `ws:${tenant}` : job.submittedBy;
      if (!owner)
        throw new NotFoundError(
          "NOT_FOUND",
          { resource: "runner", pool: "self" },
          "개인 풀(self)을 쓰려면 제출자가 필요합니다 — 인증된 요청만 개인 러너를 타깃할 수 있습니다.",
        );
      if (!(await this.deps.poolHasRunners(owner)))
        throw new NotFoundError(
          "NOT_FOUND",
          { resource: "runner", pool: owner },
          target === "self:ws"
            ? "이 워크스페이스에 등록된 공유 러너가 없습니다 — 먼저 공유 러너를 등록하세요."
            : "등록된 내 러너가 없습니다 — 먼저 러너를 페어링하세요.",
        );
      // service 하니스 docker 요구는 lease 시점 러너별 capability 게이트가 처리(requiredRunnerCapabilities 가 service→docker).
      const key = poolKeyFor(owner);
      const name = selfHostedBackendName(key);
      if (!this.deps.backends.has(name)) this.deps.backends.register(name, this.deps.buildSelfHostedBackend(key));
      return this.deps.inner.dispatch({
        ...job,
        evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } },
      });
    }

    // self:<runnerId> — 개인 소유 셀프호스티드 러너. 제출자(submittedBy)가 그 러너를 소유하는지 확인 후
    // (tenant,owner,runnerId) 백엔드로 라우팅. 남의 러너/미상 소유자 타깃은 404(존재 누설 없음 + D3 격리).
    if (target?.startsWith("self:") && this.deps.resolveSelfRunner && this.deps.buildSelfHostedBackend) {
      // self:ws:<runnerId> = 워크스페이스-공유 러너(owner=ws:<tenant> — 이 워크스페이스 멤버 누구나 타깃; 팀 빌드 서버/CI).
      // self:<runnerId> = 개인 소유 러너(owner=제출자 — 내 러너만, D3). owner 를 tenant 로 파생하니 멤버십이 곧 접근권.
      const rest = target.slice("self:".length);
      const workspaceShared = rest.startsWith("ws:");
      const runnerId = workspaceShared ? rest.slice("ws:".length) : rest;
      const owner = workspaceShared ? `ws:${tenant}` : job.submittedBy;
      const caps = owner && runnerId ? await this.deps.resolveSelfRunner(owner, runnerId) : undefined;
      if (!owner || !runnerId || caps === undefined)
        throw new NotFoundError(
          "NOT_FOUND",
          { runnerId, resource: "runner" },
          workspaceShared
            ? "이 워크스페이스의 공유 러너를 찾을 수 없습니다."
            : "셀프호스티드 러너를 찾을 수 없습니다 — 내가 소유한 러너만 타깃할 수 있습니다.",
        );
      // service(토폴로지) 하니스는 로컬 Docker 토폴로지를 띄우므로 러너에 docker capability 필요 — 없으면 실행 전 명시적 거부.
      if (job.harnessSpec?.kind === "service" && !caps.includes("docker"))
        throw new BadRequestError(
          "BAD_REQUEST",
          { runnerId, need: "docker", have: caps },
          "이 셀프호스티드 러너는 service(토폴로지) 하니스를 돌릴 수 없습니다 — docker capability 가 없습니다(Docker 설치 후 러너 재시작).",
        );
      // 키에 tenant 없음 — 러너는 소유자의 여러 워크스페이스 잡을 한 큐에서 받는다(크로스 워크스페이스). 잡이 tenant 를 보유.
      const key: SelfHostedKey = { owner, runnerId };
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
          // 워크스페이스 레지스트리(복수) pull 자격증명 — 이 잡 이미지의 host 와 매칭되는 것 1건을 백엔드에
          // 굽는다(백엔드는 런타임당 1회 빌드·재사용 — 첫 빌드 잡 기준. 단수 계약의 문서화된 한계).
          const auths = (await this.deps.registryAuthsFor?.(tenant).catch(() => [])) ?? [];
          const images = jobImages(job);
          const registryAuth = auths.find((a) => images.some((image) => imageUsesRegistryHost(image, a.host)));
          const build = this.deps.buildBackend ?? buildRuntimeBackend;
          this.deps.backends.register(name, build(spec, { secretEnv, ...(registryAuth ? { registryAuth } : {}) }));
        }
        routed = { ...job, evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } } };
      }
      // spec 못 찾으면 target 그대로 → Scheduler 가 미등록 백엔드로 NOT_FOUND(명시적 실패).
    }
    return this.deps.inner.dispatch(routed);
  }
}
