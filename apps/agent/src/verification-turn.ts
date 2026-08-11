import type { TaskEnvelope } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import { type ChatDeps, runChat } from "./chat.js";

// A VERIFICATION TURN — the third enforcement site of the ownership protocol, finally bound to the loop.
//
// Everything it needs already existed and none of it was connected: `verifierEnvelopeFor` builds the
// evidence-only boundary, the kernel enforces both halves of it on every call, `onResourceAccess` reports what
// was actually consumed, and `structured_output` refuses an answer that is not the shape asked for. This runs
// one bounded turn inside that envelope and reports what came back.
//
// Three properties it must not quietly relax:
//
//   ① The envelope arrives DECIDED. The turn does not complete this scope from the resolved toolset — that is
//      the executor posture, and applying it here would hand the kernel a widened boundary while every layer
//      above still called the run a verification.
//   ② The verdict is SUBMITTED, not parsed out of prose. A parse that fails silently turns "the verifier could
//      not decide" into "there is no verdict", and those are different facts with different consequences.
//   ③ Coverage is the RUNTIME's account, never the model's. An agent that read nothing can still write a
//      confident paragraph; what it consumed is a fact only the kernel holds.
//
// A turn that ends without submitting returns `inconclusive` with that stated as the reason. It is the honest
// mapping: the run happened, the question was asked, and no answer came back — which is not the same as a
// verdict of "cannot tell", and the detail says which one this is.

export const VERDICT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["verified", "refuted", "inconclusive"],
      description:
        "verified = the evidence supports the claims; refuted = the evidence contradicts them; inconclusive = the evidence you were given cannot decide it. Never guess: inconclusive is a real answer.",
    },
    detail: {
      type: "string",
      description: "Why — the sentence a human or an owner-agent reads. Cite what you actually read.",
    },
  },
  required: ["verdict", "detail"],
} as const;

export interface VerificationTurnResult {
  verdict: "verified" | "refuted" | "inconclusive";
  detail: string;
  sessionId: string;
  reviewedResources: Array<{ type: string; id: string }>;
  failedResources: Array<{ type: string; id: string }>;
}

export async function runVerificationTurn(
  deps: ChatDeps & {
    keyStore?: Parameters<typeof issueAgentToken>[0];
    newId: () => string;
    now: () => string;
  },
  authenticate: (headers: { authorization: string }) => Promise<Parameters<typeof runChat>[1]>,
  input: { workspace: string; actingAs: string; envelope: TaskEnvelope; question: string },
): Promise<VerificationTurnResult> {
  if (!deps.keyStore)
    throw new Error("verification turns need a key store (agt_ execution tokens) — set DATABASE_URL.");
  const sessionId = deps.newId();
  const now = deps.now();
  await deps.sessions.createSession({
    id: sessionId,
    tenant: input.workspace,
    owner: input.actingAs,
    title: `Verification — ${input.envelope.id}`.slice(0, 60),
    // Workspace-visible: a verdict's transcript is the workspace's evidence about the verdict, not a private
    // chat. The independence claim is only inspectable if the run it stands on can be opened.
    visibility: "workspace",
    createdAt: now,
    updatedAt: now,
  });
  // READ scope only. The envelope already forbids every write at the kernel, and a token that could write
  // would leave the guarantee resting on one layer instead of two.
  const { token, id: keyId } = await issueAgentToken(
    deps.keyStore,
    input.workspace,
    input.actingAs,
    ["read"],
    `verify:${input.envelope.id}`,
  );
  const reviewed = new Map<string, { type: string; id: string }>();
  const failed = new Map<string, { type: string; id: string }>();
  try {
    const headers = { authorization: `Bearer ${token}` };
    const principal = await authenticate(headers);
    const result = await runChat(deps, principal, headers, sessionId, input.question, undefined, undefined, undefined, {
      envelope: input.envelope,
      outputSchema: VERDICT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      onResourceAccess: (access) => {
        const key = `${access.target.type}:${access.target.id}`;
        // Consumed and merely attempted are tracked apart, because a verdict that counted its failures as
        // coverage would be an affirmative built on what it could not read.
        if (access.outcome === "success") reviewed.set(key, access.target);
        else failed.set(key, access.target);
      },
    });
    const submitted = result.structuredOutput as { verdict?: string; detail?: string } | undefined;
    const verdict = submitted?.verdict;
    if (verdict !== "verified" && verdict !== "refuted" && verdict !== "inconclusive")
      return {
        verdict: "inconclusive",
        detail:
          "the verifier ended its turn without submitting a verdict — the run happened and no answer came back, which is not the same as being unable to decide.",
        sessionId,
        reviewedResources: [...reviewed.values()],
        failedResources: [...failed.values()],
      };
    return {
      verdict,
      detail: submitted?.detail ?? "(no detail submitted)",
      sessionId,
      reviewedResources: [...reviewed.values()],
      failedResources: [...failed.values()],
    };
  } finally {
    // One-shot credential, revoked with the run — no standing token accumulates from verifying.
    await deps.keyStore.revoke(input.workspace, keyId, input.actingAs).catch(() => {});
  }
}
