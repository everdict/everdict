import { parseResult } from "../job-result-wire.js";
import type { CaseResult } from "./eval-case.js";
import type { RuntimeWorkRef } from "./runtime-work-ref.js";
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
export function adoptedResultFrom(stdout: string, work: RuntimeWorkRef): CaseResult {
  if (work.verifier === undefined) return parseResult(stdout);
  const envelope = parseVerifierResult(stdout, {
    runId: work.runId,
    caseId: work.verifier.caseId,
    planDigest: work.verifier.planDigest,
    workspaceDigest: work.verifier.workspaceDigest,
  });
  return {
    caseId: envelope.caseId,
    harness: "verifier",
    trace: [],
    scores: envelope.scores,
    // A verifier ran no environment, so it has no snapshot of one — the same shell the in-line path builds,
    // and for the same reason. Nothing persists this shape; the caller takes the scores.
    snapshot: { kind: "prompt", output: "" },
  };
}
