import type { GradeContext, Grader, Score } from "@everdict/core";

// Isolate a single grader's run-time failure so it can't sink the whole case (or drop the sibling
// graders' real scores). A grader that THROWS at scoring time — most often the judge grader on a
// transient LLM/transport hiccup — becomes a VISIBLE error score instead of propagating out of the
// grade loop and forcing runCase / the service backend to record the ENTIRE case as an error.
// `pass` is left undefined (excluded from passRate — an honest "not scored", not a false FAIL, so a
// judge blip doesn't count against the agent); the message is surfaced in `detail` for triage.
// Run-time twin of skipGrader (judge-env.ts), which does the same for construction-time failures.
export async function safeGrade(grader: Grader, ctx: GradeContext): Promise<Score> {
  try {
    return await grader.grade(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { graderId: grader.id, metric: grader.id, value: 0, detail: `[grader-error] ${message}` };
  }
}
