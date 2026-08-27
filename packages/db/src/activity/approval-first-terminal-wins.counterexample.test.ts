import type { ApprovalRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgApprovalStore } from "./pg-approval-store.js";

// ── "THE FIRST TERMINAL WRITE WINS" WAS A CLAIM, AND THE STATEMENT DID NOT CARRY IT (arch-review 97) ─
//
// `Approval.decide` refuses a second decision, and its comment says so plainly: "decided exactly once (a
// second decision, or deciding an expired ask, is a clean 409; the first terminal write wins, so a race
// between a member and the expiry timer never flaps)."
//
// The domain guard is a READ-THEN-WRITE. `ApprovalService.decide` loads the record, asks the aggregate, and
// then calls `store.update(id, patch)` — whose SQL was `WHERE id = $n` with no status condition at all. So
// two approvers who both loaded a `pending` ask both pass the guard and both UPDATE, and the later one wins:
//
//     alice reads pending → approve → UPDATE (status=approved)
//     bob   reads pending → deny    → UPDATE (status=denied)     ← overwrites a settled decision
//
// Both also emit `approval.decided`, so the feed shows one ask decided twice, and the delivery + resume legs
// run for both. HITL approval is the seam that decides whether an agent's effect proceeds; deciding it by
// arrival order is the annotation failure this review series is named for, in the one place a human was
// asked to be the authority.
//
// The expiry timer is the same race with a different second writer.
//
// Seen RED before the guard reached the statement, observed:
//   a settled decision was overwritten: expected 'UPDATE everdict_approvals SET …' to contain "status = 'pending'"

function fake(rows: unknown[]): { client: SqlClient; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const client: SqlClient = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push([text, params ?? []]);
      return { rows: rows as R[] };
    },
  };
  return { client, calls };
}

const patch: Partial<ApprovalRecord> = {
  status: "approved",
  decidedBy: "alice",
  decidedAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("[R97 COUNTEREXAMPLE] an approval is decided once, and the statement is what says so", () => {
  it("carries the PENDING condition in the UPDATE, not only in the aggregate", async () => {
    const { client, calls } = fake([]);
    await new PgApprovalStore(client).update("ap-1", patch);

    const [sql] = calls.find(([text]) => text.startsWith("UPDATE everdict_approvals")) ?? [""];
    expect(sql, "a settled decision was overwritten").toContain("status = 'pending'");
  });

  it("carries it on the outbox path too — the two spellings must not drift", async () => {
    // The same statement exists twice (with and without the facts CTE), which is exactly how one of them
    // keeps a guard the other loses.
    const { client, calls } = fake([]);
    await new PgApprovalStore(client).update("ap-1", patch, [
      {
        id: "ev-1",
        tenant: "acme",
        kind: "approval.decided",
        // ⚠️ `subject` is a NESTED object, not two flat columns — the first draft flattened it and the
        // clause builder threw on `e.subject.type`. A hand-made outbox row is a row production never emits.
        subject: { type: "approval", id: "ap-1" },
        actor: "alice",
        payload: {},
        message: "decided",
        createdAt: "2026-08-28T00:00:00.000Z",
      } as never,
    ]);

    const [sql] = calls.find(([text]) => text.includes("WITH upd AS")) ?? [""];
    expect(sql, "the outbox path lost the guard the plain path has").toContain("status = 'pending'");
  });

  it("ANSWERS UNDEFINED when the row was already decided — the caller must be able to tell", async () => {
    // Zero rows is the refusal. A caller that reads `undefined` as "nothing changed, carry on" would report
    // a decision that never landed (rule `protocol` L1: a decision rests on the write's answer).
    const { client } = fake([]);
    expect(await new PgApprovalStore(client).update("ap-1", patch)).toBeUndefined();
  });
});
