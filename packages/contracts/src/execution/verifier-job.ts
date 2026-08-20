import { z } from "zod";
import { RegistryAuthSchema } from "../infra/image-ref.js";
import { ResourceRequestSchema } from "../infra/world.js";
import { RepoSnapshotSchema } from "./environment.js";
import { GraderSpecSchema } from "./eval-case.js";
import { ScoreSchema } from "./grader.js";
import { ImageProvenanceSchema } from "./image-provenance.js";
import { RuntimeWorkRefSchema } from "./runtime-work-ref.js";

// ── THE JUDGING HALF, AS A DISPATCHABLE UNIT (arch-review 56, Wave I) ────────────────────────────────
//
// Wave B closed the payload disclosure by REFUSING, because the job payload is readable by the harness that
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
  // ── WHERE IT MAY RUN, CARRIED (arch-review 57 P0) ────────────────────────────────────────────────
  //
  // The judging half needs a lane, and it is not free to pick one: it must be a lane of the SAME tenant that
  // ran the agent, because the verifier reads that tenant's task image and holds that tenant's credentials.
  // The first version of this type left the field out and the composition asked for "any runtime" by passing
  // `undefined` — which the runtime iterator reads as an EMPTY target set, not as a wildcard. So no backend
  // was ever visited, the dispatch threw NOT_FOUND, and `withVerifierPass` recorded the throw as
  // `tests_pass: unmeasured`. Every private-verifier case ran its agent and then reported that it could not
  // be judged, in a deployment that could judge it.
  //
  // It is the agent's own `placement.target`, verbatim, so the two halves cannot drift onto different
  // runtimes: whatever ran the agent is what the verifier resolves against.
  placementTarget: z.string().optional(),
  // ── THE JUDGING BUDGET (arch-review 57, found while fixing the P0 above) ─────────────────────────
  //
  // `safeGrade` gives each grader what is left of `ctx.deadlineAt`. The first version of this lane built its
  // GradeContext with a cast and passed no deadline at all, so `Math.max(0, undefined - Date.now())` was NaN
  // and `setTimeout(fn, NaN)` fires IMMEDIATELY — every verifier grader lost its race on the first tick and
  // returned `unmeasured{grader_timeout}`. That is a fourth independent breakage behind the three the review
  // named: fixing routing, the ComputeSpec and the paths would still have produced no verdict.
  //
  // It is the case's own declared budget, carried, so the verifier is bounded by the same number the agent
  // was rather than by a constant invented here.
  timeoutSec: z.number().positive(),
  // ── WHAT THE PLACEMENT NEEDS, CARRIED (arch-review 57 P0-verifier) ───────────────────────────────
  //
  // The backend only ever sees this job, so anything its placement depends on has to be here. Before these
  // fields the K8s lane built a synthetic `CaseJob` with a cast and fell back to `this.opts.namespace ??
  // "default"` — the two halves of one case could run in different worlds, with the verdict-producing half
  // outside the tenant's trust zone while running the task's own untrusted image.
  //
  // The DECLARED WORLD: a case judged in a different box than it ran in is judged against a different
  // question, and a container task declares one routinely.
  resources: ResourceRequestSchema.optional(),
  // …and the credentials for the task image. A private image the agent could pull and the verifier could
  // not is a verdict that simply never happens.
  registryAuths: z.array(RegistryAuthSchema).optional(),
});
export type VerifierJob = z.infer<typeof VerifierJobSchema>;

// THE ONE SERIALIZER FOR THE JUDGING HALF, mirroring `caseJobPayload`. There is no refusal to make here — a
// verifier job is BUILT from the private material, and it goes to a container the agent was never in. What
// keeps that true is that nothing constructs one except `withVerifierPass`, and nothing else ever sets
// `EVERDICT_VERIFIER_JOB`.
// ── WHAT THE JUDGING HALF REPORTS BACK (arch-review 57 P1) ───────────────────────────────────────────
//
// A lane used to answer `Score[]`, and those numbers were appended to the case result with nothing attached.
// Everything that makes a verdict defensible — which procedure, reading which workspace, in which runtime —
// is known at the invocation and was discarded one frame later, so a replay could say `tests_pass` was 1 and
// not say what was run to get it (rule `protocol` L3: provenance is born at the source).
//
// The wire shape lives here because a backend produces it; `verifierReceiptOf` (@everdict/domain) is what
// turns it into the sealed receipt, since digesting is domain work.
export const VerifierInvocationSchema = z.object({
  planDigest: z.string().min(1),
  workspaceDigest: z.string().min(1),
  // WHERE it ran. Absent only on a lane that places nothing it can name.
  work: RuntimeWorkRefSchema.optional(),
  // …and in WHICH WORLD, three-valued as everywhere else.
  imageProvenance: ImageProvenanceSchema.optional(),
  scores: z.array(ScoreSchema),
});
export type VerifierInvocation = z.infer<typeof VerifierInvocationSchema>;

export function verifierJobPayload(job: VerifierJob): string {
  return Buffer.from(JSON.stringify(job)).toString("base64");
}
