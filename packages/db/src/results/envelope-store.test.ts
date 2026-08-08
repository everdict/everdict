import { ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryEnvelopeStore, PgEnvelopeStore } from "./envelope-store.js";

// Claim-first, payload-bound envelope admission (arch-review 6, H6). The mig-0141 shape probed request
// existence and wrote the row FROM the counter claim — two concurrent same-id calls both passed the empty
// probe and both charged the counter, and a held id re-answered true for ANY payload (claim 1 run, "retry"
// with 100: a cap bypass). These tests pin the request-row semantics on both twins.

function fakeClient(script: Array<(text: string, params?: unknown[]) => { rows: unknown[] }>): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    client: {
      async query(text, params) {
        calls.push({ text, params });
        const step = script[calls.length - 1];
        if (!step) throw new Error(`unscripted query #${calls.length}: ${text.slice(0, 60)}`);
        return step(text, params) as { rows: never[] };
      },
    },
  };
}

describe("InMemoryEnvelopeStore.tryAdmitRuns — the same request is the same right, and only the same request", () => {
  it("re-answers a held request WITHOUT a second charge", async () => {
    const store = new InMemoryEnvelopeStore();
    expect(await store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 1, 1)).toBe(true);
    expect(await store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 1, 1)).toBe(true); // the retry
    expect((await store.spend("env-1")).runs).toBe(1); // charged once — conservation
  });

  it("refuses a held request id re-presented with a DIFFERENT ask — a receipt is not transferable", async () => {
    const store = new InMemoryEnvelopeStore();
    await store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 1, 100);
    await expect(store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 100, 100)).rejects.toThrow(ConflictError);
    await expect(store.tryAdmitRuns("env-OTHER", "acme", "adm:run:r1", 1, 100)).rejects.toThrow(ConflictError);
    expect((await store.spend("env-1")).runs).toBe(1);
  });

  it("a refusal holds nothing — the same id can ask again once capacity exists", async () => {
    const store = new InMemoryEnvelopeStore();
    await store.admit("env-1", "acme", 1); // cap already consumed
    expect(await store.tryAdmitRuns("env-1", "acme", "adm:run:r2", 1, 1)).toBe(false);
    expect(await store.tryAdmitRuns("env-1", "acme", "adm:run:r2", 1, 2)).toBe(true); // capacity freed (cap raised)
    expect((await store.spend("env-1")).runs).toBe(2);
  });
});

describe("PgEnvelopeStore.tryAdmitRuns — claim first, decide second, counter exactly once", () => {
  const claimRow = (over: Record<string, unknown> = {}): { rows: unknown[] } => ({
    rows: [{ envelope_id: "env-1", runs: 3, admitted: null, inserted: true, ...over }],
  });

  it("a fresh claim inserts the PENDING request row before any counter movement, then decides it", async () => {
    const { client, calls } = fakeClient([() => claimRow(), () => ({ rows: [{ pending: 1, granted: 1 }] })]);
    const store = new PgEnvelopeStore(client);
    expect(await store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 3, 10)).toBe(true);
    // The FIRST statement touches only the request table — the claim exists before the counter moves.
    expect(calls[0]?.text).toContain("INSERT INTO everdict_envelope_admissions");
    expect(calls[0]?.text).not.toContain("everdict_envelopes ");
    expect(calls[0]?.params).toEqual(["adm:run:r1", "env-1", 3]);
    // The decision charges FROM the claimed row (req.runs), cap-guarded on the latest row version.
    expect(calls[1]?.text).toContain("FOR UPDATE");
    expect(calls[1]?.text).toContain("admitted_runs + EXCLUDED.admitted_runs <=");
    expect(calls[1]?.params).toEqual(["adm:run:r1", "acme", 10]);
  });

  it("a held request re-answers from the claim row alone — no second statement, no second charge", async () => {
    const { client, calls } = fakeClient([() => claimRow({ admitted: true, inserted: false })]);
    const store = new PgEnvelopeStore(client);
    expect(await store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 3, 10)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a held request with a DIFFERENT payload throws — never a silent re-grant", async () => {
    const { client } = fakeClient([() => claimRow({ admitted: true, inserted: false, runs: 1 })]);
    const store = new PgEnvelopeStore(client);
    await expect(store.tryAdmitRuns("env-1", "acme", "adm:run:r1", 100, 100)).rejects.toThrow(ConflictError);
  });

  it("a refusal returns false (the decision deleted the claim), and a decision race loops back to re-read", async () => {
    const refused = fakeClient([() => claimRow(), () => ({ rows: [{ pending: 1, granted: 0 }] })]);
    expect(await new PgEnvelopeStore(refused.client).tryAdmitRuns("env-1", "acme", "r", 3, 2)).toBe(false);

    // Race: a concurrent decider settled the pending row first (pending: 0) — the loop re-claims and finds
    // the row held, answering true without ever touching the counter itself.
    const raced = fakeClient([
      () => claimRow({ inserted: false, admitted: null }),
      () => ({ rows: [{ pending: 0, granted: 0 }] }),
      () => claimRow({ inserted: false, admitted: true }),
    ]);
    expect(await new PgEnvelopeStore(raced.client).tryAdmitRuns("env-1", "acme", "r", 3, 10)).toBe(true);
    expect(raced.calls).toHaveLength(3);
  });
});
