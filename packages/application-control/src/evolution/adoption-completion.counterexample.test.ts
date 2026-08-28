import type { CampaignAdoptionProof, PlatformEventRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";
import { adoptionCompletionWatch } from "./adoption-completion-watch.js";

// ── A STATE NOBODY WRITES IS A WORD, NOT A LIFECYCLE (arch-review 73) ───────────────────────────────
//
// `AdoptionOperationState` has been `decided | registered | completed` since the table was created, and the
// migration's own comment explains what the third one means — "the intent settled too (the issue this
// campaign was opened against)". Nothing anywhere wrote it. So the fourth of arch-review 71's four silent
// states, `adopted, issue unresolved`, was the one its own fix left open:
//
//     settle → crash            closed by `decided` (71)
//     save with no gate         closed by the proof + the adopt seam (72/73)
//     C1 evaluated, C2 saved    closed by the read-back (73)
//     adopted, issue unresolved STILL OPEN — the decision and its intent apart
//
// The join is the SCORECARD, never the fact that a resolution happened nearby. An issue can close on a
// different fix, on a sibling campaign, or by hand; completing this operation over any of those would record
// that this adoption discharged an intent it did not — the re-derivation rule `protocol` L3 forbids
// (latest row → winner, in its tracker-shaped form).
//
// Seen RED before the watch existed, observed:
//   an adoption whose issue closed on its own evidence never completed: expected 'registered' to be 'completed'

const PROOF: CampaignAdoptionProof = {
  campaignId: "camp-1",
  frameDigest: "sha256:frame",
  roundSeq: 2,
  candidate: { identity: "exact", type: "agent", id: "a1", version: "1.1.0", specDigest: "sha256:c1" },
  provingScorecardId: "sc-proved-it",
  issueId: "iss-9",
  gateDigest: "sha256:gate",
};

// One operation, answering exactly the way the real store does — including every refusal. A double that
// always completed would make a guard that refuses every real call read as a green test (rule `testing`).
function operations(state: "decided" | "registered" | "completed", proof: CampaignAdoptionProof = PROOF) {
  let op = { operationId: "adopt/acme/camp-1", tenant: "acme", proof, state, createdAt: "t", updatedAt: "t" };
  const store: AdoptionOperationStore = {
    async forCampaign() {
      return op;
    },
    async markRegistered() {
      return "already_registered";
    },
    // The sweep's worklist (arch-review 115). This double owns no rows, so it offers none — the cases here
    // are about the inline/watch joins, not about the reconciler.
    async registeredOlderThan() {
      return [];
    },
    async forIssue(_t, issueId) {
      return op.proof.issueId === issueId ? [op] : [];
    },
    async markCompleted(_t, _c, proofDigest) {
      if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
      if (op.state === "completed") return "already_completed";
      if (op.state !== "registered") return "not_registered";
      op = { ...op, state: "completed" };
      return "completed";
    },
  };
  return { store, current: () => op };
}

const resolved = (over: Record<string, unknown> = {}): PlatformEventRecord =>
  ({
    id: "evt-1",
    tenant: "acme",
    kind: "issue.status_changed",
    subject: { type: "issue", id: "iss-9" },
    actor: "alice",
    at: "2026-08-27T00:00:00.000Z",
    payload: { from: "in_progress", to: "done", cause: "manual", scorecardId: "sc-proved-it", ...over },
  }) as unknown as PlatformEventRecord;

describe("[R73 COUNTEREXAMPLE] an adoption completes when its own evidence closed the issue", () => {
  it("COMPLETES a registered adoption whose issue resolved citing the scorecard it proved", async () => {
    const { store, current } = operations("registered");

    await adoptionCompletionWatch({ operations: store }).handle(resolved());

    expect(current().state, "an adoption whose issue closed on its own evidence never completed").toBe("completed");
  });

  it("does NOT complete when the issue closed on a DIFFERENT scorecard", async () => {
    // The join that makes the state mean something. A sibling campaign, a manual fix, or a different
    // evaluation closing the issue is not this adoption discharging its intent.
    const { store, current } = operations("registered");

    await adoptionCompletionWatch({ operations: store }).handle(resolved({ scorecardId: "sc-something-else" }));

    expect(current().state, "an unrelated resolution completed this adoption").toBe("registered");
  });

  it("does NOT complete when the issue closed with no evidence at all", async () => {
    // Absence is not a match — the same law the proof-strength check rests on, one layer out.
    const { store, current } = operations("registered");

    await adoptionCompletionWatch({ operations: store }).handle(resolved({ scorecardId: undefined }));

    expect(current().state).toBe("registered");
  });

  it("does NOT complete an adoption that was never registered", async () => {
    // `decided` means the registry write never landed. Completing it would hide exactly the
    // settle-then-crash state `decided` exists to make visible.
    const { store, current } = operations("decided");

    await adoptionCompletionWatch({ operations: store }).handle(resolved());

    expect(current().state, "an unspent authorization was marked as having settled its intent").toBe("decided");
  });

  it("ignores a status change that is not a resolution", async () => {
    const { store, current } = operations("registered");

    await adoptionCompletionWatch({ operations: store }).handle(resolved({ to: "in_review" }));

    expect(current().state).toBe("registered");
  });

  it("converges on an at-least-once redelivery", async () => {
    // E1 is at-least-once, so the same event arrives twice. The second lands on `already_completed`, which
    // is convergence — not a second discharge and not an error.
    const { store, current } = operations("registered");
    const watch = adoptionCompletionWatch({ operations: store });

    await watch.handle(resolved());
    await watch.handle(resolved());

    expect(current().state).toBe("completed");
  });

  it("leaves an issue that regresses later COMPLETED", async () => {
    // History is not rewritten by what happened next: the adoption WAS completed, and the regression watch
    // reopening the issue is a new fact about the capability rather than a correction of the old one.
    const { store, current } = operations("registered");
    const watch = adoptionCompletionWatch({ operations: store });

    await watch.handle(resolved());
    await watch.handle(resolved({ to: "regressed", from: "done" }));

    expect(current().state).toBe("completed");
  });

  it("ESCALATES rather than swallowing a ledger that disagrees with what it just read", async () => {
    // The first draft awaited `markCompleted` and discarded the answer, under a comment claiming it was
    // consumed — this file's own comment-is-a-claim law, in code twenty minutes old (arch-review 74).
    // `proof_mismatch` means the row we listed is not the row we are writing to, which no retry fixes by
    // itself: it throws, the E1 runner retries three times and then dead-letters it visibly.
    const disagreeing: AdoptionOperationStore = {
      async forCampaign() {
        return undefined;
      },
      async markRegistered() {
        return "no_such_operation";
      },
      // The sweep's worklist (arch-review 115). This double owns no rows, so it offers none — the cases here
      // are about the inline/watch joins, not about the reconciler.
      async registeredOlderThan() {
        return [];
      },
      async forIssue() {
        return [
          {
            operationId: "adopt/acme/camp-1",
            tenant: "acme",
            proof: PROOF,
            state: "registered" as const,
            createdAt: "t",
            updatedAt: "t",
          },
        ];
      },
      // The ledger says the proof it holds is a different one — the shape a concurrent re-settle produces.
      async markCompleted() {
        return "proof_mismatch";
      },
    };

    await expect(
      adoptionCompletionWatch({ operations: disagreeing }).handle(resolved()),
      "a ledger disagreeing with the row we just read was recorded as a completion",
    ).rejects.toThrow(/could not be discharged/);
  });

  it("touches nothing for an issue that authorized no adoption", async () => {
    const { store, current } = operations("registered", { ...PROOF, issueId: "iss-other" });

    await adoptionCompletionWatch({ operations: store }).handle(resolved());

    expect(current().state).toBe("registered");
  });
});
