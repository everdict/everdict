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
