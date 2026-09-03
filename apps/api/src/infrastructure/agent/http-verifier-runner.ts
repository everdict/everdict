import type { VerifierRunner, VerifierVerdict } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";
import type { EvidenceIdentity } from "@everdict/domain";
import { z } from "zod";
import { agentFetch } from "../../common/agent-fetch.js";

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

// ── THE RESPONSE IS PARSED, BECAUSE THE PORT'S COMMENT IS A PROMISE THIS RUNNER MAKES ────────────────
//
// `VerifierVerdict.actor` carries this instruction: "The runner must say which run and which session its
// verdict came from, or `assertIndependentVerification` is being asked a question it cannot answer." That is
// a claim about THIS file, and nothing checked it — the body arrived through an `as` cast, so `sessionId` was
// whatever the response happened to contain, including nothing.
//
// An absent one is not a smaller answer, it is a vacuous check. The domain's session arm reads
//
//     executor.actor.sessionId !== undefined && executor.actor.sessionId === verifier.actor.sessionId
//
// so a verifier with no session id compares unequal to every executor and is declared independent — the
// check that exists precisely to catch a verifier running inside the executing session is satisfied by the
// field being missing. Optional is right in the DOMAIN (a human verifier has no session); it is wrong here,
// where the verifier is always an agent turn and `runVerificationTurn` always mints one. This runner is the
// only implementation of the port, so this is the single seam where an agent verdict's session is
// established, and the guarantee is worth exactly what this parse is worth.
//
// Today the agent does send it — its own return type declares `sessionId: string`. That makes this a
// contract nobody enforced rather than a live hole, and the control plane and the agent deploy separately,
// which is the shape version skew turns into one.
const ResourceRefSchema = z.object({ type: z.string(), id: z.string(), tool: z.string().optional() });

const VerifyResponseSchema = z.object({
  verdict: z.enum(["verified", "refuted", "inconclusive"]),
  detail: z.string(),
  // Required, and non-empty: "" would pass a presence check and still name no session.
  sessionId: z.string().min(1),
  reviewedResources: z.array(ResourceRefSchema).optional(),
  failedResources: z.array(ResourceRefSchema).optional(),
  claimDigest: z.string().optional(),
  policyDigest: z.string().optional(),
  observedEvidence: z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
        // `EvidenceIdentity` is a discriminated union declared as a TYPE with no paired Zod schema, and
        // mirroring it here would be a second spelling of a predicate that already exists — the divergence
        // this repo keeps paying for. Left unvalidated deliberately, which is safe in the one direction that
        // matters: the checkpoint service treats a missing or unmatched identity as `unpinnable` and refuses
        // the affirmative, so a malformed one can only ever weaken a verdict, never strengthen it.
        identity: z.custom<EvidenceIdentity>().optional(),
        moved: z.literal(true).optional(),
      }),
    )
    .optional(),
  executionProfile: z
    .object({
      modelRef: z.string(),
      version: z.string(),
      documentDigest: z.string(),
      closure: z.enum(["primary_only", "extended"]),
    })
    .optional(),
});

export function httpVerifierRunner(deps: { agentUrl: string; internalToken: string }): VerifierRunner {
  return {
    async verify(input): Promise<VerifierVerdict> {
      const res = await agentFetch(new URL("/internal/verify", deps.agentUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": deps.internalToken },
        body: JSON.stringify({
          workspace: input.tenant,
          // The verifier acts as the workspace's agent identity for this run; independence is decided against
          // the EXECUTORS in the evidence, which the checkpoint service checks with the actor this returns.
          actingAs: "verifier",
          envelope: input.envelope,
          // THE PROCEDURE, not a question: what verified means is the platform's, and it crosses the wire so
          // the runner renders the platform's words rather than composing its own (arch-review 25 P0-4).
          policy: input.policy,
          ...(input.focus !== undefined ? { focus: input.focus } : {}),
          ...(input.evidencePins !== undefined ? { evidencePins: input.evidencePins } : {}),
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
      const parsed = VerifyResponseSchema.safeParse(await res.json().catch(() => undefined));
      // A response we cannot read is the same fact as a run that did not happen, and it takes the same exit:
      // an `inconclusive` here would file a judgment nobody made, and a verdict assembled from the readable
      // half would claim an independence the missing half was supposed to establish.
      if (!parsed.success)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
          "the verifier runtime answered with a body this runner cannot read as a verdict — no verdict was produced, which is not the same as an inconclusive one.",
        );
      const body = parsed.data;
      return {
        verdict: body.verdict,
        detail: body.detail,
        // The actor, with the RUN and SESSION context the independence invariant needs — "not the same actor,
        // AND not the same run, AND not the same session". A bare id answers only the first third, and a
        // verdict returned from inside the executing session would satisfy a check that could not notice.
        actor: { id: "agent:verifier", sessionId: body.sessionId },
        ...(body.reviewedResources !== undefined ? { reviewedResources: body.reviewedResources } : {}),
        ...(body.failedResources !== undefined ? { failedResources: body.failedResources } : {}),
        ...(body.claimDigest !== undefined ? { claimDigest: body.claimDigest } : {}),
        ...(body.policyDigest !== undefined ? { policyDigest: body.policyDigest } : {}),
        ...(body.observedEvidence !== undefined ? { observedEvidence: body.observedEvidence } : {}),
        ...(body.executionProfile !== undefined ? { executionProfile: body.executionProfile } : {}),
      };
    },
  };
}
