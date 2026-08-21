import { z } from "zod";
import { UpstreamError } from "../errors.js";
import { ScoreSchema } from "./grader.js";

// ── A VERIFIER RESULT IS NOT A CASE RESULT (arch-review 58 P0-verifier) ──────────────────────────────
//
// The verifier entrypoint printed its scores through `encodeResult`, the CASE sentinel, with a cast:
//
//     encodeResult({ caseId: "", harness: "", trace: [], scores } as never)
//
// and the reader on the other side runs `CaseResultSchema.parse()`, where `snapshot` is required. A verifier
// has no snapshot to give — it did not run an environment, it JUDGED one. So every verifier invocation that
// reached a managed lane died at the parse, deterministically: graders ran, scores were produced, the
// envelope was printed, and the dispatch threw `snapshot Required`. The case then recorded
// `tests_pass: unmeasured`, which reads as "this deployment cannot judge" rather than "the wire is broken".
//
// The cast is why it compiled. The allowlist entry excusing that cast — "the shape is a wire artifact, not a
// CaseResult" — is why it stayed: a justification that states the defect. A new operation with a new trust
// domain needs its own wire contract, not a borrowed one with the mismatched fields cast away.
//
// Deliberately NOT `CaseResult`-shaped, and deliberately a different sentinel: the two documents must be
// unreadable as each other, because sharing a pipe is what let a document with no snapshot travel down one
// that requires it.
export const VERIFIER_RESULT_SENTINEL = "__EVERDICT_VERIFIER_RESULT__ ";

export const VerifierResultEnvelopeSchema = z.object({
  runId: z.string().min(1),
  caseId: z.string().min(1),
  // WHICH PROCEDURE ran, by content, and WHAT it read. Carried across the boundary rather than re-derived on
  // the far side, which is the whole of rule `protocol` L3 — and without them the scores are a number whose
  // provenance the lane would have to guess at.
  planDigest: z.string().min(1),
  workspaceDigest: z.string().min(1),
  // An empty verdict is not a measurement. Refusing it here means a verifier that ran nothing cannot be read
  // as one that judged and found zero.
  scores: z.array(ScoreSchema).min(1),
});
export type VerifierResultEnvelope = z.infer<typeof VerifierResultEnvelopeSchema>;

export function encodeVerifierResult(envelope: VerifierResultEnvelope): string {
  return VERIFIER_RESULT_SENTINEL + JSON.stringify(envelope);
}

// ── WHOSE VERDICT THIS IS, READ BACK RATHER THAN ASSUMED (arch-review 59 P1) ────────────────────────
//
// The envelope names the unit it judged, and both managed lanes took `.scores` off it and then STAMPED the
// invocation's `planDigest`/`workspaceDigest` from what they had REQUESTED. So the provenance the whole lane
// exists to produce was a copy of the request, and the container's own account of what it read was parsed and
// thrown away one expression later.
//
// That is the failure rule `protocol` names in full: a proof is born from the same builder as the effect, and
// `request copied into proof` is not `native effect read back into proof`. The digests are the join key
// downstream (`verifierReceiptOf`), so a stamped copy is not cosmetic — it is what a replay matches on.
//
// Stated exactly, because the guarantee is narrower than it first reads. The container derives its digests
// from the SAME payload the lane sent, so this cannot detect a container that mounted a tree different from
// the one its payload declares — that is a real and separate question, and nothing here closes it. What it
// does catch is an envelope that is about ANOTHER UNIT: a log read that returned a previous case's output
// (both lanes take "the last sentinel in whole logs", over a recycled pod or a reused alloc dir this repo
// already documents), and a payload swapped between the dispatch and the container's start. Before this,
// either of those was silently adopted as this case's verdict, with the request's own digests stamped on it.
//
// A REQUIRED PARAMETER, not a separate `assertVerifierEnvelope` a lane can forget — this repo has now twice
// watched an optional companion check go unwired on one of two lanes (rule `protocol` L1, and the K8s
// verifier's missing activation one review ago). There is no way to read this wire without saying which unit
// the answer was supposed to be about.
export interface ExpectedVerifierIdentity {
  runId: string;
  caseId: string;
  planDigest: string;
  workspaceDigest: string;
}

export function parseVerifierResult(stdout: string, expected: ExpectedVerifierIdentity): VerifierResultEnvelope {
  // Last sentinel wins, same as the case wire: a job's logs carry installation noise, trace lines and the
  // harness's own stdout around the one line that matters.
  const idx = stdout.lastIndexOf(VERIFIER_RESULT_SENTINEL);
  if (idx < 0)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      undefined,
      "could not find the verifier result (sentinel) — the verifier job printed no verdict envelope.",
    );
  const line = stdout.slice(idx + VERIFIER_RESULT_SENTINEL.length).split("\n")[0] ?? "";
  const envelope = VerifierResultEnvelopeSchema.parse(JSON.parse(line));
  // Every coordinate, not the convenient ones. `runId`/`caseId` catch a pod that answered for another unit;
  // `planDigest`/`workspaceDigest` catch the case this is really about — the same unit judged against a
  // different procedure or a different tree, which no id comparison can see.
  const mismatched = (
    [
      ["runId", envelope.runId, expected.runId],
      ["caseId", envelope.caseId, expected.caseId],
      ["planDigest", envelope.planDigest, expected.planDigest],
      ["workspaceDigest", envelope.workspaceDigest, expected.workspaceDigest],
    ] as const
  ).filter(([, got, want]) => got !== want);
  if (mismatched.length > 0)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { mismatched: mismatched.map(([field, got, want]) => ({ field, got, want })) },
      `the verifier answered about a different unit than the one dispatched (${mismatched
        .map(([field]) => field)
        .join(", ")}) — its verdict cannot be adopted for this case.`,
    );
  return envelope;
}
