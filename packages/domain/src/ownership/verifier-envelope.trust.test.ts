import { authorizeResourceAccess, authorizeToolInvocation } from "@everdict/contracts";
import type { RoleProfile } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { verifierEnvelopeFor } from "./ownership.js";

// Trust suite (docs/trust-certification.md) — TRUST-31.
//
// A ROLE-BOUND VERIFIER KEEPS ITS EVIDENCE-ONLY SCOPE DOWN TO THE KERNEL AND CANNOT ACQUIRE WRITE CAPABILITY.
//
// The number was reserved for several generations on the note "no path spawns one". The producer
// (`verifierEnvelopeFor`) and the two kernel guards were both already here; what was never written was the
// scenario that drives one through the other. So this certifies the composition rather than either half:
// the envelope a spawn site actually builds, handed to the functions the agent loop actually calls.
//
// The two guards answer different questions, and the split is the whole guarantee: `authorizeToolInvocation`
// says which VERBS, `authorizeResourceAccess` says on which OBJECTS. Before they lived apart, the evidence ids
// were written into the capability list — where they matched no tool name, so the envelope blocked every tool
// and restricted no object. Two concepts in one field is not a weaker guarantee; it is a false one that
// happened to fail in the direction that looked like enforcement.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const VERIFIER: RoleProfile = {
  role: "verifier",
  capabilities: { read: "all", write: [] },
  requiredEvidence: [],
  completion: "verification",
} as unknown as RoleProfile;

const envelope = () =>
  verifierEnvelopeFor(VERIFIER, {
    id: "env-v",
    goal: "verify checkpoint cp-1",
    evidence: [
      { type: "scorecard", id: "sc-7" },
      { type: "run", id: "run-42" },
    ],
    tools: ["get_scorecard", "get_run"],
    budgets: { timeSec: 600 },
  });

describeTrust("TRUST-31 — a spawned verifier cannot acquire write capability", () => {
  it("holds NO write capability, and the KERNEL is what says so", () => {
    const env = envelope();
    expect(env.scope.writes).toEqual([]);
    for (const tool of ["submit_scorecard", "create_issue", "write_file"])
      expect(authorizeToolInvocation({ name: tool }, env)).toMatchObject({
        allowed: false,
        action: "refuse_and_replan",
      });
  });

  it("reads the evidence's own tools and NOT `all` — a verdict must be attributable to what it was handed", () => {
    const env = envelope();
    expect(env.scope.reads).not.toBe("all");
    expect(authorizeToolInvocation({ name: "get_scorecard", isReadOnly: true }, env)).toMatchObject({
      allowed: true,
    });
    // Reading the executor's trajectory would be reviewing the executor's STORY rather than the artifact.
    expect(authorizeToolInvocation({ name: "get_run_trajectory", isReadOnly: true }, env)).toMatchObject({
      allowed: false,
      reason: "out_of_scope",
    });
  });

  it("sees the cited OBJECTS and no others — holding `get_scorecard` is not permission to read sc-8", () => {
    const env = envelope();
    expect(authorizeResourceAccess({ type: "scorecard", id: "sc-7" }, env)).toMatchObject({ allowed: true });
    // The second guard's entire reason for existing: the tool check above passes for this one too.
    expect(authorizeResourceAccess({ type: "scorecard", id: "sc-8" }, env)).toMatchObject({ allowed: false });
  });

  it("refuses to build a WEAKENED envelope rather than returning one", () => {
    // Each of these would produce a verifier that looks spawned and verifies nothing.
    expect(() =>
      verifierEnvelopeFor({ ...VERIFIER, role: "executor" } as RoleProfile, {
        id: "e",
        goal: "g",
        evidence: [{ type: "run", id: "r" }],
        tools: ["get_run"],
        budgets: { timeSec: 60 },
      }),
    ).toThrow(/only a verifier profile/);
    expect(() =>
      verifierEnvelopeFor(VERIFIER, { id: "e", goal: "g", evidence: [], tools: ["get_run"], budgets: { timeSec: 60 } }),
    ).toThrow(/nothing to verify/);
    expect(() =>
      verifierEnvelopeFor(VERIFIER, {
        id: "e",
        goal: "g",
        evidence: [{ type: "run", id: "r" }],
        tools: [],
        budgets: { timeSec: 60 },
      }),
    ).toThrow(/cannot reach its own evidence/);
  });
});
