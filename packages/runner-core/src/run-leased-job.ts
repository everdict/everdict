import { runAgentJob } from "@assay/agent";
import type { AgentJob, CaseResult, ServiceHarnessSpec } from "@assay/core";
import {
  DockerTopologyRuntime,
  type DockerTopologyRuntimeOptions,
  ServiceTopologyBackend,
  type TopologyRuntime,
} from "@assay/topology";
import { buildTraceSource } from "@assay/trace";

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

// 리스한 잡을 하니스 kind 로 분기 실행. service(topology) → 로컬 Docker 토폴로지, 그 외 → runAgentJob(LocalDriver).
// 설계: docs/architecture/self-hosted-service-runner.md (slice 2). 분기는 한 곳에서만.
export async function runLeasedJob(
  job: AgentJob,
  opts: {
    runService?: (job: AgentJob) => Promise<CaseResult>; // 테스트 주입
    runProcess?: (job: AgentJob) => Promise<CaseResult>;
    runtimeOptions?: DockerTopologyRuntimeOptions; // service 토폴로지 런타임 튜닝(readiness 타임아웃 등)
  } = {},
): Promise<CaseResult> {
  const spec = job.harnessSpec;
  if (spec?.kind === "service") {
    const runService = opts.runService ?? ((j: AgentJob) => defaultRunService(j, spec, opts.runtimeOptions));
    return runService(job);
  }
  // process/command — 이 머신의 로그인으로 인프로세스 실행(현행).
  return (opts.runProcess ?? runAgentJob)(job);
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
