import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";

// What the sweep rescheduled, so a test can assert a turn was GIVEN rather than merely asked for.
const deferred: string[] = [];
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
    // The scheduling write the sweep makes for a row it could not finish (arch-review 120). Recorded rather
    // than ignored: a double that swallows it cannot tell a reconciler that reschedules from one that starves.
    async deferCompletion(input: { tenant: string; campaignId: string; outcome: string; nextAttemptAt: string }) {
      deferred.push(`${input.campaignId}:${input.outcome}`);
      return true;
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

// ── [R120 COUNTEREXAMPLE] EVERY DEBT RECEIVES A TURN ────────────────────────────────────────────────
//
// The worklist was `state = 'registered' AND updated_at < cutoff ORDER BY updated_at ASC LIMIT 100`, and
// nothing the sweep does to a row it CANNOT complete moves `updated_at`. So the hundred oldest operations —
// an issue still open, or an issue DELETED and therefore never resolvable — held the head of that list on
// every sweep, and a newer operation whose issue IS done on its exact proving scorecard was never read.
//
//     a periodic owner exists   ≠   every debt receives a turn
//
// The reconciler ran on schedule, reported honest numbers, and converged nothing. That is worse than an
// absent owner, because the numbers say somebody is working on it.
//
// Seen RED before the scheduling fields: the newer operation was still `registered` after ten sweeps, and
// `examined` was 100 every time — the same hundred rows.
describe("[R120 COUNTEREXAMPLE] a blocked worklist does not starve a completable operation", () => {
  const AT = (n: number) => new Date(Date.parse("2026-08-28T00:00:00.000Z") + n).toISOString();

  // One store holding many blockers and one completable operation, with the DUE-first semantics the Pg twin
  // has — the ordering under test, not a convenience.
  function crowded(blockers: number) {
    const rows = new Map<string, AdoptionOperation>();
    const nextAt = new Map<string, string>();
    for (let i = 0; i < blockers; i++) {
      const id = `blocked-${i}`;
      rows.set(
        id,
        registered({
          operationId: `op/${id}`,
          proof: { ...PROOF, campaignId: id, issueId: `iss-${id}` },
          updatedAt: AT(i),
        }),
      );
    }
    // …filed LAST, so oldest-first would never reach it.
    rows.set(
      "ready",
      registered({
        operationId: "op/ready",
        proof: { ...PROOF, campaignId: "ready", issueId: "iss-ready" },
        updatedAt: AT(blockers + 1),
      }),
    );
    const impl: AdoptionOperationStore = {
      async forCampaign(_t, id) {
        return rows.get(id);
      },
      async forIssue() {
        return [];
      },
      async markRegistered() {
        return "no_such_operation";
      },
      async registeredOlderThan(olderThan, limit) {
        return [...rows.values()]
          .filter(
            (r) =>
              r.state === "registered" &&
              r.updatedAt < olderThan &&
              (nextAt.get(r.proof.campaignId) ?? "") <= olderThan,
          )
          .sort(
            (a, b) =>
              (nextAt.get(a.proof.campaignId) ?? "").localeCompare(nextAt.get(b.proof.campaignId) ?? "") ||
              a.updatedAt.localeCompare(b.updatedAt),
          )
          .slice(0, limit);
      },
      async deferCompletion(input) {
        nextAt.set(input.campaignId, input.nextAttemptAt);
        return true;
      },
      async markCompleted(_t, campaignId) {
        const row = rows.get(campaignId);
        if (!row) return "no_such_operation";
        rows.set(campaignId, { ...row, state: "completed" });
        return "completed";
      },
    };
    return { impl, rows };
  }

  it("reaches the newer completable operation despite a full page of blockers", async () => {
    const { impl, rows } = crowded(100);
    // Every blocker's issue is OPEN; the newer one's is done on its exact proving scorecard.
    const issues = {
      async get(_t: string, ref: string) {
        return ref === "iss-ready"
          ? { status: "done", resolution: { scorecardId: "sc-cand" } }
          : { status: "in_progress" };
      },
    };
    // A page of 100 and 101 owed rows: without a turn, the same hundred are read for ever.
    let clock = Date.parse("2026-08-28T02:00:00.000Z");
    for (let sweep = 0; sweep < 5 && rows.get("ready")?.state !== "completed"; sweep++) {
      await new AdoptionCompletionReconciler({
        operations: impl,
        issues,
        limit: 100,
        now: () => new Date(clock).toISOString(),
      }).sweep();
      clock += 10 * 60_000; // the next scheduled sweep
    }

    expect(rows.get("ready")?.state, "a completable operation was starved by older blockers").toBe("completed");
  });

  it("keeps an ORPHANED operation owed while getting it out of the way", async () => {
    // An issue that is GONE never resolves, so re-reading it every sweep buys nothing and costs the turn of
    // a row that could finish. It stays `registered` — the debt is not discharged by being unreachable.
    const { impl, rows } = crowded(1);
    const issues = {
      async get() {
        throw new NotFoundError("NOT_FOUND", {}, "issue not found");
      },
    };
    const first = await new AdoptionCompletionReconciler({
      operations: impl,
      issues,
      limit: 100,
      now: () => "2026-08-28T02:00:00.000Z",
    }).sweep();
    // BOTH rows are orphaned here: this fixture's issue store answers NotFound for every ref, which is the
    // world a deleted issue leaves behind. Asserting 1 was my own miscount, and it is the kind that reads as
    // a code failure — the number the subject reported was right.
    expect(first.orphaned).toBe(2);

    // The next ordinary sweep does not see them again…
    const second = await new AdoptionCompletionReconciler({
      operations: impl,
      issues,
      limit: 100,
      now: () => "2026-08-28T02:10:00.000Z",
    }).sweep();
    expect(second.examined, "an orphaned row kept its place at the head of the worklist").toBe(0);
    // …and it is still owed, because "cannot find out" is an escalation, never a terminal.
    expect(rows.get("blocked-0")?.state).toBe("registered");
  });
});
