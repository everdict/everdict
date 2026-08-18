import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgPublicationOperationStore } from "./pg-publication-operation-store.js";

function fakeClient(rows: unknown[] = []): { client: SqlClient; calls: Array<{ text: string; params?: unknown[] }> } {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    client: {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: rows as never[] };
      },
    },
  };
}

describe("PgPublicationOperationStore", () => {
  // ── THE HEARTBEAT'S WRITE IS A GUARDED UPDATE (arch-review 55, Wave 8) ────────────────────────────
  //
  // The drain renews while the sink call is in flight, because an export carrying a whole batch's traces
  // routinely outruns a lease sized for "a publisher's process died" — and the moment it did, `listOwed` saw
  // a `claimed` row with an expired lease, which is the ledger's definition of an abandoned drain, and handed
  // the operation to a second publisher mid-upload.
  //
  // What the SQL has to say is that a renewal is not a second way to TAKE the row: it moves a lease this
  // owner still holds, and matches nothing otherwise. Asserted on the WHERE clause rather than on a returned
  // value, because that is where the protocol lives.
  it("renew moves the lease only for the owner who still holds a live claim", async () => {
    const { client, calls } = fakeClient([{ id: "sc-1#r1#pass-1" }]);

    expect(await new PgPublicationOperationStore(client).renew("sc-1#r1#pass-1", "publisher-1", 120, "t")).toBe(true);

    const text = calls[0]?.text ?? "";
    expect(text).toContain("UPDATE everdict_publication_operations");
    expect(text).toContain("lease_until = $3::timestamptz + make_interval(secs => $4)");
    // The guard, in full: the row, the owner, AND the state. Dropping any one of them lets a renewal revive a
    // claim somebody else took (owner), or one this publisher already finished (state).
    expect(text).toContain("WHERE id = $1 AND claimed_by = $2 AND state = 'claimed'");
    expect(text).toContain("RETURNING id");
    expect(calls[0]?.params).toEqual(["sc-1#r1#pass-1", "publisher-1", "t", 120]);
  });

  it("renew answers false when the guarded update matched nothing — the heartbeat learns it lost", async () => {
    // No row matched: the lease expired and the sweep re-claimed, or the operation is already terminal. The
    // drain's heartbeat stops on this rather than retrying against a claim it no longer has.
    const { client } = fakeClient([]);
    expect(await new PgPublicationOperationStore(client).renew("sc-1#r1#pass-1", "publisher-1", 120, "t")).toBe(false);
  });

  it("claim and renew size the lease the same way, so a heartbeat cannot shorten one", async () => {
    // Two statements computing one quantity is how the two drift; asserted together because the failure mode
    // is silent — a renewal that granted less than the claim would shrink the fence every beat.
    // `claim` parses the row it returns, so the fixture is a real row rather than a stub id.
    const { client, calls } = fakeClient([
      {
        id: "sc-1#r1#pass-1",
        scorecard_id: "sc-1",
        scoring_revision: 1,
        pass_id: "pass-1",
        state: "claimed",
        effects: [],
        planned_at: "2026-08-18T00:00:00.000Z",
        published_at: null,
        last_error: null,
        claimed_by: "p",
        lease_until: "2026-08-18T00:02:00.000Z",
      },
    ]);
    const store = new PgPublicationOperationStore(client);
    await store.claim("op", "p", 120, "t");
    await store.renew("op", "p", 120, "t");
    const interval = "make_interval(secs => $4)";
    expect(calls[0]?.text).toContain(interval);
    expect(calls[1]?.text).toContain(interval);
  });
});
