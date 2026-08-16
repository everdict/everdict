import { describe, expect, it } from "vitest";
import { InMemoryTrajectoryStore } from "./trajectory-store.js";

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
