import { z } from "zod";

// Retry named cases IN PLACE (docs/architecture/in-place-case-retry-spec.md) — the same scorecard, a new
// attempt per case, the attempt each one replaces preserved on the record. Its sibling
// `RerunScorecardBodySchema` is the FORK's body: that one produces a new record and may adjust run config,
// this one produces a new ATTEMPT and may adjust nothing, because a retry re-runs the batch's own sealed
// experiment. The only inputs are WHICH cases and WHY.
export const RetryCasesBodySchema = z.object({
  // The (case, trial) keys to re-run. `trial` is ABSENT for a single-run case and present for one trial of
  // a pass@k batch — never a default of 0, because "this execution has no trial axis" and "trial 0 of
  // several" are different facts and the address is built from the difference.
  cases: z
    .array(
      z.object({
        caseId: z.string().min(1),
        trial: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(1000),
  // Required when any named case already reached a verdict. Retrying a real FAIL until it passes is a thing
  // people do for real reasons, and refusing it outright pushes them back to forking a whole scorecard —
  // which records strictly less. So it is allowed, and the record says who asked and why: the reason lands
  // on the execution revision where a reader of the batch meets it.
  reason: z.string().min(1).max(2000).optional(),
});
export type RetryCasesBody = z.infer<typeof RetryCasesBodySchema>;
