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

// ── A RELEASE IS ONE DECISION, AND THE TWIN KNOWS THE ARGUMENT (arch-review 104) ───────────────────
//
// `PgEnvelopeStore.releaseRuns` decides the decrement on `e.tenant = $3`; the in-memory store took `_tenant`
// on all four methods and stored no tenant at all. Rule `testing` names exactly this blind spot, and it is
// invisible for as long as it stands because no fixture in this file ever passed a SECOND workspace.
//
// The twin mirrors production and does not exceed it: `everdict_envelopes` is keyed by `id` alone and no
// `ON CONFLICT` arm rewrites `tenant`, so admit and settle are id-keyed here too and only the release asks.
//
// Seen RED with the tenant comparison dropped from `releaseRuns`: "another workspace released this claim:
// expected 0 to be 4".
describe("InMemoryEnvelopeStore.releaseRuns — the release consults the tenant its statement consults", () => {
  it("refuses another workspace, and spends nothing while refusing", async () => {
    const store = new InMemoryEnvelopeStore();
    expect(await store.tryAdmitRuns("env-1", "acme", "req-a", 4, 10)).toBe(true);

    await store.releaseRuns("env-1", "other", "req-a");
    expect((await store.spend("env-1")).runs, "another workspace released this claim").toBe(4);

    // …and the refusal consumed nothing: the owner's own release still lands. A release that deleted the
    // claim while refusing the decrement would leave the capacity held by a grant nobody records.
    await store.releaseRuns("env-1", "acme", "req-a");
    expect((await store.spend("env-1")).runs, "the refused release had already spent the claim").toBe(0);
  });

  it("records the opening workspace once, exactly as ON CONFLICT (id) leaves `tenant` alone", async () => {
    const store = new InMemoryEnvelopeStore();
    await store.admit("env-1", "acme", 2);
    await store.settle("env-1", "other", 5); // id-keyed in Postgres too — this must NOT re-file the envelope
    expect(await store.tryAdmitRuns("env-1", "other", "req-b", 1, 10)).toBe(true);

    await store.releaseRuns("env-1", "other", "req-b");
    expect((await store.spend("env-1")).runs, "a later caller re-filed the envelope under its own workspace").toBe(3);
  });
});

// The Postgres half of the same finding: the `gone` DELETE matched on `(request_id, envelope_id)` while the
// decrement additionally required the tenant, so a refused release SPENT the claim and never returned the
// capacity — and the honest retry then found nothing to delete. Both halves now take one decision.
describe("PgEnvelopeStore.releaseRuns — the delete and the decrement ask the same question", () => {
  it("gates the claim deletion on the tenant, not only the counter", async () => {
    const { client, calls } = fakeClient([() => ({ rows: [] })]);
    await new PgEnvelopeStore(client).releaseRuns("env-1", "acme", "req-a");
    const call = calls[0];
    expect(call, "releaseRuns issued no statement").toBeDefined();
    const sql = call?.text ?? "";
    const deleteHalf = sql.slice(0, sql.indexOf("UPDATE everdict_envelopes"));
    expect(deleteHalf, "the claim is deleted without asking whose envelope it is").toContain("e.tenant = $3");
    expect(call?.params).toEqual(["req-a", "env-1", "acme"]);
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
