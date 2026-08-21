import { parseResult } from "../job-result-wire.js";
import type { CaseResult } from "./eval-case.js";
import type { RuntimeWorkRef } from "./runtime-work-ref.js";
import type { VerifierInvocation } from "./verifier-job.js";
import { parseVerifierResult } from "./verifier-result-wire.js";

// ── READING BACK A CONTAINER NOBODY IS WAITING ON (arch-review 59 P1) ────────────────────────────────
//
// Adoption is the path that recovers an answer from work this process did not dispatch — after a restart, a
// failover, a lease change. Every managed lane implemented it as "fetch the logs, `parseResult`", because
// when it was written there was one document a container could print.
//
// There are two. A verifier prints its own sentinel and its own schema, deliberately unreadable as a case
// result (arch-review 58), and a verifier gets its own attempt row under the SAME `executionId` as the agent
// half — so its handle is in the list a run's boot recovery enumerates. The case parser finds no sentinel
// there, throws, and the lane answers `unknown`. Recovery treats the first `unknown` as `retry_later` for the
// whole run, so a standalone run with a private verifier deferred on every boot, escalating after five
// attempts, while its agent's compute sat perfectly adoptable one handle away.
//
// The fix is not a second adoption method — it is admitting that "which protocol reads this container's
// answer" is a property of the WORK, and putting it on the handle (see `verifier` on `RuntimeWorkRefSchema`).
// One reader here, called by every lane, so a third document could not be added to one lane and forgotten in
// the other — which is the shape rule `backends` now names outright: a specialized lane calls the common
// path, it does not re-implement it.
//
// The verifier branch carries its identity into `parseVerifierResult`, which REQUIRES it: a verdict adopted
// after a restart is exactly as much this case's as one read in-line, and it gets exactly the same check.
// ── …AND WHICH STAGE PRODUCED IT (arch-review 60 P0) ────────────────────────────────────────────────
//
// The first version answered a `CaseResult` for both, because the verifier's scores had to reach a caller
// that wanted that shape. The shell it built — `harness: "verifier"`, empty trace, empty snapshot — carried a
// comment saying nothing persists it, and then something did: boot recovery iterates a run's handles, takes
// the FIRST adopted answer, and hands it to `Run.adopt`, which writes `status: "succeeded"` with that value
// as the run's result and asks nothing about where it came from.
//
//     agent Job finished, its result only in the dead process's memory, its Job reaped
//     verifier Job still there
//     → agent handle absent · verifier handle ADOPTED
//     → run succeeded, harness "verifier", no agent trace, no snapshot, verifier scores as the whole evidence
//
// A value shaped like the final document IS the final document to every caller that does not ask. So the
// answer is a stage-tagged union and there is no shape for a caller to mistake: settling a verifier adoption
// as a case result stops type-checking, which is the only version of this that stays fixed.
export type AdoptedWork = { stage: "case"; result: CaseResult } | { stage: "verifier"; invocation: VerifierInvocation };

export function adoptedResultFrom(stdout: string, work: RuntimeWorkRef): AdoptedWork {
  if (work.verifier === undefined) return { stage: "case", result: parseResult(stdout) };
  const envelope = parseVerifierResult(stdout, {
    runId: work.runId,
    caseId: work.verifier.caseId,
    planDigest: work.verifier.planDigest,
    workspaceDigest: work.verifier.workspaceDigest,
  });
  // The verifier lane's OWN return type, not a case-shaped shell of it: this is what `withVerifierPass`
  // consumes, and answering it here means a recovered verdict re-enters the same merge an in-line one does
  // rather than arriving as something else's document.
  return {
    stage: "verifier",
    invocation: {
      planDigest: envelope.planDigest,
      workspaceDigest: envelope.workspaceDigest,
      work,
      scores: envelope.scores,
    },
  };
}
