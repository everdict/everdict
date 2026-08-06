import { type GradeContext, type Grader, type Score, toScores } from "@everdict/contracts";

// Isolate a single grader's run-time failure so it can't sink the whole case (or drop the sibling
// graders' real scores). A grader that THROWS at scoring time — most often the judge grader on a
// transient LLM/transport hiccup — becomes a VISIBLE unmeasured score instead of propagating out of
// the grade loop and forcing runCase / the service backend to record the ENTIRE case as an error.
// status "unmeasured" keeps the failure out of EVERY aggregate (mean/passRate/diff — isMeasured is the
// gate), so a judge blip neither counts against the agent nor drags a metric mean toward 0; the message
// is surfaced in `detail` for triage. retryable: a scoring-time throw is transient by default (transport
// hiccup) — re-running just this grader can recover the measurement without re-running the case.
// Returns the flattened Score[] — a multi-metric grader's scores are collected as-is, a failure is one score.
export async function safeGrade(grader: Grader, ctx: GradeContext): Promise<Score[]> {
  try {
    return toScores(await grader.grade(ctx));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        graderId: grader.id,
        metric: grader.id,
        value: 0,
        status: "unmeasured",
        reason: "grader_error",
        retryable: true,
        detail: `[grader-error] ${message}`,
      },
    ];
  }
}
