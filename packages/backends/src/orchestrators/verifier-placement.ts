import type { CaseJob, VerifierJob } from "@everdict/contracts";

// ── THE JUDGING HALF IS PLACED LIKE THE AGENT'S HALF (arch-review 57 P0-verifier) ────────────────────
//
// A verifier needs a container, and a container needs a placement. The lanes built one with a cast —
// `{ evalCase: { id, image }, tenant } as unknown as CaseJob` — which is a job with no placement, no world
// and no credentials, so K8s fell through to `this.opts.namespace ?? "default"` instead of `resolve(job)`.
// The two halves of one case could then run in different worlds:
//
//     agent      tenant namespace · gVisor/Kata runtimeClass · tenant-scoped secrets
//     verifier   default namespace · default runtime · the backend's blanket secretEnv
//
// The half missing the isolation is the half that produces the VERDICT, and it runs the task's own image,
// which is untrusted by construction. That is the trust zone's whole purpose, absent exactly where it
// matters most.
//
// Typing the job is the fix, because a typed job cannot omit what a placement reads. Everything below comes
// off the `VerifierJob`, which is the only thing a backend sees — the fields were added to that contract for
// this reason rather than reaching back for the agent's job, which the backend does not have.
export function verifierCaseJob(job: VerifierJob): CaseJob {
  return {
    tenant: job.tenant,
    runId: job.runId,
    // A DISTINCT unit id. The agent's work and the verifier's are two objects in one cluster, and a shared
    // id is how a destructive selector reaches the wrong one — the defect the work handle was introduced to
    // end. Derived rather than random so the same case always names the same verifier unit.
    evalCase: {
      id: `${job.caseId}#verify`,
      // The verifier is handed its procedure through `EVERDICT_VERIFIER_JOB`, never through the case. An
      // empty grader list here is not a shortcut: re-importing the deciding graders would put the private
      // material back into the payload arch-review 56 stripped it from.
      graders: [],
      task: "",
      env: { kind: "repo", source: { path: job.workdir } },
      tags: [],
      timeoutSec: job.timeoutSec,
      ...(job.image !== undefined ? { image: job.image } : {}),
      // The world the case declared. A verdict reached in a bigger box than the run had is a verdict about
      // a different question, and `worldProofCovers` refuses a mismatch on the way in.
      ...(job.resources !== undefined ? { resources: job.resources } : {}),
      // The lane the agent ran on. Without it the verifier resolves against nothing and lands on defaults.
      ...(job.placementTarget !== undefined ? { placement: { target: job.placementTarget } } : {}),
    },
    // Named for what it is. Nothing reconstructs a harness from this — the verifier job-runner branch runs
    // the plan — but a placement reads the field, and an absent one is how the cast used to pass.
    harness: { id: "verifier", version: "1" },
    ...(job.registryAuths !== undefined ? { registryAuths: job.registryAuths } : {}),
  };
}
