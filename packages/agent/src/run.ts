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
  const harness = makeHarness(job.harness.id, job.harness.version, job.harnessSpec);
  const graders: Grader[] = makeGraders(job.evalCase.graders);
  return runCase(job.evalCase, {
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness,
    graders,
    runCtx: runContextFromEnv(),
  });
}
