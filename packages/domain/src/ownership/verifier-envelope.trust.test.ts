import { authorizeResourceAccess, authorizeToolInvocation } from "@everdict/contracts";
import type { HandoffCheckpoint } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { verifierEnvelope } from "./verifier-envelope.js";

// Trust suite (docs/trust-certification.md) — TRUST-31.
//
// A ROLE-BOUND VERIFIER KEEPS ITS EVIDENCE-ONLY SCOPE DOWN TO THE KERNEL AND CANNOT ACQUIRE WRITE CAPABILITY.
//
// This number was reserved several reviews ago and could not be claimed, for a reason worth stating: both
// kernel guards existed and were enforced on every call — `authorizeToolInvocation` for which tools,
// `authorizeResourceAccess` for which OBJECTS — and nothing ever BUILT an evidence-only envelope for them to
// enforce. The guarantee had all of its enforcement and no producer, so "a verifier sees the evidence and
// nothing else" was a sentence about a shape no code could make.
//
// The producer is what this certifies, against the real kernel functions rather than a restatement of them.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const checkpoint = (): HandoffCheckpoint =>
  ({
    id: "cp-1",
    goal: "make the flaky suite green",
    currentState: "two cases still fail",
    confirmedFacts: [{ statement: "case b regressed", refs: [{ type: "scorecard", id: "sc-7" }] }],
    hypotheses: [],
    actionsTaken: [{ what: "re-ran the batch", refs: [{ type: "run", id: "run-42" }] }],
    openDecisions: [],
    remainingTasks: [],
    requiredCapabilities: [],
    risks: [],
    validationPlan: "re-run and compare",
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "agent:fixer:conv-1",
  }) as unknown as HandoffCheckpoint;

const envelope = () => verifierEnvelope({ id: "env-v", checkpoint: checkpoint(), budgets: { timeSec: 600 } });

describeTrust("TRUST-31 — a verifier activation cannot acquire write capability", () => {
  it("reads the evidence's own tools, and NOT `all` — a conclusion must be attributable to what it was given", () => {
    const scope = envelope().scope;
    expect(scope.reads).not.toBe("all");
    expect(scope.reads).toContain("get_scorecard");
    expect(scope.reads).toContain("get_run");
  });

  it("holds NO write capability — not a short list, an empty one", () => {
    const env = envelope();
    expect(env.scope.writes).toEqual([]);
    // Through the KERNEL, which is where it has to hold: any write tool, refused, with the replan action the
    // envelope's escalation vocabulary allows.
    for (const tool of ["submit_scorecard", "create_issue", "write_file", "file_verification_decision"])
      expect(authorizeToolInvocation({ name: tool }, env)).toMatchObject({
        allowed: false,
        action: "refuse_and_replan",
      });
  });

  it("…and a READ tool outside the evidence's own set is refused too", () => {
    expect(authorizeToolInvocation({ name: "list_datasets", isReadOnly: true }, envelope())).toMatchObject({
      allowed: false,
      reason: "out_of_scope",
    });
  });

  it("sees the cited objects and no others — holding `get_scorecard` is not permission to read sc-8", () => {
    const env = envelope();
    expect(authorizeResourceAccess({ type: "scorecard", id: "sc-7" }, env)).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess({ type: "run", id: "run-42" }, env)).toMatchObject({ allowed: true });
    // The second guard's whole reason for existing: the tool check above passes for both of these.
    expect(authorizeResourceAccess({ type: "scorecard", id: "sc-8" }, env)).toMatchObject({ allowed: false });
  });

  it("evidence from BOTH halves of the claim is in scope — facts and actions taken", () => {
    // A verifier scoped to the facts but not to what was DONE could not check half of what it is judging.
    const resources = envelope().scope.resources ?? [];
    expect(resources).toEqual(
      expect.arrayContaining([
        { type: "scorecard", id: "sc-7" },
        { type: "run", id: "run-42" },
      ]),
    );
  });

  it("an unreadable evidence type stays IN the world it defines — the part nobody can check is not deleted", () => {
    // An outside commit has no first-party reader. Dropping it here would narrow the verifier's world to the
    // convenient half; keeping it lets the runtime record `unreachable`, which is a fact about the evidence.
    const withCommit = checkpoint();
    withCommit.confirmedFacts.push({ statement: "fixed upstream", refs: [{ type: "commit", id: "abc123" }] });
    const env = verifierEnvelope({ id: "env-c", checkpoint: withCommit, budgets: { timeSec: 600 } });
    expect(env.scope.resources).toEqual(expect.arrayContaining([{ type: "commit", id: "abc123" }]));
    // …and it grants no tool, because none can address it.
    expect(env.scope.reads).not.toContain("get_commit");
  });
});
