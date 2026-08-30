import type { RoleProfile } from "@everdict/contracts";
import { UpstreamError } from "@everdict/contracts";
import {
  type VerificationClaim,
  assertIndependentVerification,
  verificationClaimDigest,
  verifierEnvelopeFor,
  verifierPolicy,
} from "@everdict/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpVerifierRunner } from "./http-verifier-runner.js";

// ── A VERDICT THAT CANNOT NAME ITS SESSION CANNOT BE SHOWN INDEPENDENT ───────────────────────────────
//
// `VerifierVerdict.actor` carries an instruction about THIS file: "The runner must say which run and which
// session its verdict came from, or `assertIndependentVerification` is being asked a question it cannot
// answer." Nothing checked it — the response arrived through an `as` cast, and this runner is the port's only
// implementation, so it is the single seam where an agent verdict's session is established.
//
// The stake is in the last test: the domain's session arm is `executor.actor.sessionId !== undefined &&
// executor.actor.sessionId === verifier.actor.sessionId`, so a verifier with NO session id compares unequal
// to every executor and is declared independent. That is correct in the domain — a human verifier has no
// session, and refusing there would refuse them — which is exactly why the guarantee has to be made here.

// The profiles and the envelope come from the PRODUCTION shapes — `RoleProfile` typed rather than cast, and
// the envelope from `verifierEnvelopeFor`, which is what the checkpoint service hands this runner. A
// hand-shaped envelope would assert a form no caller produces; the first draft did exactly that and `tsc`
// refused it while vitest was green.
const EXECUTOR: RoleProfile = {
  role: "executor",
  capabilities: { read: [], write: [] },
  requiredEvidence: [],
  completion: "change_set",
};

const VERIFIER: RoleProfile = {
  role: "verifier",
  capabilities: { read: "all", write: [] },
  requiredEvidence: [],
  completion: "verified_verdict",
};

// The claim carries its own digest, minted by the same function the checkpoint service uses — the runner
// echoes back a digest of what it RENDERED, and the caller refuses an affirmative when the two differ, so a
// fixture whose digest was typed by hand would be testing a claim the protocol would reject.
const CLAIM_CONTENT = {
  subject: { type: "checkpoint" as const, id: "cp-1" },
  goal: "the fix holds",
  statements: [{ statement: "the regression no longer reproduces", refs: [{ type: "run", id: "run-1" }] }],
};
const CLAIM: VerificationClaim = { ...CLAIM_CONTENT, digest: verificationClaimDigest(CLAIM_CONTENT) };

const INPUT = {
  tenant: "acme",
  envelope: verifierEnvelopeFor(VERIFIER, {
    id: "env-1",
    goal: "verify the change set",
    evidence: [{ type: "run", id: "run-1" }],
    tools: ["read_run"],
    budgets: {},
  }),
  // The platform's own procedure text, from its factory — the runner sends the policy across the wire so it
  // renders the platform's words rather than composing its own, and a hand-written string here would be a
  // fixture testing a document nobody ships.
  policy: verifierPolicy(),
  claim: CLAIM,
};

const WELL_FORMED = {
  verdict: "verified",
  detail: "the evidence supports the claim",
  sessionId: "verifier-conv-9",
  reviewedResources: [{ type: "run", id: "run-1", tool: "read_run" }],
  failedResources: [],
};

function answering(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

const runner = (): ReturnType<typeof httpVerifierRunner> =>
  httpVerifierRunner({ agentUrl: "http://agent:4000", internalToken: "tok" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the verifier runner reads the agent's answer as a verdict, or refuses it", () => {
  it("passes a well-formed verdict through, carrying the session the check needs", async () => {
    answering(WELL_FORMED);
    const verdict = await runner().verify(INPUT);
    expect(verdict.verdict).toBe("verified");
    expect(verdict.actor).toEqual({ id: "agent:verifier", sessionId: "verifier-conv-9" });
    expect(verdict.reviewedResources).toEqual([{ type: "run", id: "run-1", tool: "read_run" }]);
  });

  // The defect this closes. Before the parse, the missing field became `sessionId: undefined` on the actor
  // and the verdict was returned as though nothing were wrong.
  it("refuses a verdict whose session it cannot name", async () => {
    const { sessionId: _dropped, ...noSession } = WELL_FORMED;
    answering(noSession);
    await expect(runner().verify(INPUT)).rejects.toThrow(UpstreamError);
    await expect(runner().verify(INPUT)).rejects.toThrow(/cannot read as a verdict/);
  });

  it("refuses an empty session id, which names no session either", async () => {
    answering({ ...WELL_FORMED, sessionId: "" });
    await expect(runner().verify(INPUT)).rejects.toThrow(/cannot read as a verdict/);
  });

  // A value outside the union used to be cast INTO it, so a downstream `verdict === "verified"` was reading a
  // field whose type had been asserted rather than checked.
  it("refuses a verdict word it does not know", async () => {
    answering({ ...WELL_FORMED, verdict: "definitely-verified" });
    await expect(runner().verify(INPUT)).rejects.toThrow(/cannot read as a verdict/);
  });

  it("refuses a body that is not a verdict at all, and one that is not JSON", async () => {
    answering({ error: "boom" });
    await expect(runner().verify(INPUT)).rejects.toThrow(/cannot read as a verdict/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 200 })),
    );
    await expect(runner().verify(INPUT)).rejects.toThrow(/cannot read as a verdict/);
  });

  // Unchanged, and pinned beside the new arm so the three exits stay distinguishable: unreachable, refused,
  // and unreadable are three different facts and none of them is `inconclusive`.
  it("still separates an unreachable runtime from one that refused the run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(runner().verify(INPUT)).rejects.toThrow(/could not be reached/);
    answering(WELL_FORMED, 503);
    await expect(runner().verify(INPUT)).rejects.toThrow(/refused the run \(503\)/);
  });

  // WHY THE RUNNER HAS TO BE THE ONE THAT REFUSES. The domain is asked whether the verifier ran inside the
  // executing session; with no session on the verifier it cannot tell, and it answers "independent". That is
  // the right answer for a human verifier and the wrong one for a silent agent, and the domain cannot
  // distinguish them — only the runner knows it is talking to an agent turn that always has a session.
  it("shows the domain check the runner is protecting: an unnamed session passes it", () => {
    const executor = { profile: EXECUTOR, actor: { id: "agent:fixer", runId: "run-42", sessionId: "conv-1" } };
    // The shape the runner used to be able to produce.
    expect(() =>
      assertIndependentVerification(executor, { profile: VERIFIER, actor: { id: "agent:verifier" } }),
    ).not.toThrow();
    // …and the shape it produces now, when the verifier really did share the executor's session, is caught.
    expect(() =>
      assertIndependentVerification(executor, {
        profile: VERIFIER,
        actor: { id: "agent:verifier", sessionId: "conv-1" },
      }),
    ).toThrow(/inside the executing session/);
  });
});
