import type { AgentJob, CaseResult, Scorecard, Suite } from "@assay/core";

// Backend/Router/Orchestrator 의 (job)→CaseResult 시그니처와 동일.
export type Dispatch = (job: AgentJob) => Promise<CaseResult>;

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
  opts: { concurrency?: number } = {},
): Promise<Scorecard> {
  const jobs: AgentJob[] = suite.cases.map((evalCase) => ({ evalCase, harness: { id: suite.harness.id, version } }));
  const results = await mapLimit(jobs, opts.concurrency ?? 4, dispatch);
  return { suiteId: suite.id, harness: `${suite.harness.id}@${version}`, results };
}
