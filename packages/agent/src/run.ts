import { type AgentJob, type CaseResult, type Driver, type Environment, type Grader, judgeEnv } from "@assay/core";
import { LocalDriver } from "@assay/drivers";
import { OsUseEnvironment, PromptEnvironment, RepoEnvironment } from "@assay/environments";
import { runCase } from "@assay/runner";
import { runContextFromEnv } from "./env.js";
import { makeGradersFromEnv, makeHarness } from "./registry.js";

// 에이전트가 stdout 으로 결과를 내보낼 때 쓰는 구분자. 백엔드가 로그에서 이 라인을 파싱한다.
export const RESULT_SENTINEL = "__ASSAY_RESULT__";

// AgentJob 한 건을 끝까지 수행한다. 기본 driver=LocalDriver(인프로세스), DockerBackend 는 DockerDriver 주입(케이스를
// 자기 env 이미지 컨테이너에서 실행 — SWE-bench prebuilt 등). harnessSpec 있으면 선언형 command 하니스로 해석.
export async function runAgentJob(job: AgentJob, opts: { driver?: Driver } = {}): Promise<CaseResult> {
  // 사용량 계측(BYO + Assay 소유 버짓): 컨트롤플레인이 워크스페이스/요청 정책으로 결정해 job.meterUsage 로 보낸다.
  // 미지정이면 dev 폴백으로 ASSAY_METER_USAGE env(컨트롤플레인 없이 LocalBackend 직접 디스패치할 때).
  // 켜지면 command 하니스가 모델 호출을 usage-proxy 로 통과시켜 토큰을 회수 → 합성 trace 이벤트로 결과에 실린다.
  const meterUsage = job.meterUsage ?? process.env.ASSAY_METER_USAGE === "1";
  const harness = makeHarness(job.harness.id, job.harness.version, job.harnessSpec, { meterUsage });
  // judge grader 포함: env(키=secretEnv) + job.judge(모델/프로바이더, 컨트롤플레인이 잡에 실음)로 Judge 구성.
  // 원격 alloc 은 백엔드가 judgeEnv 를 env 에 이미 주입하지만, 로컬(process.env)도 동일하게 동작하도록 여기서 병합.
  // 미구성이면 judge 스펙만 skip 점수(일반 eval 이 죽지 않게).
  const env = { ...process.env, ...judgeEnv(job.judge) };
  const graders: Grader[] = makeGradersFromEnv(job.evalCase.graders, env);
  // 환경은 케이스 env.kind 로 선택: prompt(QA) → Prompt, os-use(데스크탑) → OsUse, 그 외 → Repo(코딩/시드).
  // (browser 토폴로지는 ServiceTopologyBackend 가 담당 — 이 로컬 경로 밖.)
  const k = job.evalCase.env.kind;
  const environment: Environment =
    k === "prompt" ? new PromptEnvironment() : k === "os-use" ? new OsUseEnvironment() : new RepoEnvironment();
  return runCase(job.evalCase, {
    driver: opts.driver ?? new LocalDriver(),
    environment,
    harness,
    graders,
    runCtx: runContextFromEnv(),
  });
}
