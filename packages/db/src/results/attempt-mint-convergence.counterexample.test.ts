import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgExecutionAttemptStore } from "./pg-execution-attempt-store.js";

// ── A RACE CONVERGES FOR N OPENERS, NOT FOR TWO (arch-review 66 P1-adapter) ────────────────────────
//
// `open` claims `MAX(generation)+1` in one statement and lets the UNIQUE constraint arbitrate, which is the
// right shape. What it did with a REFUSAL was retry exactly once, defended by "a second collision means
// something other than a race".
//
// With three concurrent openers that sentence is false, and three is not exotic — tail speculation, a
// spillover duplicate and a retry overlap by design. A, B and C all try N+1; A wins; B and C both retry N+2;
// B wins; and C's second collision, an ordinary race, became a store fault that failed a dispatch with
// nothing wrong with it.
//
// ⚠️ DRIVEN DETERMINISTICALLY, not as a race. The real-Postgres scenario beside this (TRUST-179) opens five
// at once and is the integration proof — but a genuine race does not reliably produce a THIRD collision, so
// on its own it passes with the old ceiling too. A test that is green before and after the change pins
// nothing (rule `testing`). The fake refuses a fixed number of times, so the loop is what is measured.
//
// Seen RED with the single retry, observed:
//   a third collision turned an ordinary race into a store fault: duplicate key value violates unique constraint

const EXECUTION = storedExecutionId("evd-sc-1-c1");

// A client whose insert raises 23505 the first `collisions` times, exactly as Postgres does when two openers
// claim one generation, and then succeeds.
function clientRefusing(collisions: number): SqlClient & { inserts: () => number } {
  let seen = 0;
  return {
    inserts: () => seen,
    async query<T>(text: string): Promise<{ rows: T[] }> {
      if (!text.includes("INSERT INTO everdict_execution_attempts")) return { rows: [] };
      seen += 1;
      if (seen <= collisions) {
        const err = new Error('duplicate key value violates unique constraint "everdict_execution_attempts_pkey"');
        (err as unknown as { code: string }).code = "23505";
        throw err;
      }
      return {
        rows: [{ attempt_id: `${EXECUTION}#g${seen}`, generation: seen } as unknown as T],
      };
    },
  } as unknown as SqlClient & { inserts: () => number };
}

describe("[R66 COUNTEREXAMPLE] the attempt mint converges for more than two openers", () => {
  it("CLAIMS an ordinal after a third collision, which is still an ordinary race", async () => {
    const client = clientRefusing(2);
    const store = new PgExecutionAttemptStore(client);

    const opened = await store.open({ executionId: EXECUTION, tenant: "acme" });

    expect(opened.generation, "a third collision turned an ordinary race into a store fault").toBe(3);
    expect(client.inserts(), "the mint gave up before it had raced").toBe(3);
  });

  it("still REFUSES when the collisions are not a race at all", async () => {
    // The control, and the reason the retry is bounded: an unbounded loop turns a broken sequence or an
    // unexpected constraint into a hang. The ceiling exhausting is a genuine fault and says so.
    const store = new PgExecutionAttemptStore(clientRefusing(Number.POSITIVE_INFINITY));

    await expect(store.open({ executionId: EXECUTION, tenant: "acme" })).rejects.toThrow(/no longer an ordinary race/);
  });

  it("does not retry a fault that is NOT a collision", async () => {
    // A non-23505 error is not a race and must propagate on the first attempt — retrying a broken connection
    // eight times is a slower failure, not a better one.
    let inserts = 0;
    const client = {
      async query(text: string) {
        if (!text.includes("INSERT INTO everdict_execution_attempts")) return { rows: [] };
        inserts += 1;
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as SqlClient;

    await expect(new PgExecutionAttemptStore(client).open({ executionId: EXECUTION, tenant: "acme" })).rejects.toThrow(
      /connection terminated/,
    );
    expect(inserts, "a store fault was retried as though it were a race").toBe(1);
  });
});
