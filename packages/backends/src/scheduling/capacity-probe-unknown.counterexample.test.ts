import { describe, expect, it } from "vitest";
import type { BackendCapacity } from "../backend.js";
import { K8sBackend } from "../orchestrators/k8s.js";
import { NomadBackend } from "../orchestrators/nomad.js";
import { backendSlotOf, effectiveUsed, slotAdmits } from "./scheduler.js";

// ── A CAPACITY PROBE THAT FAILED REPORTED AN EMPTY CLUSTER (arch-review 63, the fleet-permit assessment) ─
//
// The tenant quota is bounded fleet-wide by an atomic permit. Nothing else is: the backend's slot, memory and
// CPU envelopes are per-PROCESS accounting, and what keeps N replicas from each admitting a full `total` is
// the ONE number they all read — `BackendCapacity.used`, the orchestrator's own count of what is running.
//
// Both managed lanes reported a failed probe as zero:
//
//     k8s    const used = await this.withApi((api) => api.activeUsage());   // undefined = could not tell
//            return { total, used: used ?? 0 };
//
//     nomad  } catch {
//              // probe failed → used 0
//            }
//
// `activeUsage` already answered `undefined` for "could not find out" and the `??` threw that answer
// away. So during an orchestrator API outage every replica computes `free = total − max(0, its own few)` and
// keeps admitting at full width — N × total, continuously, at precisely the moment the cluster is least able
// to take it. This is rule `protocol` L2 in the one place the fleet bound rests on, and the failure is not
// the transient over-admission the `used` contract already discloses: that one self-corrects on the next
// probe, and this one persists for as long as the outage does.
//
// `used` is a union now, and the two lanes say which they mean. Fail-closed: an unverifiable reading yields
// no free slots, so the queue holds the work — which is the right answer anyway, since a dispatch to an
// unreachable API server was going to fail.
//
// Seen RED with `effectiveUsed` folding `unknown` back to 0 the way both lanes did, observed:
//   an unverifiable probe was read as an empty cluster: expected 3 to be +0
//
// …and RED at the LANES with their `?? 0` / `catch → 0` restored, observed:
//   the K8s lane reported an uncountable cluster as idle: expected +0 to be 'unknown'
//   the Nomad lane reported an unreachable cluster as idle: expected +0 to be 'unknown'
//   a 5xx from the job listing was read as an empty cluster: expected +0 to be 'unknown'
//
// Both halves are here on purpose. A union nothing produces is a type; the lanes are what make it a protocol,
// and "the refusal is implemented and the producer is three frames away" is how this repo has lost a feature
// end to end before (rule `protocol`, the comment-is-a-claim law).

const cap = (used: BackendCapacity["used"]): BackendCapacity => ({ total: 4, used, memoryBudgetMb: 8192 });

describe("[R63 COUNTEREXAMPLE] a probe that could not count is not a probe that counted zero", () => {
  it("REFUSES placement when the orchestrator could not be counted", async () => {
    // What one replica holds locally is beside the point: the question is what the OTHER replicas hold, and
    // an unverifiable probe is the answer "nobody knows".
    const slot = backendSlotOf("k8s-prod", cap("unknown"), {
      slots: effectiveUsed(cap("unknown"), 1, "max"),
      memoryMb: 512,
      cpu: 0,
    });
    expect(slot.free, "an unverifiable probe was read as an empty cluster").toBe(0);
    expect(slotAdmits(slot, { memoryMb: 512 })).toBe(false);
  });

  it("still admits on a REAL zero", async () => {
    // The control that keeps the change from being "refuse everything". A cluster the probe genuinely read as
    // empty is empty, and an eval platform that cannot place work on an idle cluster is worse than the leak.
    const slot = backendSlotOf("k8s-prod", cap(0), {
      slots: effectiveUsed(cap(0), 0, "max"),
      memoryMb: 0,
      cpu: 0,
    });
    expect(slot.free).toBe(4);
    expect(slotAdmits(slot, { memoryMb: 512 })).toBe(true);
  });

  it("keeps both lanes' combination rules over a real reading", async () => {
    // The Scheduler MAXes (it pumps against a probe that catches up, so summing would starve it); the
    // verifier lane SUMS (no pump, and the window it counts is the one before a placement is visible). The
    // union must not quietly collapse either one — a single rule here would make the primitive wrong for one
    // of the two lanes.
    expect(effectiveUsed(cap(3), 1, "max")).toBe(3);
    expect(effectiveUsed(cap(3), 1, "sum")).toBe(4);
  });

  it("the K8s lane SAYS it could not count", async () => {
    // `activeUsage` has always answered `undefined` for "the query itself failed"; the lane threw that
    // answer away with `?? 0`. This is the producer half — without it the union above is a type nothing emits.
    const api = { activeUsage: async () => undefined } as unknown as ConstructorParameters<typeof K8sBackend>[0]["api"];
    const cap = await new K8sBackend({ image: "runner:1", api, maxConcurrent: 4 } as never).capacity();
    expect(cap.used, "the K8s lane reported an uncountable cluster as idle").toBe("unknown");
  });

  it("the K8s lane still reports a REAL count", async () => {
    const api = { activeUsage: async () => ({ jobs: 2, memoryMb: 0, cpu: 0 }) } as unknown as ConstructorParameters<
      typeof K8sBackend
    >[0]["api"];
    const cap = await new K8sBackend({ image: "runner:1", api, maxConcurrent: 4 } as never).capacity();
    expect(cap.used).toBe(2);
  });

  it("the Nomad lane SAYS it could not reach the cluster", async () => {
    const http = {
      request: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    const cap = await new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never).capacity();
    expect(cap.used, "the Nomad lane reported an unreachable cluster as idle").toBe("unknown");
  });

  it("the Nomad lane treats a non-2xx the same way", async () => {
    // The half the `catch` never covered: a 500 answered, so nothing threw, and the fallthrough returned 0.
    const http = { request: async () => ({ status: 500, text: "nomad is not happy" }) };
    const cap = await new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never).capacity();
    expect(cap.used, "a 5xx from the job listing was read as an empty cluster").toBe("unknown");
  });

  it("the Nomad lane still reports a REAL count", async () => {
    const http = {
      request: async () => ({ status: 200, text: JSON.stringify([{ Status: "running" }, { Status: "dead" }]) }),
    };
    const cap = await new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never).capacity();
    expect(cap.used).toBe(1);
  });

  it("is unknown under BOTH combination rules", async () => {
    // …and neither rule may turn "nobody knows" back into a number. `sum` was the shape most likely to do it
    // by accident: `unknown + held` is the arithmetic that reads as `0 + held` in a language with `??`.
    expect(effectiveUsed(cap("unknown"), 1, "max")).toBe(4);
    expect(effectiveUsed(cap("unknown"), 1, "sum")).toBe(4);
  });
});
