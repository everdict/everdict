import { describe, expect, it } from "vitest";
import type { BackendCapacity } from "../backend.js";
import { Admission, backendSlotOf, effectiveUsed, slotAdmits } from "./scheduler.js";

// ── WHICH AXIS IS BOUNDED WHERE (arch-review 64 P1) ─────────────────────────────────────────────────
//
// arch-review 63 unified the Scheduler's and the verifier lane's accounting onto one `Admission`, which
// closed the SAME-PROCESS double-spend. This file pins what that did and did not buy, because the difference
// is not visible from either object:
//
//   tenant concurrency  fleet-wide and HARD — `AdmissionLedger.tryAdmit`, an atomic permit
//   backend slots       bounded across replicas by OBSERVATION — `used` is the orchestrator's own count
//   memory and CPU      bounded PER PROCESS ONLY — declared envelopes, no probe, local accounting
//
// The last line is the finding, and it has no smaller fix: slots have a probe that eventually sees another
// replica's placement, and memory has none at all. Two replicas with a 4 GiB runtime budget each locally
// reserve 3 GiB and neither can see the other.
//
// This is a CHARACTERIZATION test, deliberately. It does not assert the gap is acceptable; it asserts the
// bound is exactly as wide as it is, so a later change that claims the envelope is fleet-wide has to come
// here and say so — which is the thing that did not happen when `used` quietly became `?? 0`.

const cap = (): BackendCapacity => ({ total: 8, used: 0, memoryBudgetMb: 4096, cpuBudget: 4000 });

// One replica's view: the shared probe reading, plus what THIS process holds.
const slotFor = (admission: Admission, name: string) =>
  backendSlotOf(name, cap(), {
    slots: effectiveUsed(cap(), admission.countFor(name), "max"),
    memoryMb: admission.memMbFor(name),
    cpu: admission.cpuFor(name),
  });

describe("[R64 CHARACTERIZATION] the memory envelope is a per-process bound, and says so", () => {
  it("REFUSES a second reservation that would overrun the envelope in ONE process", async () => {
    // What the shared `Admission` does buy: the Scheduler and the verifier lane cannot spend one envelope
    // twice inside a replica. This is the half arch-review 63 closed.
    const admission = new Admission();
    admission.reserve("rt-a", "acme", 3072, 0, "h@1");

    expect(
      slotAdmits(slotFor(admission, "rt-a"), { memoryMb: 3072 }),
      "one process admitted 6 GiB against a 4 GiB envelope",
    ).toBe(false);
  });

  it("does NOT see another replica's reservation — the bound this does not have", async () => {
    // Two processes, two `Admission` objects, one runtime budget. Replica B admits because nothing tells it
    // what A is holding: `memoryBudgetMb` is DECLARED config and `capacity()` reports no observed memory, so
    // there is no probe for `effectiveUsed` to fold the way it folds slots.
    //
    // Pinned rather than papered over. When a memory probe or a durable per-backend permit lands, this
    // expectation flips — and whoever flips it has to state the mechanism, which is the point.
    const replicaA = new Admission();
    replicaA.reserve("rt-a", "acme", 3072, 0, "h@1");
    const replicaB = new Admission();

    expect(
      slotAdmits(slotFor(replicaB, "rt-a"), { memoryMb: 3072 }),
      "the memory envelope became fleet-wide without anything to observe it — update the contract on BackendCapacity",
    ).toBe(true);
  });

  it("SLOTS do cross replicas, once the cluster can see the placement", async () => {
    // The contrast that makes the gap legible: slots have an observation channel. A placement another replica
    // made shows up in `used`, and the local accounting is maxed against it rather than added.
    const observed: BackendCapacity = { ...cap(), used: 8 };
    const slot = backendSlotOf("rt-a", observed, {
      slots: effectiveUsed(observed, 0, "max"),
      memoryMb: 0,
      cpu: 0,
    });
    expect(slot.free, "an occupied cluster was read as free by a replica that placed nothing").toBe(0);
  });
});
