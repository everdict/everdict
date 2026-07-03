import type { AgentJob, CaseResult, Scorecard, Suite } from "@assay/core";

// Backend/Router/Orchestrator 의 (job)→CaseResult 시그니처와 동일.
export type Dispatch = (job: AgentJob) => Promise<CaseResult>;

// dispatch 가 던지면 배치 전체를 멈추지 말고(케이스 격리) 실패 CaseResult 로 박제한다.
// trace=error 이벤트로 사유를 남기고, scores 에 pass:false 한 건을 둬서 통과율/요약이 이 케이스를 실패로 집계하게 한다.
function failedCaseResult(job: AgentJob, error: unknown): CaseResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    caseId: job.evalCase.id,
    harness: `${job.harness.id}@${job.harness.version}`,
    trace: [{ t: 0, kind: "error", message }],
    snapshot: { kind: "prompt", output: "" },
    // detail 에 사유를 실어 둔다 — 웹/CLI 가 score.detail 을 그대로 노출하므로 "왜 실패했는지"가 케이스 단위로 보인다.
    scores: [{ graderId: "dispatch", metric: "error", value: 0, pass: false, detail: message }],
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      if (item === undefined) continue;
      results[idx] = await fn(item);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// 스위트를 한 하니스 버전으로 실행 → Scorecard. (버전 회귀는 같은 스위트를 vA/vB 로 돌려 diff)
export async function runSuite(
  suite: Suite,
  version: string,
  dispatch: Dispatch,
  // onResult: 각 케이스가 완료될 때(완료 순서; 성공/격리실패 모두) 호출 — 진행 과정(스텝) 보고용.
  // signal: 협조적 취소 — abort 후엔 "남은" 케이스를 발사하지 않는다(이미 발사된 케이스는 자연 완료 후 결과에 포함).
  // 강제 kill 이 아니다 — 백엔드 잡 중단은 별개 문제. supersede(같은 PR 재발사)가 이 시그널로 낡은 배치를 회수한다.
  opts: { concurrency?: number; onResult?: (result: CaseResult) => void; signal?: AbortSignal } = {},
): Promise<Scorecard> {
  const jobs: AgentJob[] = suite.cases.map((evalCase) => ({ evalCase, harness: { id: suite.harness.id, version } }));
  // 케이스별로 dispatch 실패를 격리 — 한 케이스가 던져도 나머지는 계속 돌고, 실패는 결과로 박제된다.
  const results = await mapLimit(jobs, opts.concurrency ?? 4, async (job): Promise<CaseResult | undefined> => {
    if (opts.signal?.aborted) return undefined; // 취소됨 — 미발사 케이스는 결과 없이 스킵
    let result: CaseResult;
    try {
      result = await dispatch(job);
    } catch (error) {
      result = failedCaseResult(job, error);
    }
    opts.onResult?.(result);
    return result;
  });
  return {
    suiteId: suite.id,
    harness: `${suite.harness.id}@${version}`,
    results: results.filter((r): r is CaseResult => r !== undefined),
  };
}
