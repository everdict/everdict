import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { AdoptionCompletionReconciler } from "./adoption-completion-reconciler.js";

// ── AN ADOPTION THAT REGISTERED AND NEVER DISCHARGED HAS AN OWNER (arch-review 115) ─────────────────
//
// The two happy paths join a registration to its issue's resolution and neither owns the debt when a read
// fails. `campaign-adoption-service` swallows its inline issue read under a comment saying the operation
// "stays owed, which the reconciler and any later issue event both still converge on" — there was no
// reconciler, and a later event only exists if the issue has not already closed, which is precisely the
// ordering the inline read exists for.
//
// So the world can be: registry version exists · issue done on the exact proving scorecard · operation
// `registered` · no future event. Nothing converged that before this sweep.
//
// Seen RED without the reconciler by construction — the class did not exist, and the store had no worklist
// to offer it; these cases fail to compile against the previous port.
const PROOF: CampaignAdoptionProof = {
  campaignId: "camp-1",
  frameDigest: "sha256:frame",
  roundSeq: 1,
  candidate: { identity: "exact", type: "agent", id: "everdict", version: "1.0.1", specDigest: "sha256:c1" },
  provingScorecardId: "sc-cand",
  issueId: "iss-1",
  gateDigest: "sha256:gate",
};

function registered(over: Partial<AdoptionOperation> = {}): AdoptionOperation {
  return {
    operationId: "adopt/acme/camp-1",
    tenant: "acme",
    proof: PROOF,
    state: "registered",
    registeredVersion: "1.0.1",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...over,
  } as AdoptionOperation;
}

// A store that answers the worklist and records what the sweep asked it to write. `markCompleted` is a
// CONDITIONAL write, so this double answers the way the real one does rather than always succeeding
// (rule `testing`, the always-succeeds-double law).
function store(rows: AdoptionOperation[]) {
  const state = new Map(rows.map((r) => [r.proof.campaignId, r]));
  const facts: OutboxEvent[] = [];
  const impl: AdoptionOperationStore = {
    async forCampaign(_t, id) {
      return state.get(id);
    },
    async forIssue() {
      return [];
    },
    async markRegistered() {
      return "no_such_operation";
    },
    async registeredOlderThan(olderThan, limit) {
      return [...state.values()].filter((r) => r.state === "registered" && r.updatedAt < olderThan).slice(0, limit);
    },
    async markCompleted(_t, campaignId, proofDigest, events) {
      const row = state.get(campaignId);
      if (!row) return "no_such_operation";
      if (proofDigest !== contentDigest(row.proof)) return "proof_mismatch";
      if (row.state === "completed") return "already_completed";
      if (row.state !== "registered") return "not_registered";
      state.set(campaignId, { ...row, state: "completed" });
      for (const e of events ?? []) facts.push(e);
      return "completed";
    },
  };
  return { impl, state, facts };
}

const NOW = "2026-08-28T01:00:00.000Z";

describe("AdoptionCompletionReconciler", () => {
  it("completes an operation whose issue is done on THIS adoption's proving scorecard", async () => {
    const s = store([registered()]);
    const sweep = await new AdoptionCompletionReconciler({
      operations: s.impl,
      issues: {
        async get() {
          return { status: "done", resolution: { scorecardId: "sc-cand" } };
        },
      },
      now: () => NOW,
      newId: () => "evt_1",
    }).sweep();

    expect(sweep, "the stuck adoption was not converged").toMatchObject({ examined: 1, completed: 1 });
    expect(s.state.get("camp-1")?.state).toBe("completed");
    // The completion is news, on the same fact the other two writers author.
    expect(s.facts).toHaveLength(1);
  });

  it("leaves an issue closed on OTHER evidence alone — a resolution is not this adoption's", async () => {
    const s = store([registered()]);
    const sweep = await new AdoptionCompletionReconciler({
      operations: s.impl,
      issues: {
        async get() {
          return { status: "done", resolution: { scorecardId: "sc-somebody-else" } };
        },
      },
      now: () => NOW,
    }).sweep();

    expect(sweep).toMatchObject({ examined: 1, completed: 0, open: 1 });
    expect(s.state.get("camp-1")?.state, "an adoption discharged on somebody else's evidence").toBe("registered");
  });

  it("keeps the debt when the issue CANNOT BE READ — unknown is not 'not resolved'", async () => {
    const s = store([registered()]);
    const sweep = await new AdoptionCompletionReconciler({
      operations: s.impl,
      issues: {
        async get() {
          throw new Error("issue store unreachable");
        },
      },
      now: () => NOW,
    }).sweep();

    expect(sweep, "an unreadable issue was counted as a decision").toMatchObject({ unknown: 1, completed: 0 });
    expect(s.state.get("camp-1")?.state).toBe("registered");
    // …and the SAME sweep converges once the store answers, which is what "stays owed" has to mean.
    const again = await new AdoptionCompletionReconciler({
      operations: s.impl,
      issues: {
        async get() {
          return { status: "done", resolution: { scorecardId: "sc-cand" } };
        },
      },
      now: () => NOW,
    }).sweep();
    expect(again).toMatchObject({ completed: 1 });
  });

  // ── AN ISSUE THAT IS GONE IS NOT AN ISSUE WE COULD NOT READ (arch-review 116, self-review) ──────
  //
  // The first version of the sweep caught every throw as `unknown`, and `IssueService.get` throws
  // `NotFoundError` for a deleted issue — `DELETE /issues/:id` is a real route. So an adoption whose issue
  // was deleted sat on the worklist forever, re-examined every five minutes and reported as "unreadable",
  // which tells an operator to wait for something that will never happen.
  //
  // Seen RED with the two folded back together: "a deleted issue was reported as merely unreadable:
  // expected 1 to be 0".
  it("counts a DELETED issue apart from an unreadable one", async () => {
    const s = store([registered()]);
    const sweep = await new AdoptionCompletionReconciler({
      operations: s.impl,
      issues: {
        async get() {
          throw new NotFoundError("NOT_FOUND", { id: "iss-1" }, "issue 'iss-1' not found.");
        },
      },
      now: () => NOW,
    }).sweep();

    expect(sweep.orphaned, "a deleted issue was not distinguished").toBe(1);
    expect(sweep.unknown, "a deleted issue was reported as merely unreadable").toBe(0);
    // Neither answer completes it — the intent was never discharged, and saying otherwise would be the
    // annotation failure this whole family is about.
    expect(s.state.get("camp-1")?.state).toBe("registered");
  });

  it("does not touch an operation younger than the grace age — the adopt call may still be inside it", async () => {
    const s = store([registered({ updatedAt: NOW })]);
    const sweep = await new AdoptionCompletionReconciler({
      operations: s.impl,
      issues: {
        async get() {
          throw new Error("must not be read");
        },
      },
      now: () => NOW,
      minAgeMs: 60_000,
    }).sweep();
    expect(sweep).toMatchObject({ examined: 0 });
  });

  it("treats a race it lost as settled, and anything else as still owed", async () => {
    // `already_completed` means one of the other two writers won — success. A row that moved to some other
    // state is NOT success: the sweep re-reads it next time rather than reporting a completion it did not do.
    const s = store([registered({ state: "completed" })]);
    const raced: AdoptionOperationStore = {
      ...s.impl,
      async registeredOlderThan() {
        return [registered()]; // the worklist saw it as registered; the write finds it already completed
      },
    };
    const sweep = await new AdoptionCompletionReconciler({
      operations: raced,
      issues: {
        async get() {
          return { status: "done", resolution: { scorecardId: "sc-cand" } };
        },
      },
      now: () => NOW,
    }).sweep();
    expect(sweep, "a race the sweep lost was not counted as settled").toMatchObject({ completed: 1 });
  });
});
