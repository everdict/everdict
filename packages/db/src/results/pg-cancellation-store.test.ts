import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgCancellationStore } from "./pg-cancellation-store.js";

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

describe("PgCancellationStore", () => {
  it("request upserts on the target id and does NOT rewrite the operation's age", async () => {
    // A batch has exactly one cancellation, so a second request is the SAME operation being attempted again —
    // and the reconciler orders by age, so a re-request must not send it to the back of the queue.
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgCancellationStore(client);

    await store.request({ kind: "scorecard", id: "sc-1" }, "2026-08-15T00:00:00.000Z");

    expect(calls[0]?.text).toContain("ON CONFLICT (scorecard_id) DO UPDATE");
    expect(calls[0]?.text).toContain("state = 'requested'");
    expect(calls[0]?.text).not.toContain("requested_at = ");
    expect(calls[0]?.text).toContain("last_error = NULL"); // the previous attempt's reason, not this one's
    // …and the CERTIFICATE too (mig 0186): it described the completion that just got re-opened.
    expect(calls[0]?.text).toContain("certificate = NULL");
    expect(calls[0]?.params).toEqual(["sc-1", "scorecard", "2026-08-15T00:00:00.000Z"]);
  });

  it("fail records the reason and leaves the operation owed", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgCancellationStore(client);

    await store.fail({ kind: "run", id: "r-1" }, "nomad unreachable", "2026-08-15T00:01:00.000Z");

    // The state is a PARAMETER now (arch-review 53, Wave E): `requested` = the stops did not run,
    // `verifying` = they ran and the postcondition read did not come back zero. Both are owed; the row says
    // which, and an operator reads the difference.
    expect(calls[0]?.text).toContain("completed_at = NULL");
    expect(calls[0]?.params).toEqual(["r-1", "run", "nomad unreachable", "2026-08-15T00:01:00.000Z", "requested"]);
  });

  it("fail(verifying) records the readback attempt on the row, so the budget survives a replica restart", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgCancellationStore(client);

    await store.fail({ kind: "run", id: "r-1" }, "1 job still live", "2026-08-15T00:02:00.000Z", "verifying");

    expect(calls[0]?.params?.[4]).toBe("verifying");
    // Counted in SQL, on the row — the retries are spread across replicas, and a reconciler that restarted
    // would otherwise begin the budget again.
    expect(calls[0]?.text).toContain("verification_attempts");
  });

  it("listIncomplete asks for everything not completed, oldest first", async () => {
    // Anything that is not "completed" is owed — the fail-safe direction: an unrecognizable state gets one
    // more idempotent teardown rather than being silently abandoned.
    const { client, calls } = fakeClient(() => ({
      rows: [
        {
          scorecard_id: "sc-1",
          target_kind: "scorecard",
          state: "requested",
          last_error: "child list unavailable",
          requested_at: "2026-08-15T00:00:00.000Z",
          completed_at: null,
          certificate: null,
        },
        // The sweep reads EVERY kind — the coordinator dispatches each row to the teardown that owns it, so
        // a run's owed operation must come back from the same query rather than needing a second sweep.
        {
          scorecard_id: "r-1",
          target_kind: "run",
          state: "requested",
          last_error: null,
          requested_at: "2026-08-15T00:00:01.000Z",
          completed_at: null,
          certificate: null,
        },
      ],
    }));
    const store = new PgCancellationStore(client);

    const owed = await store.listIncomplete(25);

    // `unverifiable` joins `completed` as terminal (arch-review 53, Wave E) — a readback the cluster will
    // not answer is closed WITH its reason, never swept forever.
    expect(calls[0]?.text).toContain("state NOT IN ('completed', 'unverifiable')");
    expect(calls[0]?.text).toContain("ORDER BY requested_at");
    expect(calls[0]?.params).toEqual([25]);
    expect(owed).toEqual([
      {
        target: { kind: "scorecard", id: "sc-1" },
        state: "requested",
        lastError: "child list unavailable",
        requestedAt: "2026-08-15T00:00:00.000Z",
      },
      {
        target: { kind: "run", id: "r-1" },
        state: "requested",
        requestedAt: "2026-08-15T00:00:01.000Z",
      },
    ]);
  });
});
