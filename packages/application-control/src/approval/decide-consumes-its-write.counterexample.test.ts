import type { ApprovalRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { ApprovalStore } from "../ports/approval-store.js";
import { ApprovalService } from "./approval-service.js";

// ── A DECISION THAT RESTS ON A CONDITIONAL WRITE CONSUMES ITS ANSWER (arch-review 97) ───────────────
//
// `Approval.decide` refuses a second decision, and the store's UPDATE is fenced on `status = 'pending'` now
// — so a race between two approvers (or between a member and the expiry sweep) makes the loser's UPDATE
// match zero rows and return `undefined`.
//
// The service used to read that as a missing return value:
//
//     const record = updated ?? { ...current, ...transition.patch };
//
// which SYNTHESIZES the record the caller wanted. The loser was told its decision landed, the delivery and
// resume legs ran for a decision that does not exist, and the ask's real outcome was the other writer's. A
// synthesized success is worse than an error, because nothing downstream can tell it apart from a real one.
//
// Seen RED before the refusal was consumed, observed:
//   a decision that never landed was reported as the outcome: expected [Function] to throw

// The record's real shape — `request.name` is read by the transition that builds the fact, so a thinner
// fixture fails for a reason that has nothing to do with the race (rule `testing`: the red message has to
// name the invariant).
const pending: ApprovalRecord = {
  id: "ap-1",
  tenant: "acme",
  sessionId: "s-1",
  requestId: "r-1",
  request: { name: "write_file" },
  status: "pending",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
} as unknown as ApprovalRecord;

// A store whose UPDATE answers the way the fenced statement does: the row for a caller that won, `undefined`
// for one that lost. A double that always returned a row could not express the race at all.
function store(updateAnswers: ApprovalRecord | undefined): ApprovalStore {
  return {
    async get() {
      return pending;
    },
    async update() {
      return updateAnswers;
    },
    async create() {},
    async list() {
      return [];
    },
  } as unknown as ApprovalStore;
}

const service = (s: ApprovalStore, delivered: string[] = []) =>
  new ApprovalService({
    store: s,
    deliver: async () => {
      delivered.push("delivered");
      return true;
    },
    now: () => "2026-08-28T00:01:00.000Z",
    newId: () => "ev-1",
  } as never);

describe("[R97 COUNTEREXAMPLE] the loser of a decision race is told it lost", () => {
  it("REFUSES when the fenced UPDATE matched no row", async () => {
    const delivered: string[] = [];

    await expect(
      service(store(undefined), delivered).decide({ tenant: "acme", id: "ap-1", decision: "deny" }),
      "a decision that never landed was reported as the outcome",
    ).rejects.toThrow(/decided by somebody else/);

    // …and the effect legs did NOT run for it. This is the assertion that makes the refusal matter: a
    // synthesized record still delivered, so an agent was released on a decision nobody made.
    expect(delivered, "the delivery leg ran for a decision that does not exist").toEqual([]);
  });

  it("ANSWERS the winner with the row the store returned, not the patch it hoped for", async () => {
    // The control, and the other half of L1: the caller uses the PERSISTED value, never the local copy it
    // happened to be holding (rule `protocol`, the read-back law).
    const landed = { ...pending, status: "approved", decidedBy: "alice" } as ApprovalRecord;
    const delivered: string[] = [];

    const out = await service(store(landed), delivered).decide({
      tenant: "acme",
      id: "ap-1",
      decision: "approve",
      decidedBy: "alice",
    });

    expect(out.record.status).toBe("approved");
    expect(out.record.decidedBy).toBe("alice");
    expect(delivered).toEqual(["delivered"]);
  });
});
