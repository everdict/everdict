import { BadRequestError, type VerifierInvocation } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

// The shape a lane REPORTS is declared once, in the wire contract a backend produces (`VerifierInvocation`).
// Re-declaring it here would be the same document spelled twice, which is how the next field lands in one of
// them (rule `protocol` L3).
export type { VerifierInvocation };

// ── A VERDICT CARRIES WHAT PRODUCED IT (arch-review 57 P1) ───────────────────────────────────────────
//
// `dispatchVerifier` answered `Score[]`, and those scores were appended to the case result. The numbers
// arrived; nothing arrived with them. So the record could not answer the question a defensible verdict
// exists to answer:
//
//     which procedure, reading which workspace, in which runtime, produced this number?
//
// Every part of that is known at the invocation and discarded one frame later. The plan has a content
// digest and the job carries it. The workspace snapshot has one. The lane knows the work id it created and
// the image it placed. None of it was joined to the score, so a replay could say `tests_pass` was 1 and not
// say what was run to get it — and rule `protocol` L3 is precisely that provenance is born at the source
// rather than re-derived downstream from whatever the registry holds later.
export interface VerifierReceipt extends VerifierInvocation {
  // The verdict, by content. A record whose scores no longer digest to this is not the verdict this
  // invocation reached, whatever the numbers say.
  scoreDigest: string;
  // Whether this receipt carries the runtime identity too. A receipt without it is still worth keeping —
  // the plan and workspace digests are real evidence — but a consumer has to be able to TELL. Absence that
  // reads as completeness is how a weaker record gets counted as a stronger one, which is the collapse
  // `ReadResult` and the provenance union exist to prevent.
  complete: boolean;
}

export function verifierReceiptOf(invocation: VerifierInvocation): VerifierReceipt {
  // An empty verdict is not a measurement — the same rule the verifier runner applies to an empty plan.
  // Reporting an absence as a result is how a case that was never judged reads as one that was.
  if (invocation.scores.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { planDigest: invocation.planDigest },
      "a verifier invocation produced no score at all — an empty verdict is not a measurement, and recording one would let a case that was never judged read as one that was.",
    );
  return {
    ...invocation,
    // SORTED before digesting: two lanes that ran the same graders reached the same verdict, and the order
    // they happened to finish in is a scheduling detail. Digesting it would turn that detail into a
    // difference of evidence.
    scoreDigest: contentDigest([...invocation.scores].sort((a, b) => a.metric.localeCompare(b.metric))),
    complete: invocation.work !== undefined && invocation.imageProvenance !== undefined,
  };
}
