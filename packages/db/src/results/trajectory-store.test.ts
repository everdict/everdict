import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryTrajectoryStore, PgTrajectoryStore } from "./trajectory-store.js";

// ── WHOSE EVIDENCE THIS IS (review 39 P1) ────────────────────────────────────────────────────────────
describe("TrajectoryStore — a sealed plane names the attempt that produced it", () => {
  it("carries the attempt id onto every plane, so a replay can be matched against a receipt", async () => {
    const store = new InMemoryTrajectoryStore();
    await store.seal({
      runId: "child-1",
      tenant: "acme",
      source: "run",
      attemptId: "evd-sc-1-c1#g1",
      events: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
    });
    // A second PLANE of the same run (the judge's own execution) is a different emitter, and it says which
    // attempt it belongs to as well — a run that was re-driven has planes from more than one.
    await store.seal({
      runId: "child-1",
      tenant: "acme",
      source: "run",
      emitter: "judge:quality",
      attemptId: "evd-sc-1-c1#g1",
      events: [{ t: 1, kind: "llm_call", model: "m" }],
    });
    const sealed = await store.get("acme", "child-1");
    expect(sealed?.segments.map((s) => s.attemptId)).toEqual(["evd-sc-1-c1#g1", "evd-sc-1-c1#g1"]);
  });

  it("a producer that declares none leaves it absent — never a default that reads as agreement", async () => {
    const store = new InMemoryTrajectoryStore();
    await store.seal({
      runId: "child-2",
      tenant: "acme",
      source: "otlp",
      events: [{ t: 0, kind: "message", role: "assistant", text: "x" }],
    });
    expect((await store.get("acme", "child-2"))?.segments[0]?.attemptId).toBeUndefined();
  });
});

// ── ASKING BY IDENTITY, NOT BY CLOCK (arch-review 52, wave 7) ────────────────────────────────────────
//
// The ClickHouse rung certifies this against a live server (there the duplicates are physical rows). Here the
// SAME rule is pinned on the store every unit test and every dev boot runs, so the two rungs cannot answer a
// receipt-holding reader differently.
describe("TrajectoryStore — the exact-identity read serves the attempt the receipt selected", () => {
  const seal = async (store: InMemoryTrajectoryStore, emitter: string, attemptId?: string): Promise<void> => {
    await store.seal({
      runId: "child-1",
      tenant: "acme",
      source: "run",
      emitter,
      ...(attemptId !== undefined ? { attemptId } : {}),
      events: [{ t: 0, kind: "message", role: "assistant", text: emitter }],
    });
  };

  it("keeps the planes that agree — the asked-for attempt and the ones declaring none", async () => {
    // Given a run whose execution plane names the committed attempt and whose judge plane names nothing
    const store = new InMemoryTrajectoryStore();
    await seal(store, "run", "exec-7#g2");
    await seal(store, "judge:quality");

    // When the receipt's identity is asked for, both travel: absence is not disagreement, and dropping the
    // undeclared plane would decay the record in the name of protecting it.
    const read = await store.get("acme", "child-1", { attemptId: "exec-7#g2" });
    expect(read?.segments.map((s) => s.emitter)).toEqual(["run", "judge:quality"]);
    expect(read?.meta.eventCount).toBe(2);
  });

  it("refuses a plane that names a DIFFERENT attempt, and reads undefined when nothing agrees", async () => {
    // Given a run whose only execution evidence belongs to a superseded attempt
    const store = new InMemoryTrajectoryStore();
    await seal(store, "run", "exec-EARLY#g1");
    await seal(store, "infra", "exec-EARLY#g1");

    // Then the committed attempt's evidence is honestly absent — never the nearest row wearing its name.
    expect(await store.get("acme", "child-1", { attemptId: "exec-LATE#g2" })).toBeUndefined();
    // …while the identity that IS there reads back, and the clock read still answers its own question.
    expect((await store.get("acme", "child-1", { attemptId: "exec-EARLY#g1" }))?.segments).toHaveLength(2);
    expect((await store.get("acme", "child-1"))?.segments).toHaveLength(2);
  });

  it("recounts the events over the planes it returned — a count nobody is holding describes nothing", async () => {
    const store = new InMemoryTrajectoryStore();
    await seal(store, "run", "exec-7#g2");
    await seal(store, "service:checkout", "exec-OTHER#g1");

    const read = await store.get("acme", "child-1", { attemptId: "exec-7#g2" });
    expect(read?.segments.map((s) => s.emitter)).toEqual(["run"]);
    expect(read?.meta.eventCount).toBe(1); // not 2 — the service plane was refused, so it is not counted
  });
});

// ── WHAT IT COST, WITHOUT WHAT IT DID (long-horizon OOM) ─────────────────────────────────────────────
//
// The run detail page's cost badge used to be answered by reading the whole trajectory and folding
// `usageFromTrace` over it. On a long-horizon run that is hundreds of megabytes through two full parses for
// five numbers, in a SHARED process. The derivation moved to the writer (rule `protocol` L3) and this is the
// read that replaces it — the tests below pin both halves: the answer, and the absence of the body.
describe("TrajectoryStore — usage is derived at seal and read back without a body", () => {
  const TURN: TraceEvent[] = [
    { t: 0, kind: "message", role: "user", text: "go" },
    { t: 1, kind: "llm_call", model: "opus", cost: { inputTokens: 900, outputTokens: 100, usd: 0.5 } },
    { t: 2, kind: "llm_call", model: "opus", cost: { inputTokens: 100, outputTokens: 10, usd: 0.05 } },
  ];

  it("answers the execution plane's economics", async () => {
    const store = new InMemoryTrajectoryStore();
    await store.seal({ runId: "r1", tenant: "acme", source: "run", events: TURN });

    expect(await store.usage("acme", "r1")).toEqual({
      kind: "derived",
      usage: { promptTokens: 1000, completionTokens: 110, totalTokens: 1110, usd: 0.55, calls: 2 },
    });
  });

  it("answers for the EXECUTION plane even when a service plane sealed first", async () => {
    // The multi-plane case, and the reason `executionEmitterOf` is shared rather than re-spelled here: a
    // topology run's services push their spans before the agent settles, so the header row is the service's.
    // Reporting the header's economics would bill a checkout service's LLM calls as the agent's.
    const store = new InMemoryTrajectoryStore();
    await store.seal({
      runId: "r2",
      tenant: "acme",
      source: "otlp",
      emitter: "service:checkout",
      events: [{ t: 0, kind: "llm_call", model: "cheap", cost: { inputTokens: 1, outputTokens: 1, usd: 999 } }],
    });
    await store.seal({ runId: "r2", tenant: "acme", source: "run", emitter: "run", events: TURN });

    const answer = await store.usage("acme", "r2");
    expect(answer.kind === "derived" && answer.usage.usd).toBe(0.55); // the agent's, not the service's 999
  });

  it("is absent for another workspace's run — the same answer a nonexistent one gets", async () => {
    const store = new InMemoryTrajectoryStore();
    await store.seal({ runId: "r3", tenant: "acme", source: "run", events: TURN });

    expect(await store.usage("other", "r3")).toEqual({ kind: "absent" });
    expect(await store.usage("acme", "nope")).toEqual({ kind: "absent" });
  });

  it("Pg: the statement selects no body, and a row sealed before the column is UNKNOWN — never zero", async () => {
    // The whole point of the read, asserted structurally: `body` in this statement would reinstate the OOM
    // while every behavioral test above still passed.
    const { client, calls } = fakeClient(() => ({
      rows: [{ emitter: "run", tenant: "acme", usage: null, header: true }],
    }));

    const answer = await new PgTrajectoryStore(client).usage("acme", "r4");

    expect(calls[0]?.text).not.toMatch(/\bbody\b/);
    // A legacy row's cost is UNKNOWN. Answering `derived` with zeros here would invent a billing-adjacent
    // number in the one place a reader would never think to doubt it.
    expect(answer).toEqual({ kind: "unknown", reason: "sealed_before_derivation" });
  });

  it("Pg: a derived row is validated at the boundary like every other jsonb column", async () => {
    const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3, usd: 0.1, calls: 1 };
    const { client } = fakeClient(() => ({ rows: [{ emitter: "run", tenant: "acme", usage, header: true }] }));

    expect(await new PgTrajectoryStore(client).usage("acme", "r5")).toEqual({ kind: "derived", usage });
  });

  it("Pg: a foreign workspace's header answers absent, so the read leaks no existence", async () => {
    const { client } = fakeClient(() => ({ rows: [{ emitter: "run", tenant: "other", usage: null, header: true }] }));

    expect(await new PgTrajectoryStore(client).usage("acme", "r6")).toEqual({ kind: "absent" });
  });
});

// The house fake SqlClient (the `scorecard-store.test.ts` precedent): assert the parameterized SQL text and
// the row → record mapping, never a live database.
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
