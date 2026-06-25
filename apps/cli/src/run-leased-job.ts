import { runAgentJob } from "@assay/agent";
import type { AgentJob, CaseResult, ServiceHarnessSpec } from "@assay/core";
import { DockerTopologyRuntime, ServiceTopologyBackend } from "@assay/topology";
import { buildTraceSource } from "@assay/trace";

// 리스한 잡을 하니스 kind 로 분기 실행. service(topology) → 로컬 Docker 토폴로지, 그 외 → runAgentJob(LocalDriver).
// 설계: docs/architecture/self-hosted-service-runner.md (slice 2). 분기는 한 곳에서만.
export async function runLeasedJob(
  job: AgentJob,
  opts: {
    runService?: (job: AgentJob) => Promise<CaseResult>; // 테스트 주입
    runProcess?: (job: AgentJob) => Promise<CaseResult>;
  } = {},
): Promise<CaseResult> {
  const spec = job.harnessSpec;
  if (spec?.kind === "service") {
    const runService = opts.runService ?? ((j: AgentJob) => defaultRunService(j, spec));
    return runService(job);
  }
  // process/command — 이 머신의 로그인으로 인프로세스 실행(현행).
  return (opts.runProcess ?? runAgentJob)(job);
}

// service 하니스: 사용자 Docker 데몬에 토폴로지를 띄워 구동. 개인 호스트라 trustZones 없음; trace 미도달 시
// 토폴로지가 snapshot 으로 degrade(기존 동작). submit/getJson 은 기본 fetch.
function defaultRunService(job: AgentJob, spec: ServiceHarnessSpec): Promise<CaseResult> {
  const backend = new ServiceTopologyBackend({
    runtime: new DockerTopologyRuntime(),
    traceSource: buildTraceSource(spec.traceSource),
    specFor: () => spec,
  });
  return backend.dispatch(job);
}
