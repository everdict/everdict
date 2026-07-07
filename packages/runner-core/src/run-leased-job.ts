import { type DriverMount, pullWithRegistryAuth, runAgentJob } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  type RegistryAuth,
  type ServiceHarnessSpec,
  imageUsesRegistryHost,
} from "@everdict/core";
import {
  DockerTopologyRuntime,
  type DockerTopologyRuntimeOptions,
  ServiceTopologyBackend,
  type TopologyRuntime,
} from "@everdict/topology";
import { buildTraceSource } from "@everdict/trace";

// 러너 프로세스 내 단일 Docker 토폴로지 런타임(lazy 싱글톤). 케이스마다 새 런타임을 만들면 매번 warm-pool 이
// 비어 같은 토폴로지를 재배포하고, 고정 이름 컨테이너가 docker run --name 충돌로 cascade 실패한다(docker-runtime
// 의 부분기동 정리 주석 참고). 한 번만 만들어 재사용하면 warm-pool(per id@version)이 케이스 간 유지돼 토폴로지는
// 버전당 한 번만 배포된다.
let sharedRuntime: TopologyRuntime | undefined;

// 프로세스 내 단일 런타임을 lazy 하게 생성·반환. runtimeOptions 는 러너 기동 시 1회 산출되어 불변이므로 최초
// 생성에만 반영된다. make 는 테스트 주입점(기본 DockerTopologyRuntime).
export function sharedTopologyRuntime(
  opts?: DockerTopologyRuntimeOptions,
  make: (o?: DockerTopologyRuntimeOptions) => TopologyRuntime = (o) => new DockerTopologyRuntime(o),
): TopologyRuntime {
  sharedRuntime ??= make(opts);
  return sharedRuntime;
}

// 싱글톤 초기화 — 테스트 격리/러너 재기동용(러너 프로세스는 보통 1회만 생성한다).
export function resetSharedTopologyRuntime(): void {
  sharedRuntime = undefined;
}

// 리스한 잡을 하니스 kind 로 분기 실행. service(topology) → 로컬 Docker 토폴로지, 그 외 → runAgentJob.
// 비-service 케이스가 case.image 를 선언하고 이 러너에 Docker 가 있으면 그 이미지 컨테이너에서 실행(DockerDriver) —
// 관리형 DockerBackend 와 동일한 경로라 "정의 하나가 관리형이든 로컬이든 동일 환경"이 성립한다. 없으면 호스트-네이티브 LocalDriver.
// 설계: docs/architecture/portable-harness-runtime.md · self-hosted-service-runner.md. 분기는 한 곳에서만.
export async function runLeasedJob(
  job: AgentJob,
  opts: {
    runService?: (job: AgentJob) => Promise<CaseResult>; // 테스트 주입
    runProcess?: (job: AgentJob, runOpts: { containerize?: boolean; mounts?: DriverMount[] }) => Promise<CaseResult>;
    runtimeOptions?: DockerTopologyRuntimeOptions; // service 토폴로지 런타임 튜닝(readiness 타임아웃 등)
    dockerAvailable?: boolean; // 이 러너의 Docker 데몬 유무(capability) — image-케이스 컨테이너 실행 게이트
    mounts?: DriverMount[]; // containerize 시 컨테이너에 바인드할 호스트 자원(예: codex 로그인) — 러너 opt-in
    log?: (msg: string) => void; // image 요구인데 Docker 없음 등 사유 통지(조용한 실패 금지)
    pullImage?: (image: string, auth: RegistryAuth) => Promise<void>; // 테스트 주입(기본 pullWithRegistryAuth)
  } = {},
): Promise<CaseResult> {
  const spec = job.harnessSpec;
  if (spec?.kind === "service") {
    // 워크스페이스 레지스트리 서비스 이미지는 배포 전에 인증 pre-pull(임시 DOCKER_CONFIG) — 토폴로지 런타임의
    // docker run 은 로컬 이미지를 쓴다(런타임 인터페이스 무변경). 실패는 그대로 전파(pull 안 되면 배포도 못 한다).
    if (job.registryAuth) {
      for (const image of workspaceImagesToPull(spec, job.imagePins, job.registryAuth)) {
        opts.log?.(`워크스페이스 레지스트리 이미지 pull: ${image}`);
        await (opts.pullImage ?? pullWithRegistryAuth)(image, job.registryAuth);
      }
    }
    const runService = opts.runService ?? ((j: AgentJob) => defaultRunService(j, spec, opts.runtimeOptions));
    return runService(job);
  }
  // process/command. image 선언 + Docker 있으면 그 이미지 컨테이너에서 실행(툴체인 동봉 — 관리형과 동일). 아니면 호스트 인프로세스.
  const image = job.evalCase.image;
  const containerize = Boolean(image && opts.dockerAvailable);
  if (image && !opts.dockerAvailable)
    opts.log?.(
      `case ${job.evalCase.id} 가 image '${image}' 를 요구하지만 이 러너엔 Docker 가 없습니다 → 호스트-네이티브 실행(툴체인은 호스트가 제공해야 함).`,
    );
  // 컨테이너 실행일 때만 호스트 마운트를 넘긴다(호스트-네이티브 LocalDriver 엔 마운트 개념 없음).
  return (opts.runProcess ?? runAgentJob)(job, {
    containerize,
    ...(containerize && opts.mounts?.length ? { mounts: opts.mounts } : {}),
  });
}

// 인증 pre-pull 대상(순수) — 서비스 이미지(+per-dispatch 이미지 핀 override 반영) 중 레지스트리 호스트가
// auth.host 와 일치하는 것만, 중복 제거. 핀이 서비스 이미지를 갈아끼우므로 핀 값이 그 서비스의 pull 대상이다.
export function workspaceImagesToPull(
  spec: ServiceHarnessSpec,
  imagePins: Record<string, string> | undefined,
  auth: RegistryAuth,
): string[] {
  const images = spec.services.map((s) => imagePins?.[s.name] ?? s.image);
  return [...new Set(images.filter((image) => imageUsesRegistryHost(image, auth.host)))];
}

// service 하니스: 사용자 Docker 데몬에 토폴로지를 띄워 구동. 개인 호스트라 trustZones 없음; trace 미도달 시
// 토폴로지가 snapshot 으로 degrade(기존 동작). submit/getJson 은 기본 fetch.
function defaultRunService(
  job: AgentJob,
  spec: ServiceHarnessSpec,
  runtimeOptions?: DockerTopologyRuntimeOptions,
): Promise<CaseResult> {
  const backend = new ServiceTopologyBackend({
    runtime: sharedTopologyRuntime(runtimeOptions), // 케이스 간 재사용 → warm-pool 유지(토폴로지 버전당 1회 배포)
    traceSource: buildTraceSource(spec.traceSource),
    specFor: () => spec,
  });
  return backend.dispatch(job);
}
