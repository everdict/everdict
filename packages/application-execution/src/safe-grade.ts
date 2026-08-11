import {
  type GradeContext,
  type Grader,
  type Score,
  type ScoreProducer,
  sanitizeScore,
  toScores,
} from "@everdict/contracts";

// Isolate a single grader's run-time failure so it can't sink the whole case (or drop the sibling
// graders' real scores). A grader that THROWS at scoring time — most often the judge grader on a
// transient LLM/transport hiccup — becomes a VISIBLE unmeasured score instead of propagating out of
// the grade loop and forcing runCase / the service backend to record the ENTIRE case as an error.
// status "unmeasured" keeps the failure out of EVERY aggregate (mean/passRate/diff — isMeasured is the
// gate), and the variant carries NO `value` at all, so a judge blip has no number to leak into a mean;
// the message is surfaced in `detail` for triage. retryable: a scoring-time throw is transient by default
// (transport hiccup) — re-running just this grader can recover the measurement without re-running the case.
// Returns the flattened Score[] — a multi-metric grader's scores are collected as-is, a failure is one score.
// A HANG IS A FAILURE THAT BECOMES NOTHING AT ALL — which is worse than one that becomes a wrong number.
//
// This function has always caught a grader that THROWS. A grader that simply never returns was outside its
// vocabulary: the await sat there, the case never settled, and the batch that was waiting on it stopped
// making progress without recording a single fact about why. A judge whose transport hangs with no socket
// timeout, a script grader waiting on a process that will not exit, a store read against an unreachable
// dependency — none of them throw.
//
// The deadline is the CASE'S OWN, not a constant this module invents. `timeoutSec` is what the user declared
// this case may take, grading is part of running it, and a bound taken from the artifact under evaluation
// cannot silently turn a legitimately slow judge (a delegated harness dispatching a whole agent) into a
// failure the way a hard-coded number would.
//
// The abandoned promise keeps running — JavaScript has no way to cancel one — and that is safe here because
// its result is discarded: the score for this grader is already decided, and a late resolution has nowhere
// to write. What must not happen, and does not, is the timer holding the process open after the race is
// over.
export async function safeGrade(grader: Grader, ctx: GradeContext): Promise<Score[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // sanitizeScore: a grader that RETURNS garbage (NaN value, empty ids) becomes a visible INVALID score —
    // a grader bug to fix, excluded from every aggregate — never a number that flows downstream.
    // …and the metric NAMES are part of that contract (arch-review 17 P0-2). A producer that chooses its own
    // name chooses its own authority in a system where the name IS the authority assignment, so the
    // collection boundary — which knows what this grader's spec DECLARED, and the grader cannot speak for —
    // is where a reserved name without a declaration becomes a visible invalid row.
    const producer: ScoreProducer = {
      kind: "grader",
      id: grader.id,
      ...(grader.ownsMetrics !== undefined ? { ownsMetrics: grader.ownsMetrics } : {}),
      ...(grader.ownsJudgeVerdict === true ? { ownsJudgeVerdict: true } : {}),
    };
    const deadlineMs = ctx.case.timeoutSec * 1000;
    const timedOut = Symbol("grader_timeout");
    const raced = await Promise.race([
      grader.grade(ctx),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), deadlineMs);
      }),
    ]);
    if (raced === timedOut)
      return [
        {
          graderId: grader.id,
          metric: grader.id,
          status: "unmeasured",
          reason: "grader_timeout",
          // Retryable: a hang is a liveness fact about this attempt, not a verdict about the case. Re-scoring
          // just this grader can recover the measurement, exactly as a transport throw can.
          retryable: true,
          detail: `[grader-timeout] '${grader.id}' did not return within the case's ${ctx.case.timeoutSec}s budget`,
        },
      ];
    return toScores(raced).map((s) => sanitizeScore(s, producer));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        graderId: grader.id,
        metric: grader.id,
        status: "unmeasured",
        reason: "grader_error",
        retryable: true,
        detail: `[grader-error] ${message}`,
      },
    ];
  } finally {
    // Cleared on every path — a live timer would keep the event loop (and the worker process) alive for the
    // remainder of a 30-minute budget after the case had already settled.
    if (timer !== undefined) clearTimeout(timer);
  }
}
