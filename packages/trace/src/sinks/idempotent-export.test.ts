import type { TraceSinkCase, TraceSinkContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { LangfuseTraceSink } from "./langfuse-sink.js";

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

  // THROUGH THE ADAPTER, not through its payload builder. The first version of this test called
  // `langfuseBatch` directly and handed it `seededIds(key)` itself — so it proved the generator is
  // deterministic and proved NOTHING about whether `export()` uses it. `protocol-mutations` said so: removing
  // the wiring left this suite green. What has to be exercised is the line that chooses the generator.
  async function idsFrom(key: string, now: string): Promise<string[]> {
    const bodies: unknown[] = [];
    const sink = new LangfuseTraceSink({
      endpoint: "http://langfuse:3000",
      now: () => now,
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return {
          ok: true,
          status: 207,
          async json() {
            return { successes: [], errors: [] };
          },
          async text() {
            return "{}";
          },
        };
      }) as never,
    } as never);
    await sink.export(ctx({ idempotencyKey: key }), [CASE]);
    const batch = bodies[0] as { batch?: Array<{ id: string; body?: { id?: string; traceId?: string } }> };
    return (batch.batch ?? []).flatMap((e) => [e.id, e.body?.id ?? "", e.body?.traceId ?? ""]).filter(Boolean);
  }

  it("mints the same trace and event ids when the same export is retried", async () => {
    const first = await idsFrom("sc-1:pass-1", "2026-08-18T00:00:00.000Z");
    // A later sweep — the clock moved, the export did not.
    const retry = await idsFrom("sc-1:pass-1", "2026-08-18T00:05:00.000Z");
    expect(first.length, "the fixture must produce ids to compare").toBeGreaterThan(0);
    expect(retry).toEqual(first);
  });

  it("mints DIFFERENT ids for a different export, so the sequence is not reused across settlements", async () => {
    // The other half: deterministic per key, not globally. Two settlements of one scorecard must not
    // collapse into each other on the platform.
    const one = await idsFrom("sc-1:pass-1", "2026-08-18T00:00:00.000Z");
    const two = await idsFrom("sc-1:pass-2", "2026-08-18T00:00:00.000Z");
    expect(two).not.toEqual(one);
  });
});
