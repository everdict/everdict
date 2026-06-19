import type { AgentJob, CaseResult, Grader } from "@assay/core";
import { LocalDriver } from "@assay/drivers";
import { RepoEnvironment } from "@assay/environments";
import { runCase } from "@assay/runner";
import { runContextFromEnv } from "./env.js";
import { makeGraders, makeHarness } from "./registry.js";

// 에이전트가 stdout 으로 결과를 내보낼 때 쓰는 구분자. 백엔드가 로그에서 이 라인을 파싱한다.
export const RESULT_SENTINEL = "__ASSAY_RESULT__";

// AgentJob 한 건을 끝까지 수행한다(샌드박스 안에서 LocalDriver 로 하니스를 로컬 구동).
// harnessSpec(컨트롤플레인이 레지스트리에서 임베드)이 있으면 선언형 command 하니스로 해석된다.
export async function runAgentJob(job: AgentJob): Promise<CaseResult> {
  // 사용량 계측(BYO + Assay 소유 버짓): 컨트롤플레인이 워크스페이스/요청 정책으로 결정해 job.meterUsage 로 보낸다.
  // 미지정이면 dev 폴백으로 ASSAY_METER_USAGE env(컨트롤플레인 없이 LocalBackend 직접 디스패치할 때).
  // 켜지면 command 하니스가 모델 호출을 usage-proxy 로 통과시켜 토큰을 회수 → 합성 trace 이벤트로 결과에 실린다.
  const meterUsage = job.meterUsage ?? process.env.ASSAY_METER_USAGE === "1";
  const harness = makeHarness(job.harness.id, job.harness.version, job.harnessSpec, { meterUsage });
  const graders: Grader[] = makeGraders(job.evalCase.graders);
  return runCase(job.evalCase, {
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness,
    graders,
    runCtx: runContextFromEnv(),
  });
}
