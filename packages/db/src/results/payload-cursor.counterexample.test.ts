import { describe, expect, it } from "vitest";
import { InMemoryTrajectoryStore } from "./trajectory-store.js";

// ── ONE REF, TWO OWNERS, AND A PAGE BOUNDARY BETWEEN THEM (arch-review 124) ──────────────────────────
//
// A payload-ref row's identity is `(ref, tenant, runId)`, not the ref: `SELECT DISTINCT` legitimately
// returns one ref under two owners, because `TraceEvent` is the schema a producer's submission is validated
// by and a producer can quote another run's ref inside its own trace. Both rows are real, and only the one
// whose key namespace matches owns the object.
//
// The cursor was the REF alone (`WHERE ref > $after`). A page ending inside such a group therefore skipped
// every remaining owner of that ref — and the sweep deletes objects for the rows it SAW, then deletes every
// expired row. So an object whose only surviving owner row was skipped is named by nothing afterwards:
// the exact `limit + 1` leak the drain was written to close, arriving through the tie instead of the count.
//
// The twin is the subject because it pages the way the adapters do; the SQL forms are certified by
// TRUST-190 against a real engine.
const BIG = "x".repeat(200_000);

const ref = (n: string) => `artifact://trajectory-payloads/acme/run-${n}/run/sha256:${n.padStart(64, "0")}.outputRef`;

describe("the payload-ref cursor pages on the whole row", () => {
  // Three runs quote ONE ref, plus a run with its own. Ordered by ref, the shared one is a group of three
  // that a two-row page must not lose the tail of.
  async function seeded(): Promise<InMemoryTrajectoryStore> {
    const store = new InMemoryTrajectoryStore();
    const shared = ref("a");
    for (const runId of ["run-1", "run-2", "run-3"])
      await store.seal({
        runId,
        tenant: "acme",
        source: "run",
        events: [{ t: 0, kind: "tool_result", id: "c1", ok: true, output: BIG, outputRef: shared } as never],
      });
    await store.seal({
      runId: "run-4",
      tenant: "acme",
      source: "run",
      events: [{ t: 0, kind: "tool_result", id: "c1", ok: true, output: BIG, outputRef: ref("b") } as never],
    });
    return store;
  }

  it("drains every owner of a shared ref across page boundaries", async () => {
    const store = await seeded();
    const cutoff = "2999-01-01T00:00:00.000Z";

    const seen: string[] = [];
    let after = undefined as Awaited<ReturnType<InMemoryTrajectoryStore["payloadRefsOlderThan"]>>[number] | undefined;
    for (;;) {
      const page = await store.payloadRefsOlderThan(cutoff, 2, after);
      if (page.length === 0) break;
      for (const row of page) seen.push(`${row.ref}|${row.runId}`);
      if (page.length < 2) break;
      after = page[page.length - 1];
    }

    // The premise: the seed really does share one ref across three runs, or this proves nothing.
    const all = await store.payloadRefsOlderThan(cutoff, 5_000);
    expect(all.filter((r) => r.ref === ref("a"))).toHaveLength(3);
    // …and paging two at a time reached every one of them.
    expect(new Set(seen).size).toBe(all.length);
    for (const row of all) expect(seen).toContain(`${row.ref}|${row.runId}`);
  });

  it("returns the same set whether it is read whole or paged", async () => {
    const store = await seeded();
    const cutoff = "2999-01-01T00:00:00.000Z";
    const whole = (await store.payloadRefsOlderThan(cutoff, 5_000)).map((r) => `${r.ref}|${r.runId}`).sort();

    const paged: string[] = [];
    let after = undefined as Awaited<ReturnType<InMemoryTrajectoryStore["payloadRefsOlderThan"]>>[number] | undefined;
    for (;;) {
      const page = await store.payloadRefsOlderThan(cutoff, 1, after);
      if (page.length === 0) break;
      const row = page[0];
      if (!row) break;
      paged.push(`${row.ref}|${row.runId}`);
      after = row;
    }
    expect(paged.sort()).toEqual(whole);
  });
});
