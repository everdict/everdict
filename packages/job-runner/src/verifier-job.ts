import { safeGrade } from "@everdict/application-execution";
import { BadRequestError, type Driver, type Score, type VerifierJob, shq } from "@everdict/contracts";
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

  const compute = await opts.driver.provision({
    ...(job.image !== undefined ? { image: job.image } : {}),
  } as never);
  try {
    const workdir = job.workdir === "" ? "/app" : job.workdir;
    // The agent's work, restored. `--allow-empty` because a run that changed nothing is a real outcome (the
    // verifier is entitled to score it zero), not a reason to fail the job.
    if (job.workspace.diff !== "") {
      await compute.writeFile(`${workdir}/.everdict-agent.patch`, job.workspace.diff);
      await compute.exec(
        `cd ${shq(workdir)} && git apply --allow-empty --whitespace=nowarn .everdict-agent.patch && rm -f .everdict-agent.patch`,
      );
    }
    // …and the namespace the verdict comes out of starts empty. The container is fresh, so there is nothing
    // of the agent's here to clear — this is the assertion that it STAYS that way if anyone ever reuses a
    // compute for both halves.
    await compute.exec("rm -rf /logs/verifier && mkdir -p /logs/verifier");

    const graders = makeGraders(job.plan.graders);
    const scores: Score[] = [];
    for (const grader of graders)
      scores.push(
        ...(await safeGrade(grader, {
          compute,
          result: { caseId: job.caseId },
        } as never)),
      );
    return scores;
  } finally {
    // A verifier container that outlived its job is a leak the agent's lane never had, because this one is
    // created per case rather than per dispatch.
    await compute.dispose().catch(() => undefined);
  }
}
