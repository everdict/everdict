import type { GradeContext, JudgeSpec, Placement, Score } from "@everdict/contracts";
import type { JudgeEvidenceScope } from "@everdict/domain";

// The digests a pass pinned for the documents THIS judge names — its rubric, its delegated harness, its model.
// They travel to the runner because VERIFICATION BELONGS AT THE READ THAT PRODUCES THE BYTES ACTUALLY USED
// (arch-review 20 P0-4): `ScoringService` verified copies it read while resolving, and then the runner read
// each document AGAIN at use. A shadow landing between the two reads was verified in one and consumed in the
// other, which is the check looking at a document nobody executed.
export interface NestedDocumentPins {
  rubricDigest?: string;
  harnessDigest?: string;
  modelDigest?: string;
  // The delegated harness's OWN model documents — carried onto the job the harness judge dispatches, so the
  // dispatcher that materializes those bindings verifies them exactly as it does a batch's own harness.
  harnessModelDigest?: string;
  harnessServiceModelDigests?: Record<string, string>;
}

// Judge runner PORT — JudgeSpec + tenant + GradeContext (trace) → Score[]. The control plane judges from the trace.
// The default impl (defaultJudgeRunner) wires the graders transports (anthropic/openai/harness) and lives in apps/api
// infrastructure — it composes @everdict/graders values, which application-control must not import. ScoringService
// depends on this interface only. Moved here in re-architecture P2 S3 (the impl kept the skip-valve).
export interface JudgeRunner {
  // placement = the source run's placement (where the observations are). A harness judge prefers spec.runtime, else inherits this (co-locate).
  // submittedBy = the producing run's submitter subject — code/harness judges dispatch a wrapper job, and a co-located
  // self-hosted target (self:<runnerId>) resolves its owner from submittedBy; dropping it makes that dispatch fail the
  // ownership check and the judge skip. Undefined on the ingest path (no producing run / no self-hosted co-locate).
  // runId = the judged case's CHILD RUN id, when the caller has one. The runner uses it to seal the judge's own
  // execution (the verdict's LLM call / the dispatched judge job's trace) as a `judge:<id>` plane on that run's
  // trajectory — evidence of how the verdict was produced, beside the evidence it judged. Undefined (ingest, no
  // child run) = the judge still runs and is still metered; only the evidence plane has nowhere to land.
  run(
    spec: JudgeSpec,
    tenant: string,
    ctx: GradeContext,
    placement?: Placement,
    submittedBy?: string,
    runId?: string,
    // What this pass pinned beneath the judge document. Absent = nothing was pinned (a pass sealed before
    // digests existed, or a facet with no document behind it) — the runner reads as it always did.
    pins?: NestedDocumentPins,
    // MAY THIS STILL BE PUBLISHED? Asked immediately before the judge's own execution is sealed as a
    // `judge:<id>` plane, and only then — a judge call is the longest thing in a case, so proving authority
    // before it starts answers a question about a moment that has passed by the time the answer is used
    // (arch-review 34 P1). A driver displaced mid-judge would otherwise plant the permanent judge plane of a
    // case whose child settle is refused a moment later, and the successor's re-drive loses its own seal to
    // it. Absent = nothing to prove (ingest, a single-replica install), and the plane seals as before.
    publishWhen?: () => Promise<boolean>,
    // WHICH JUDGMENT INVOCATION this execution belongs to. The trajectory ledger keeps the FIRST seal per
    // (runId, emitter), so a judge execution sealed under an emitter a LATER execution will reuse is the one
    // that becomes the permanent evidence — whoever wins the score.
    //
    // A bare pass id closed only half of that (arch-review 41 P0-audit): it separates revisions, and within
    // ONE Temporal pass a case/judge is legitimately re-invoked — a retry, a later round — with the winner
    // decided by the judgment CLAIM, not by who sealed first. So a caller that HAS a claim passes the whole
    // scope and the emitter carries it (`judge:<id>#<pass>.<gen>.<attempt>`, arch-review 51 Track C); a
    // caller whose path cannot re-invoke passes the bare pass id it always did; absent = the initial batch's
    // judging, whose bare `judge:<id>` emitter is that one shot. `judgeEvidenceEmitter` (@everdict/domain)
    // owns the grammar — never spell it at a call site.
    scoringPass?: string | JudgeEvidenceScope,
  ): Promise<JudgeInvocation>;
}

// ── WHAT A JUDGE ANSWERED, AND WHETHER IT CAN BE RE-INSPECTED ───────────────────────────────────────
//
// The port answered a bare `Score[]`, and sealing the judge's own execution as evidence is best-effort by
// contract — evidence, never lifecycle, because losing the seal must not lose a real verdict. That contract
// is right and the SILENCE around it was not: the seal's failure was swallowed, so a judgment whose "how" is
// gone came back indistinguishable from one whose "how" is on file.
//
// The verifier lane already answers an invocation for the same reason (`VerifierInvocation`). This is its
// twin, and `evidenceStatus` is what turns it into the case's judgment plane.
export interface JudgeInvocation {
  scores: Score[];
  evidence: JudgeEvidenceOutcome;
}

// ── AND EXACTLY WHICH EVIDENCE, NOT JUST WHETHER THERE IS SOME (arch-review 59 P1) ───────────────────
//
// The first version of this answered a bare word, and the seal it reports on returns
// `TrajectoryMeta & { created: boolean }` — every bit of which was discarded by `.then(() => true)`. Two
// things followed, and the second is a wrong claim rather than a missing one:
//
//   NO JOIN KEY. A consumer wanting to re-read the judge's own execution had to REBUILD the emitter tag
//   (`judge:<id>#<pass>.<gen>.<attempt>`) from the pieces — the downstream re-derivation rule `protocol` L3
//   forbids, and the reason `VerifierInvocation`, this type's declared twin, carries its digests instead.
//
//   `created: false` READ AS SEALED. A trajectory keeps the FIRST segment per emitter, so when one already
//   exists this execution's events are DISCARDED and the earlier execution's stand. That is precisely what
//   the invocation-scoped emitter grammar exists to prevent — and the one signal that detects a slip in it
//   was thrown away, so `judgmentsSealed` stayed true while pointing a re-reader at somebody else's account.
//   (The store returns `created: false` for a cross-tenant id collision too, where it deliberately touches
//   nothing at all.)
//
// So the outcome is a union carrying the coordinate, and `superseded` is its own arm: the evidence on file is
// real and re-readable, it is simply not THIS execution's, which is a different fact from both "sealed" and
// "the seal failed".
export type JudgeEvidenceOutcome =
  // On the judged run's trajectory, under this emitter, put there by this execution.
  | { status: "sealed"; runId: string; emitter: string }
  // A segment already held this emitter, so what is on file is an earlier execution's. Re-readable, not ours.
  | { status: "superseded"; runId: string; emitter: string }
  // It ran and the evidence did not land — the verdict stands, its account does not.
  | { status: "unsealed"; reason: string }
  // Nothing to seal (no trajectory store, no run id, a skip), or this driver may no longer publish and the
  // successor's seal will be the evidence. Not a loss.
  | { status: "not_applicable" };
