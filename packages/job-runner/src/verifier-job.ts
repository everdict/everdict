import { safeGrade } from "@everdict/application-execution";
import {
  BadRequestError,
  type Driver,
  type EvalCase,
  type Score,
  UpstreamError,
  type VerifierJob,
} from "@everdict/contracts";
import { makeGraders } from "./registry.js";

// ── THE VERDICT IS REACHED SOMEWHERE THE AGENT NEVER WAS (arch-review 56, Wave I) ────────────────────
//
// A verifier job is the judging half of a case, run in its own container after the agent's has returned.
// See `VerifierJob` (@everdict/contracts) for why the two payloads are never in one process; what happens
// here is the mechanical part:
//
//   provision (the task's own image, so the toolchain is the task's)
//     → restore the agent's work from the snapshot diff
//     → empty the reward namespace it is about to read
//     → run the deciding graders
//     → release, always
//
// The restore is a `git apply` of the diff the environment already produced. That is what makes a second
// container affordable: no image commit, no volume export, just the bytes the case had to compute anyway to
// record what changed.
export async function runVerifierJob(job: VerifierJob, opts: { driver: Driver }): Promise<Score[]> {
  // A job with nothing to decide would provision a container, run nothing, and report an absence as a
  // measurement. `verifierPlanOf` answers `undefined` for such a case, so arriving here means a dispatcher
  // built the job anyway — which is a bug in the dispatcher, not a verdict.
  if (job.plan.graders.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { runId: job.runId, caseId: job.caseId },
      "this verifier job carries no deciding grader — there is nothing to verify, and an empty run is not a measurement.",
    );

  // A COMPLETE spec, not a cast (arch-review 57 P0). This used to be `provision({image} as never)`, and
  // `ComputeSpec` requires `os`: `LocalDriver.provision` refuses anything but `os === "linux"` on its first
  // line, so every verifier job that reached a real driver was rejected before it ran. The cast is the whole
  // reason the build was green over a call that could not succeed — see `scripts/check-constructed-casts.mjs`.
  const compute = await opts.driver.provision({
    os: "linux",
    needs: ["shell"],
    ...(job.image !== undefined ? { image: job.image } : {}),
    ...(job.tenant !== "" ? { tenant: job.tenant } : {}),
  });
  try {
    const workdir = job.workdir === "" ? "/app" : job.workdir;
    // The agent's work, restored. `--allow-empty` because a run that changed nothing is a real outcome (the
    // verifier is entitled to score it zero), not a reason to fail the job.
    if (job.workspace.diff !== "") {
      await compute.writeFile(`${workdir}/.everdict-agent.patch`, job.workspace.diff);
      const applied = await compute.exec(
        "git apply --allow-empty --whitespace=nowarn .everdict-agent.patch && rm -f .everdict-agent.patch",
        { cwd: workdir },
      );
      // ── A RESTORE THAT FAILED IS NOT A WORKSPACE (arch-review 57 P0) ──────────────────────────────
      //
      // `exec` reports a non-zero command as an ExecResult, not an exception, so the previous version ran the
      // graders over whatever the container happened to hold — a pristine image — and returned that as the
      // agent's verdict. A wrong number is worse than no number: `unmeasured` is visible and a zero is not.
      if (applied.exitCode !== 0)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { caseId: job.caseId, exitCode: applied.exitCode },
          `the agent's workspace could not be restored (git apply exited ${applied.exitCode}): ${applied.stderr.trim() || applied.stdout.trim()}`,
        );
    }
    // The reward namespace is emptied by the grader that READS it (`RewardFileGrader`), not here. This used
    // to clear a hardcoded `/logs/verifier` — a second copy of a path the grader already owns as a config
    // field, so a plan that published elsewhere had the wrong directory emptied and its own one left alone
    // (rule `protocol` L3: a predicate written twice has already diverged). One owner, and it is the reader.

    // ── A REAL GradeContext, NOT A CAST (arch-review 57) ────────────────────────────────────────────
    //
    // This was `safeGrade(grader, { compute, result: { caseId } } as never)`. `GradeContext` declares `case`,
    // `deadlineAt`, `trace` and `snapshot`; that object had none of them and carried a `result` field the type
    // does not have. The cast is why it compiled, and `deadlineAt: undefined` is why it could never work —
    // `safeGrade` computes `Math.max(0, ctx.deadlineAt - Date.now())`, which is NaN, and a NaN timeout fires
    // on the first tick. Every grader lost its race before running.
    //
    // Everything below is carried on the job, except `case`, which is deliberately NOT: the whole point of a
    // verifier job is that it does not hold the agent's case document. What the graders in a verifier plan
    // read is `compute` and their own config; what `safeGrade` reads from `case` is the budget, which now
    // travels as `timeoutSec`. So the case here states its own identity and nothing it does not know.
    const deadlineAt = Date.now() + job.timeoutSec * 1000;
    const gradeCase: EvalCase = {
      id: job.caseId,
      task: "",
      env: { kind: "repo", source: { path: workdir } },
      graders: job.plan.graders,
      tags: [],
      timeoutSec: job.timeoutSec,
      ...(job.image !== undefined ? { image: job.image } : {}),
    };

    const graders = makeGraders(job.plan.graders);
    const scores: Score[] = [];
    for (const grader of graders)
      scores.push(
        ...(await safeGrade(grader, {
          case: gradeCase,
          deadlineAt,
          trace: [],
          snapshot: job.workspace,
          compute,
        })),
      );
    return scores;
  } finally {
    // A verifier container that outlived its job is a leak the agent's lane never had, because this one is
    // created per case rather than per dispatch.
    await compute.dispose().catch(() => undefined);
  }
}
