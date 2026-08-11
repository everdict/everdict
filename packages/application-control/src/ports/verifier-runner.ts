import type { ActorRef, TaskEnvelope } from "@everdict/contracts";
import type { EvidenceIdentity, VerificationClaim, VerifierPolicy } from "@everdict/domain";

// What a verifier came back with. `verified` is the only affirmative — a verifier that cannot decide says so
// rather than passing by default, because "I could not tell" and "it holds" are the two answers a trust
// system must never merge.
export interface VerifierVerdict {
  verdict: "verified" | "refuted" | "inconclusive";
  detail: string; // why — the sentence a human or an owner-agent reads
  // WHO verified, as an ActorRef rather than a name (arch-review 10 P1). Everdict's independence invariant is
  // "not the same actor, AND not the same run, AND not the same session" — a bare string can only answer the
  // first third of that, so a verdict returned by an agent running INSIDE the executing session satisfied a
  // check that had no way to notice. The runner must say which run and which session its verdict came from,
  // or `assertIndependentVerification` is being asked a question it cannot answer.
  actor: ActorRef;
  // WHAT THE RUNTIME OBSERVED THE VERIFIER SUCCESSFULLY READING — collected by the kernel from actual tool
  // calls and their OUTCOMES, never assembled from the model's own account of itself (arch-review 12/13).
  // The resource scope proves a verifier could not look OUTSIDE the evidence; this is the other half, that it
  // looked INSIDE. A verdict from an agent that read nothing is a verdict about the question, not the
  // artifact.
  //
  // SUCCESSFULLY, not merely addressed: the first version was collected before the tool ran, so a verifier
  // that addressed all three of its refs and got a 404 on every one still reported full coverage — an
  // affirmative built on three failures. Attempted and consumed are different facts.
  //
  // Absent = the runner does not report it. The decision then records no evidence coverage and cannot be
  // affirmative — an unmeasured guarantee is not a satisfied one.
  //
  // `tool` is the tool that DID the reading, and it is part of the fact rather than trivia: coverage asks
  // whether the EVIDENCE was examined, and two different tools can address the same run — the evidence reader
  // and the executor's trajectory (arch-review 24 P0-4). Counting a trajectory read as evidence coverage would
  // certify "the verifier looked at the artifact" for a verifier that read the executor's story about it.
  reviewedResources?: Array<{ type: string; id: string; tool?: string }>;
  // Refs the verifier reached for and could NOT read (a 404, a transport error, a timeout). Recorded so the
  // decision can say WHY coverage is short rather than leaving an unexplained gap; a failed read is evidence
  // about the platform, not about the artifact under review.
  failedResources?: Array<{ type: string; id: string; tool?: string }>;
  // THE CLAIM THE RUNNER ACTUALLY SHOWED THE MODEL, digested (arch-review 24 P0-3). The caller sends the
  // claim; the runner echoes the digest of what it rendered. A mismatch means the verdict is about some other
  // text than the one under review, and the caller refuses to make it affirmative. Absent = the runner does
  // not report it, which is the same as unproven — an unmeasured guarantee is not a satisfied one.
  claimDigest?: string;
  // The digest of the POLICY text the runner actually rendered. Same contract as the claim echo, for the same
  // reason: a verdict reached under a different constitution is a verdict about a different question, and the
  // caller refuses to make it affirmative.
  policyDigest?: string;
  // WHAT THE READS OBSERVED — the identity each artifact actually had when the verifier opened it. The
  // caller records THIS, never its own preflight resolution: a plan is not an observation, and the gap
  // between them is exactly where a concurrent re-score lives.
  observedEvidence?: Array<{ type: string; id: string; identity?: EvidenceIdentity; moved?: true }>;
  // WHICH INSTRUMENT applied the policy (arch-review 26 P1). Rules without an executor identity answer "under
  // what constitution" and leave "by what" unanswerable — and this platform treats procedure identity as part
  // of what a verdict means everywhere else.
  executionProfile?: { modelRef: string; version: string; documentDigest: string };
}

// Spawns an agent to VERIFY someone else's work, inside the envelope it is handed
// (docs/architecture/ownership-protocol.md — the third enforcement site).
//
// The port takes the envelope rather than building one: the envelope is produced by `verifierEnvelopeFor`
// (@everdict/domain), which is where the three separations are structural — writes empty, read TOOLS
// restricted, and `scope.resources` pinned to the evidence so the verifier reaches the artifact and never the
// executor's trajectory. A runner that accepted "the evidence" and assembled its own context would be exactly
// the arrangement the protocol doc refused to write, because then the separation would live in whichever
// implementation happened to be wired.
//
// The implementation binds this to the agent loop, whose envelope enforcement already exists
// (authorizeToolInvocation + authorizeResourceAccess on every tool call, inherited by sub-agents) — this port
// is what finally points that machinery at a verifier-role task.
export interface VerifierRunner {
  verify(input: {
    tenant: string;
    envelope: TaskEnvelope;
    // THE DECISION PROCEDURE, owned by the platform (arch-review 25 P0-4). What "verified" means, what to do
    // with a contradiction, what insufficient evidence answers, and that nothing may be inferred beyond the
    // evidence. It is not a parameter the caller composes: the party asking for a verdict must not be able to
    // define what the verdict means.
    policy: VerifierPolicy;
    // …and what the REQUESTER contributed: where to look. Carried beside the policy and subordinate to it,
    // never merged into it. Absent = no particular focus, which is the ordinary case.
    focus?: string;
    // WHICH VERSION of each piece of evidence this verification is about. The runner hands them to its
    // readers, which refuse a read that observes anything else — the pin is consumed where the bytes arrive
    // rather than resolved beforehand and hoped over (arch-review 26 P0).
    evidencePins?: ReadonlyArray<{ type: string; id: string; identity: EvidenceIdentity }>;
    // WHAT IS CLAIMED — the statements themselves, verbatim, carried across the process boundary. Without it
    // the question referred to facts that never left the caller, so the verifier could only judge whether the
    // evidence was internally coherent and the platform recorded that as support for claims it never saw.
    claim: VerificationClaim;
  }): Promise<VerifierVerdict>;
}
