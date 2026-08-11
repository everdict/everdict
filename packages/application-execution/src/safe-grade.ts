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
// The deadline is the CASE'S OWN and it is SHARED (arch-review 25 P1). `timeoutSec` is what the user declared
// this case may take, grading is part of running it, and a bound taken from the artifact under evaluation
// cannot silently turn a legitimately slow judge (a delegated harness dispatching a whole agent) into a
// failure the way a hard-coded number would. The first version handed each grader that full budget
// independently, so three hanging graders spent three times it — a per-grader timeout wearing a case budget's
// name. `ctx.deadlineAt` is one instant for the whole scoring phase, and each grader gets what is left of it.
//
// …and the timeout CANCELS, it does not merely stop waiting. Revoking a result's authority and revoking the
// work that produces it are two different acts, and doing only the first leaves a judge's provider request
// open and billing after everyone stopped caring what it said. The derived signal is what a grader passes to
// whatever it reaches; the abandoned promise is still discarded, because a grader that ignores the signal
// must not be able to write a score after its authority is gone.
export async function safeGrade(grader: Grader, ctx: GradeContext): Promise<Score[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Aborted on this grader's timeout, and chained to the caller's signal so a cancelled CASE cancels the
  // grader it is currently inside rather than waiting for it to finish being irrelevant.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (ctx.signal?.aborted === true) controller.abort();
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
    // What is LEFT of the case's budget. Never negative: a deadline already past means this grader gets no
    // time at all, which is the honest answer — the case's budget was spent before it started.
    const remainingMs = Math.max(0, ctx.deadlineAt - Date.now());
    const timedOut = Symbol("grader_timeout");
    const raced = await Promise.race([
      grader.grade({ ...ctx, signal: controller.signal }),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), remainingMs);
      }),
    ]);
    if (raced === timedOut) {
      // The result's authority is revoked AND the work is told to stop. Only the first was ever guaranteed.
      controller.abort();
      return [
        {
          graderId: grader.id,
          metric: grader.id,
          status: "unmeasured",
          reason: "grader_timeout",
          // Retryable: a hang is a liveness fact about this attempt, not a verdict about the case. Re-scoring
          // just this grader can recover the measurement, exactly as a transport throw can.
          retryable: true,
          detail: `[grader-timeout] '${grader.id}' did not return within what remained of the case's ${ctx.case.timeoutSec}s budget (${Math.round(remainingMs / 1000)}s)`,
        },
      ];
    }
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
    ctx.signal?.removeEventListener("abort", onOuterAbort);
  }
}
