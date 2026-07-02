import { type BudgetTracker, type Dispatcher, costOf } from "@assay/backends";
import type { AgentJob, CaseResult, EvalCase } from "@assay/core";

// run/scorecard 가 공유하는 per-case 실행 수명의 의존성. 두 서비스의 Deps 가 이 형태의 구조적 상위집합이라
// 각 서비스는 `this.deps` 를 그대로 넘길 수 있다(중복 배선 없음).
export interface ExecuteCaseDeps {
  dispatcher: Dispatcher;
  budget?: BudgetTracker; // settle 담당(admit 은 호출부). 미설정이면 no-op.
  // 비공개 repo 시드용 토큰 resolve — evalCase.env.source.connectionId → 외부 계정 연결 토큰(개인 소유, owner 로 resolve).
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
}

// 케이스 repo 시드가 비공개(git + connectionId)면 owner(제출자 subject)의 개인 연결 토큰을 resolve. public/비-repo/미설정이면 undefined.
export async function resolveRepoToken(
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

// per-case 실행 수명(run/scorecard 공유): 비공개 repo 토큰 resolve+attach → dispatch → settle(self-hosted 제외).
// budget.admit 은 호출부 책임이다 — run 은 submit 에서 동기로(402 게이트), scorecard 는 배치 per-case 로 admit 하므로
// 여기서 중복 admit 하지 않는다. 잡은 호출부가 미리 enrich(tenant/harnessSpec/judge/meterUsage/submittedBy)한 채로 넘긴다.
export async function executeCase(
  deps: ExecuteCaseDeps,
  tenant: string,
  owner: string,
  job: AgentJob,
): Promise<CaseResult> {
  const repoToken = await resolveRepoToken(deps.repoTokenFor, owner, job.evalCase);
  const enriched: AgentJob = repoToken ? { ...job, repoToken } : job;
  const result = await deps.dispatcher.dispatch(enriched);
  // 셀프호스티드 실행은 유저 자기 로그인이 결제 주체 — 워크스페이스 usd/tokens 버짓을 끌어쓰지 않는다.
  if (result.provenance?.ranOn !== "self-hosted") deps.budget?.settle(tenant, costOf(result));
  return result;
}
