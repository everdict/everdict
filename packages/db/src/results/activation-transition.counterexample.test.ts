import type { RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgExecutionAttemptStore } from "./pg-execution-attempt-store.js";

// ── THE ACTIVATION IS A TRANSITION, NOT A READ FOLLOWED BY A WRITE (arch-review 57 P0) ───────────────
//
// A reservation used to be a proof with no expiry: the caller that won one held it across a GC pause, a slow
// cluster API, a rescheduled pod — and nothing re-consumed it before the external object was created. A
// cancellation could kill that work, probe it absent, settle every child and COMPLETE, after which the paused
// caller woke and made the job. Verified zero, then a birth.
//
// So the dispatch re-presents its reservation where the effect begins, and the shape matters as much as the
// check: SELECT-then-UPDATE would re-open the very window it closes. One statement asserts state, work id and
// parent authority together, and its RETURNING is the permission.
//
// RED as of 9d67491d, observed:
//   store.activateWork is not a function
//
// What this file pins is the SQL, because that is where the atomicity lives. The decision's vocabulary is
// driven separately (`dispatch-activation.counterexample.test.ts` in @everdict/contracts), and the in-memory
// twin answers from the same function so both stores agree.

const work: RuntimeWorkRef = {
  tenant: "acme",
  runId: "r1",
  externalJobId: "everdict-c1-abc",
  namespace: "evd",
};

function fakeClient(handler: (text: string) => { rows: unknown[] }): {
  client: SqlClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client: SqlClient = {
    async query(text) {
      calls.push(text);
      return handler(text) as { rows: never[] };
    },
  };
  return { client, calls };
}

describe("[R57 COUNTEREXAMPLE] activating a reservation is one conditional statement", () => {
  it("moves reserved → active in a single UPDATE that asserts work id AND parent authority", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ attempt_id: "a1" }] }));
    const decision = await new PgExecutionAttemptStore(client).activateWork("a1", work);

    expect(decision).toEqual({ kind: "activate" });
    // ONE statement — a second query here would mean the permission was read before it was taken.
    expect(calls, `activation took ${calls.length} statements: ${calls.join(" | ")}`).toHaveLength(1);
    const sql = calls[0] ?? "";
    expect(sql).toMatch(/UPDATE everdict_execution_attempts/i);
    expect(sql, "the transition did not require the attempt to be reserved").toMatch(/state = 'reserved'/);
    expect(sql, "the transition did not pin the exact work id").toMatch(/externalJobId/);
    expect(sql, "the transition did not re-check the parent's authority").toMatch(/EXISTS|authorized|parent/i);
    expect(sql, "nothing was returned, so a caller cannot tell the write happened").toMatch(/RETURNING/i);
  });

  it("REFUSES with a reason when nothing moved — a revoked reservation fails at the seam", async () => {
    // The read-back is only reached when the conditional write matched nothing, and it exists so the lane
    // gets an actionable answer rather than a bare false.
    const { client } = fakeClient((text) =>
      /^UPDATE/i.test(text.trim())
        ? { rows: [] }
        : { rows: [{ state: "revoked", external_job_id: "everdict-c1-abc", authorized: true }] },
    );
    const decision = await new PgExecutionAttemptStore(client).activateWork("a1", work);
    expect(decision).toMatchObject({ kind: "refuse" });
    expect(decision.kind === "refuse" ? decision.reason : "").toMatch(/revoked/i);
  });

  it("is IDEMPOTENT for an attempt already active — a re-driven dispatch is not a second birth", async () => {
    const { client } = fakeClient((text) =>
      /^UPDATE/i.test(text.trim())
        ? { rows: [] }
        : { rows: [{ state: "active", external_job_id: "everdict-c1-abc", authorized: true }] },
    );
    expect(await new PgExecutionAttemptStore(client).activateWork("a1", work)).toEqual({ kind: "already_active" });
  });

  it("REFUSES when the parent no longer authorizes, even though the row still says reserved", async () => {
    const { client } = fakeClient((text) =>
      /^UPDATE/i.test(text.trim())
        ? { rows: [] }
        : { rows: [{ state: "reserved", external_job_id: "everdict-c1-abc", authorized: false }] },
    );
    const decision = await new PgExecutionAttemptStore(client).activateWork("a1", work);
    expect(decision).toMatchObject({ kind: "refuse" });
  });

  it("revoking never revives a settled attempt", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgExecutionAttemptStore(client).revokeReservation("a1");
    const sql = calls[0] ?? "";
    expect(sql).toMatch(/state = 'revoked'/);
    expect(sql, "a settled attempt could be dragged back into revoked").toMatch(/NOT IN/i);
  });
});
