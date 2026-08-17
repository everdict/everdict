import type { TraceSinkCase, TraceSinkContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { seededIds } from "./idempotent-ids.js";
import { langfuseBatch } from "./langfuse-sink.js";

// ── A RETRIED EXPORT IS THE SAME EXPORT (arch-review 54, Phase 4) ────────────────────────────────────
//
// The export is at-least-once: the publication operation is claimed, the sink is called, and a crash before
// the receipt lands leaves the operation owed for the reconciler to call again. Wave C minted an
// `idempotencyKey` for exactly that and passed it into a context type that did not declare it — so it
// reached the adapter and could not be read, and every adapter minted fresh UUIDs per call. The tenant's
// platform got two traces for one judged batch with nothing saying they were the same export.
//
// This pins the property that matters end to end: same key in, same ids out.

const CASE: TraceSinkCase = {
  caseId: "c1",
  trace: [{ kind: "message", t: 1, role: "user", text: "do the thing" }],
  scores: [{ name: "tests_pass", value: 1, pass: true }],
};

const ctx = (over: Partial<TraceSinkContext> = {}): TraceSinkContext => ({
  scorecardId: "sc-1",
  dataset: "d@1.0.0",
  harness: "h@1",
  ...over,
});

describe("an at-least-once export carries an idempotency key the sink can dedupe on", () => {
  it("declares the key on the contract both ends share", () => {
    // The type-level half, and the reason this test could not be planted with the others: `describe.skip`
    // suppresses the runtime, not `tsc`. Its runtime half also PASSED over the gap — an undeclared property
    // survives a call into a narrower parameter type, so asserting `ctx.idempotencyKey` after the hop was
    // green while no adapter could read it.
    const declared: TraceSinkContext = ctx({ idempotencyKey: "sc-1:pass-1" });
    expect(declared.idempotencyKey).toBe("sc-1:pass-1");
  });

  it("mints the same trace and event ids when the same export is retried", () => {
    const first = langfuseBatch(
      ctx({ idempotencyKey: "sc-1:pass-1" }),
      [CASE],
      seededIds("sc-1:pass-1"),
      () => "2026-08-18T00:00:00.000Z",
    );
    const retry = langfuseBatch(
      ctx({ idempotencyKey: "sc-1:pass-1" }),
      [CASE],
      seededIds("sc-1:pass-1"),
      () => "2026-08-18T00:05:00.000Z", // a later sweep — the clock moved, the export did not
    );
    expect(first.traceIdByCase.get("c1"), "the fixture must produce a trace id to compare").toBeTruthy();
    expect(retry.traceIdByCase.get("c1")).toBe(first.traceIdByCase.get("c1"));
    expect(retry.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });

  it("mints DIFFERENT ids for a different export, so the sequence is not reused across settlements", () => {
    // The other half of the seeded generator: it is deterministic per key, not globally. Two settlements of
    // one scorecard must not collapse into each other on the platform.
    const one = langfuseBatch(
      ctx({ idempotencyKey: "sc-1:pass-1" }),
      [CASE],
      seededIds("sc-1:pass-1"),
      () => "2026-08-18T00:00:00.000Z",
    );
    const two = langfuseBatch(
      ctx({ idempotencyKey: "sc-1:pass-2" }),
      [CASE],
      seededIds("sc-1:pass-2"),
      () => "2026-08-18T00:00:00.000Z",
    );
    expect(two.traceIdByCase.get("c1")).not.toBe(one.traceIdByCase.get("c1"));
  });
});
