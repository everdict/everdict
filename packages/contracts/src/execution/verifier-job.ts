import { z } from "zod";
import { RepoSnapshotSchema } from "./environment.js";
import { GraderSpecSchema } from "./eval-case.js";

// ── THE JUDGING HALF, AS A DISPATCHABLE UNIT (arch-review 56, Wave I) ────────────────────────────────
//
// Wave B closed the task-format disclosure by REFUSING, because the job payload is readable by the harness that
// runs in the container it is set on. Wave H split a case into the half the agent gets and the half that
// decides. This is where the second half runs: its own job, its own container, dispatched after the agent's
// has returned.
//
// What makes it a boundary rather than a discipline is that the two payloads are never in one process. The
// agent's job carries no tests and no verifier credentials because they are HERE, and this job is built by
// the control plane and shipped to a container the agent never touched. The grader-side guards Wave B added
// (empty the reward namespace, refuse a traversal path) stay as defence in depth, but nothing depends on
// their ordering any more — there is no ordering between two containers.
//
// The agent's work travels as the snapshot the environment already produces: a diff. That is what makes this
// affordable — no image commit, no volume export, just the bytes the case already had to compute to record
// what changed.
export const VerifierPlanRefSchema = z.object({
  // WHICH verifier procedure this is, by content (see `verifierPlanOf`, @everdict/domain). The case's record
  // keeps it so a replay can say the thing that judged it then is the thing in front of it now.
  digest: z.string().min(1),
  // The deciding graders, configuration intact. Present ONLY on this job.
  graders: z.array(GraderSpecSchema),
});
export type VerifierPlanRef = z.infer<typeof VerifierPlanRefSchema>;

export const VerifierJobSchema = z.object({
  runId: z.string().min(1),
  tenant: z.string().min(1),
  caseId: z.string().min(1),
  // The same image the case ran in, so the verifier's toolchain is the task's own. A verifier that ran
  // somewhere else would be measuring a different world than the one the agent worked in.
  image: z.string().optional(),
  workdir: z.string().default("/app"),
  // What the agent LEFT. A repo snapshot only: the browser and os-use environments have no file tree to
  // re-create, and a verifier for those is not this shape.
  workspace: RepoSnapshotSchema,
  plan: VerifierPlanRefSchema,
});
export type VerifierJob = z.infer<typeof VerifierJobSchema>;
