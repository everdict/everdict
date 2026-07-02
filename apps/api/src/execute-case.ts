import type { Dispatcher } from "@assay/backends";
import type { AgentJob, CaseResult, EvalCase } from "@assay/core";

// 실행(Execution) 관심사 — 케이스 하나를 돌려 결과를 만드는 순수 유닛. run/scorecard 가 공유한다.
// "뒤(정산·오프로드·알림)"는 신경 쓰지 않는다 — 그건 오케스트레이션의 몫(RunService/배치가 결과를 받아 settle/notify).
// 두 서비스의 Deps 가 이 형태의 구조적 상위집합이라 각 서비스는 `this.deps` 를 그대로 넘길 수 있다.
// docs/architecture/execution-scoring-orchestration.md
export interface ExecuteCaseDeps {
  dispatcher: Dispatcher;
  // 비공개 repo 시드용 토큰 resolve — evalCase.env.source.connectionId → 외부 계정 연결 토큰(개인 소유, owner 로 resolve).
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
}

// 케이스 repo 시드가 비공개(git + connectionId)면 owner(제출자 subject)의 개인 연결 토큰을 resolve. public/비-repo/미설정이면 undefined.
// 모듈 내부 헬퍼(executeCase 전용) — 외부 노출 안 함.
async function resolveRepoToken(
  repoTokenFor: ExecuteCaseDeps["repoTokenFor"],
  owner: string,
  evalCase: EvalCase,
): Promise<string | undefined> {
  if (!repoTokenFor) return undefined;
  const env = evalCase.env;
  if (env.kind !== "repo") return undefined;
  const src = env.source;
  if (!("git" in src) || !src.connectionId) return undefined;
  return repoTokenFor(owner, src.connectionId).catch(() => undefined);
}

// 순수 실행: 비공개 repo 토큰 resolve+attach → dispatch → CaseResult. 그게 전부다.
// budget admit/settle 은 오케(호출부)의 회계 관심사 — 여기서 하지 않는다(run 은 그냥 실행). 잡은 호출부가 미리
// enrich(tenant/harnessSpec/judge/meterUsage/submittedBy)한 채로 넘긴다.
export async function executeCase(deps: ExecuteCaseDeps, owner: string, job: AgentJob): Promise<CaseResult> {
  const repoToken = await resolveRepoToken(deps.repoTokenFor, owner, job.evalCase);
  const enriched: AgentJob = repoToken ? { ...job, repoToken } : job;
  return deps.dispatcher.dispatch(enriched);
}
