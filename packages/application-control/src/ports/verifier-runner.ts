import type { TaskEnvelope } from "@everdict/contracts";

// What a verifier came back with. `verified` is the only affirmative — a verifier that cannot decide says so
// rather than passing by default, because "I could not tell" and "it holds" are the two answers a trust
// system must never merge.
export interface VerifierVerdict {
  verdict: "verified" | "refuted" | "inconclusive";
  detail: string; // why — the sentence a human or an owner-agent reads
  actor: string; // WHO verified. Independence is decided on this, so an anonymous verdict is not one.
}

// Spawns an agent to VERIFY someone else's work, inside the envelope it is handed
// (docs/architecture/ownership-protocol.md — the third enforcement site).
//
// The port takes the envelope rather than building one: the envelope is produced by `verifierEnvelopeFor`
// (@everdict/domain), which is where the two separations are structural — writes empty, reads restricted to
// the evidence, never the executor's trajectory. A runner that accepted "the evidence" and assembled its own
// context would be exactly the arrangement the protocol doc refused to write, because then the separation
// would live in whichever implementation happened to be wired.
//
// The implementation binds this to the agent loop, whose envelope enforcement already exists
// (authorizeToolInvocation on every tool call, inherited by sub-agents) — this port is what finally points
// that machinery at a verifier-role task.
export interface VerifierRunner {
  verify(input: {
    tenant: string;
    envelope: TaskEnvelope;
    // The question the verifier answers, in the caller's words ("does the evidence support this checkpoint's
    // confirmed facts?"). Not a template: what is being verified differs per call site.
    question: string;
  }): Promise<VerifierVerdict>;
}
