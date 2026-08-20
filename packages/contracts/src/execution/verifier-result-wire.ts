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

export function parseVerifierResult(stdout: string): VerifierResultEnvelope {
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
  return VerifierResultEnvelopeSchema.parse(JSON.parse(line));
}
