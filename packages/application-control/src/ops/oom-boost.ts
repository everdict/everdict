import { type CaseJob, OOM_KILLED } from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";
import type { SpilloverOutcome } from "./runtime-spillover.js";

// OOM escalation ceiling — doubling stops here; past it the fix is a real spec change (raise
// resources.memoryMb), not more automatic headroom. Shared by the in-batch auto-boost below and the
// retry-failed compounding path (docs/architecture/batch-resilience.md).
export const OOM_ESCALATION_CAP_MB = 16_384;

// In-batch OOM auto-boost (opt-in). An OOM_KILLED case is fatal infra — deliberately NOT retryable, because
// the same resources die the same way. The retry-failed path already re-runs such cases with doubled memory,
// but that costs a human round-trip per doubling. With the batch's oomAutoBoost knob set, the doubling happens
// INSIDE the running batch instead: catch the OOM, double the job-only resources.memoryMb, re-dispatch, repeat
// up to the cap. Opt-in because every boost re-runs the case — more compute the submitter must have chosen.
export interface OomBoostOpts {
  enabled: boolean;
  capMb?: number; // default OOM_ESCALATION_CAP_MB
  onBoost?: (caseId: string, fromMb: number, toMb: number) => void; // progress-step / metrics visibility
}

export async function executeWithOomBoost(
  run: (job: CaseJob) => Promise<SpilloverOutcome>,
  job: CaseJob,
  opts: OomBoostOpts,
): Promise<SpilloverOutcome> {
  if (!opts.enabled) return run(job);
  const capMb = opts.capMb ?? OOM_ESCALATION_CAP_MB;
  let attempt = job;
  for (;;) {
    try {
      return await run(attempt);
    } catch (err) {
      if (classifyFailure(err, "dispatch").code !== OOM_KILLED) throw err;
      const spec = attempt.harnessSpec;
      if (spec?.kind !== "command") throw err; // only command harnesses declare boostable resources
      const currentMb = spec.resources?.memoryMb ?? 1024;
      if (currentMb >= capMb) throw err; // at the ceiling — surface the OOM (the fix is a spec change)
      const nextMb = Math.min(capMb, currentMb * 2);
      opts.onBoost?.(job.evalCase.id, currentMb, nextMb);
      // Job-only boost — the registry spec is never mutated; non-OOM cases keep the declared resources.
      attempt = { ...attempt, harnessSpec: { ...spec, resources: { ...spec.resources, memoryMb: nextMb } } };
    }
  }
}
