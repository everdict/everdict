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
  it("request upserts on the scorecard id and does NOT rewrite the operation's age", async () => {
    // A batch has exactly one cancellation, so a second request is the SAME operation being attempted again —
    // and the reconciler orders by age, so a re-request must not send it to the back of the queue.
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgCancellationStore(client);

    await store.request("sc-1", "2026-08-15T00:00:00.000Z");

    expect(calls[0]?.text).toContain("ON CONFLICT (scorecard_id) DO UPDATE");
    expect(calls[0]?.text).toContain("state = 'requested'");
    expect(calls[0]?.text).not.toContain("requested_at = ");
    expect(calls[0]?.text).toContain("last_error = NULL"); // the previous attempt's reason, not this one's
    expect(calls[0]?.params).toEqual(["sc-1", "2026-08-15T00:00:00.000Z"]);
  });

  it("fail records the reason and leaves the operation owed", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgCancellationStore(client);

    await store.fail("sc-1", "child list unavailable", "2026-08-15T00:01:00.000Z");

    expect(calls[0]?.text).toContain("state = 'requested'"); // still owed — `fail` is not a terminal state
    expect(calls[0]?.text).toContain("completed_at = NULL");
    expect(calls[0]?.params).toEqual(["sc-1", "child list unavailable", "2026-08-15T00:01:00.000Z"]);
  });

  it("listIncomplete asks for everything not completed, oldest first", async () => {
    // Anything that is not "completed" is owed — the fail-safe direction: an unrecognizable state gets one
    // more idempotent teardown rather than being silently abandoned.
    const { client, calls } = fakeClient(() => ({
      rows: [
        {
          scorecard_id: "sc-1",
          state: "requested",
          last_error: "child list unavailable",
          requested_at: "2026-08-15T00:00:00.000Z",
          completed_at: null,
        },
      ],
    }));
    const store = new PgCancellationStore(client);

    const owed = await store.listIncomplete(25);

    expect(calls[0]?.text).toContain("state <> 'completed'");
    expect(calls[0]?.text).toContain("ORDER BY requested_at");
    expect(calls[0]?.params).toEqual([25]);
    expect(owed).toEqual([
      {
        scorecardId: "sc-1",
        state: "requested",
        lastError: "child list unavailable",
        requestedAt: "2026-08-15T00:00:00.000Z",
      },
    ]);
  });
});
