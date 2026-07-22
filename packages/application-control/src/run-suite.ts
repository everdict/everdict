import type { CaseJob, CaseResult, Scorecard, Suite } from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";

// Same (job)→CaseResult signature as Backend/Router/Orchestrator.
export type Dispatch = (job: CaseJob) => Promise<CaseResult>;

// If dispatch throws, don't stop the whole batch (case isolation) — capture it as a failed CaseResult.
// Record the reason as a trace=error event and put one pass:false score so the pass rate/summary counts this case as a failure.
// The classified failure (stage × class × retryable) rides on the result so recovery can act by WHERE it died
// (retry ?class=infra re-runs only infra casualties; agent FAILs are legitimate outcomes and carry no failure).
function failedCaseResult(job: CaseJob, error: unknown): CaseResult {
  const message = error instanceof Error ? error.message : String(error);
  const failure = classifyFailure(error, "dispatch");
  return {
    caseId: job.evalCase.id,
    harness: `${job.harness.id}@${job.harness.version}`,
    ...(job.trial !== undefined ? { trial: job.trial } : {}), // carry the trial index so pass@k/flakiness sees this failure
    trace: [{ t: 0, kind: "error", message }],
    snapshot: { kind: "prompt", output: "" },
    // Carry the reason in detail — the web/CLI surface score.detail as-is, so "why it failed" is visible per case.
    scores: [{ graderId: "dispatch", metric: "error", value: 0, pass: false, detail: `[${failure.class}] ${message}` }],
    failure,
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

// Runs a suite with one harness version → Scorecard. (Version regression = run the same suite as vA/vB and diff.)
export async function runSuite(
  suite: Suite,
  version: string,
  dispatch: Dispatch,
  // onResult: called as each case completes (in completion order; both success and isolated failure) — for progress (step) reporting.
  // signal: cooperative cancellation — after abort, "remaining" cases are not launched (already-launched cases complete naturally and are included in the results).
  // Not a force kill — aborting backend jobs is a separate matter. supersede (re-launch of the same PR) reclaims a stale batch via this signal.
  // retries: extra attempts when dispatch THROWS (transient infra: placement blip, node drain, network) — a
  // CaseResult with failing scores is a legitimate eval outcome and is never retried. Linear backoff between
  // attempts. Default 0 (previous fail-fast behavior). docs/architecture/batch-resilience.md
  opts: {
    concurrency?: number;
    onResult?: (result: CaseResult) => void;
    signal?: AbortSignal;
    retries?: number;
    retryBackoffMs?: number; // base backoff (attempt n waits n×base). Injectable so tests don't sleep.
    // Run each case this many times for pass@k / flakiness — one job per (case, trial), each carrying its trial index.
    // Default 1 leaves trial unset → byte-identical single-run behavior. docs/architecture/trial-based-verdict.md
    trials?: number;
  } = {},
): Promise<Scorecard> {
  // Fan out each case into `trials` jobs. trials=1 keeps the single-run shape (no trial field) for backward compatibility.
  const trials = Math.max(1, opts.trials ?? 1);
  const jobs: CaseJob[] = suite.cases.flatMap((evalCase) =>
    Array.from({ length: trials }, (_, trial) => ({
      evalCase,
      harness: { id: suite.harness.id, version },
      ...(trials > 1 ? { trial } : {}),
    })),
  );
  const retries = Math.max(0, opts.retries ?? 0);
  const backoff = opts.retryBackoffMs ?? 1_000;
  // Isolate dispatch failures per case — even if one case throws, the rest keep running and the failure is captured as a result.
  const results = await mapLimit(jobs, opts.concurrency ?? 4, async (job): Promise<CaseResult | undefined> => {
    if (opts.signal?.aborted) return undefined; // cancelled — unlaunched cases are skipped with no result
    let result: CaseResult | undefined;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 && opts.signal?.aborted) return undefined; // don't burn retries on a reclaimed batch
      try {
        result = await dispatch(job);
        // Stamp the trial index from the job — the agent runs one case and doesn't know which repetition it is.
        if (job.trial !== undefined && result.trial === undefined) result = { ...result, trial: job.trial };
        break;
      } catch (error) {
        // Only retryable-classified failures earn another attempt: config errors (missing secret, bad pin) and
        // fatal infra (OOM with the same limits) fail identically on retry — burning attempts hides the real fix.
        if (attempt >= retries || !classifyFailure(error, "dispatch").retryable) {
          result = failedCaseResult(job, error);
          break;
        }
        await new Promise((r) => setTimeout(r, backoff * (attempt + 1)));
      }
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
