import type { VerifierRunner, VerifierVerdict } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";

// The VerifierRunner bound to the agent service (ownership protocol, third enforcement site).
//
// The port takes the envelope rather than building one, and this honours that literally: the evidence-only
// boundary is constructed on THIS side — where the checkpoint and its evidence live — and passed through. A
// runner that received "the evidence" and assembled its own scope would move the guarantee into whichever
// implementation happened to be wired, which is the arrangement the protocol doc refused to write.
//
// A verification that could not RUN throws rather than returning `inconclusive`. The two are different facts:
// one says the evidence could not decide the claim, the other says nobody looked — and a ledger that files
// the second as the first has recorded a judgment nobody made.
export function httpVerifierRunner(deps: { agentUrl: string; internalToken: string }): VerifierRunner {
  return {
    async verify(input): Promise<VerifierVerdict> {
      const res = await fetch(new URL("/internal/verify", deps.agentUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": deps.internalToken },
        body: JSON.stringify({
          workspace: input.tenant,
          // The verifier acts as the workspace's agent identity for this run; independence is decided against
          // the EXECUTORS in the evidence, which the checkpoint service checks with the actor this returns.
          actingAs: "verifier",
          question: input.question,
          envelope: input.envelope,
          // The claim travels WITH the question — the statements the evidence is supposed to support. The
          // runner echoes back the digest of what it rendered, and the caller refuses an affirmative when the
          // two differ (arch-review 24 P0-3).
          claim: input.claim,
        }),
      }).catch((err: unknown) => {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `the verifier runtime could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `the verifier runtime refused the run (${res.status}) — no verdict was produced, which is not the same as an inconclusive one.`,
        );
      const body = (await res.json()) as {
        verdict: VerifierVerdict["verdict"];
        detail: string;
        sessionId: string;
        reviewedResources: Array<{ type: string; id: string; tool?: string }>;
        failedResources: Array<{ type: string; id: string; tool?: string }>;
        claimDigest?: string;
      };
      return {
        verdict: body.verdict,
        detail: body.detail,
        // The actor, with the RUN and SESSION context the independence invariant needs — "not the same actor,
        // AND not the same run, AND not the same session". A bare id answers only the first third, and a
        // verdict returned from inside the executing session would satisfy a check that could not notice.
        actor: { id: "agent:verifier", sessionId: body.sessionId },
        reviewedResources: body.reviewedResources,
        failedResources: body.failedResources,
        ...(body.claimDigest !== undefined ? { claimDigest: body.claimDigest } : {}),
      };
    },
  };
}
