import type { ActorRef, TaskEnvelope } from "@everdict/contracts";

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
  reviewedResources?: Array<{ type: string; id: string }>;
  // Refs the verifier reached for and could NOT read (a 404, a transport error, a timeout). Recorded so the
  // decision can say WHY coverage is short rather than leaving an unexplained gap; a failed read is evidence
  // about the platform, not about the artifact under review.
  failedResources?: Array<{ type: string; id: string }>;
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
    // The question the verifier answers, in the caller's words ("does the evidence support this checkpoint's
    // confirmed facts?"). Not a template: what is being verified differs per call site.
    question: string;
  }): Promise<VerifierVerdict>;
}
