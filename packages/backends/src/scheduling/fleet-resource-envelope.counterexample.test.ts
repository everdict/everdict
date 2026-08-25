import { describe, expect, it } from "vitest";
import type { BackendCapacity } from "../backend.js";
import { backendSlotOf, effectiveResource, slotAdmits } from "./scheduler.js";

// ── THE MEMORY ENVELOPE WAS ONE REPLICA'S OPINION (arch-review 67 known-limit → 68) ─────────────────
//
// Three axes bound a backend, and until now they were bounded three different ways:
//
//   TENANT CONCURRENCY  fleet-wide and hard — an atomic per-tenant permit
//   SLOTS               fleet-wide by OBSERVATION — `used` is the orchestrator's own count
//   MEMORY and CPU      PER PROCESS ONLY — declared envelopes with nothing observing allocation
//
// So two replicas holding a 4 GiB runtime budget could each locally reserve 3 GiB and neither saw the other:
// 6 GiB admitted against a 4 GiB envelope. The contract said so rather than implying the stronger property,
// which was the right thing to do while it was true — and it is the thing this closes.
//
// The fix is deliberately NOT a second mechanism: slots already solve this with a probe, so memory and CPU
// get the same probe and `effectiveResource` folds all three by one rule. Both managed lanes report it from
// a call they were already making (K8s reads the requests off the Job specs it lists; Nomad sums the
// cluster's own `AllocatedResources`).
//
// Seen RED before the observed reading was folded, observed:
//   a second replica admitted against an envelope the first had already spent: expected true to be false

const budgeted = (over: Partial<BackendCapacity> = {}): BackendCapacity => ({
  total: 10,
  used: 0,
  memoryBudgetMb: 4096,
  cpuBudget: 4000,
  ...over,
});

describe("[R68 COUNTEREXAMPLE] the memory and CPU envelopes are bounded across replicas", () => {
  it("REFUSES a unit another replica's allocation has already spent the room on", async () => {
    // Replica A placed 3 GiB. Replica B has none of it in its own accounting — its whole knowledge of that
    // placement is the probe.
    const cap = budgeted({ usedMemoryMb: 3072, usedCpu: 3000 });
    const slot = backendSlotOf("nomad", cap, { slots: 0, memoryMb: 0, cpu: 0 });

    expect(slot.memFreeMb, "replica B saw the whole envelope as free").toBe(1024);
    expect(
      slotAdmits(slot, { memoryMb: 3072 }),
      "a second replica admitted against an envelope the first had already spent",
    ).toBe(false);
    // …and something that genuinely fits still gets in: fail-closed must not mean fail-always.
    expect(slotAdmits(slot, { memoryMb: 512, cpu: 500 })).toBe(true);
  });

  it("does NOT double-count this replica's own in-flight against the probe that already saw it", async () => {
    // The `max` rule, and the reason it is `max` rather than a sum: the probe may already include our own
    // placements (then summing starves us permanently) or lag them (then max keeps our own number). Slots
    // learned this; this axis inherits the lesson rather than re-deriving it.
    const cap = budgeted({ usedMemoryMb: 3072 });
    const bothCount = backendSlotOf("nomad", cap, { slots: 0, memoryMb: 3072, cpu: 0 });

    expect(bothCount.memFreeMb, "the probe reading and our own accounting were added together").toBe(1024);
  });

  it("spends the WHOLE budget when the probe could not tell", async () => {
    // Fail-closed, exactly as the slot count is. This is the case that cost the most before it was fixed for
    // slots: during an API-server outage `?? 0` had every replica computing free capacity against an empty
    // cluster and admitting at full width for as long as the outage lasted.
    const cap = budgeted({ usedMemoryMb: "unknown", usedCpu: "unknown" });
    const slot = backendSlotOf("k8s", cap, { slots: 0, memoryMb: 0, cpu: 0 });

    expect(slot.memFreeMb, "an unverifiable reading was spent as free room").toBe(0);
    expect(slot.cpuFree).toBe(0);
    expect(slotAdmits(slot, { memoryMb: 1 }), "a replica admitted against a bound it could not verify").toBe(false);
  });

  it("keeps the PROCESS-LOCAL behaviour for a lane with no probe for this axis", async () => {
    // The control that keeps this from being a silent upgrade. A lane that reports nothing must not start
    // claiming a fleet-wide bound it cannot observe — it keeps exactly what it had, and the contract says
    // which lanes have which.
    const cap = budgeted();
    const slot = backendSlotOf("local", cap, { slots: 0, memoryMb: 1024, cpu: 1000 });

    expect(slot.memFreeMb, "a lane with no probe was folded as though it had reported zero usage").toBe(3072);
    expect(slot.cpuFree).toBe(3000);
  });

  it("folds all three readings by one rule", () => {
    // The rule itself, stated once so a fourth axis joins here rather than inventing a fourth answer.
    expect(effectiveResource(4096, undefined, 1024), "no probe → our own accounting").toBe(1024);
    expect(effectiveResource(4096, "unknown", 1024), "unverifiable → the whole budget").toBe(4096);
    expect(effectiveResource(4096, 3072, 1024), "observed → the larger of the two").toBe(3072);
    expect(effectiveResource(4096, 512, 1024), "…including when ours is larger, which is probe lag").toBe(1024);
  });

  it("leaves an undeclared envelope unbounded, and an undeclared need unrefused", () => {
    // Resource-aware admission is opt-in at BOTH ends: a backend that declares no envelope is not bounded by
    // one, and a unit that declares no resources is not refused by an envelope it never entered.
    const slot = backendSlotOf("nomad", { total: 10, used: 0, usedMemoryMb: 9999 }, { slots: 0, memoryMb: 0, cpu: 0 });
    expect(slot.memFreeMb).toBe(Number.POSITIVE_INFINITY);
    expect(slotAdmits(slot, {}), "a unit declaring nothing was refused by an envelope it never entered").toBe(true);
  });
});
