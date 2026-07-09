import { describe, expect, it } from "vitest";
import { AdaptiveConcurrencyGate } from "./adaptive-concurrency.js";

// A controllable task: park until released, recording the in-flight high-water mark.
function parkedTasks() {
  let inFlight = 0;
  let maxSeen = 0;
  const pending: Array<() => void> = [];
  const task = () => {
    inFlight += 1;
    maxSeen = Math.max(maxSeen, inFlight);
    return new Promise<void>((resolve) =>
      pending.push(() => {
        inFlight -= 1;
        resolve();
      }),
    );
  };
  const releaseOne = (): void => pending.shift()?.();
  const releaseAll = (): void => {
    while (pending.length > 0) releaseOne();
  };
  return {
    task,
    releaseOne,
    releaseAll,
    max: () => maxSeen,
    inFlight: () => inFlight,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("AdaptiveConcurrencyGate", () => {
  it("without a factor the gate caps in-flight at base (inert ceiling)", async () => {
    const gate = new AdaptiveConcurrencyGate({ base: 2 });
    const t = parkedTasks();
    const runs = [1, 2, 3, 4].map(() => gate.run(t.task));
    await flush();
    expect(t.inFlight()).toBe(2);
    t.releaseAll();
    await flush();
    t.releaseAll(); // the two waiters admitted by the first release
    await Promise.all(runs);
    expect(t.max()).toBe(2);
  });

  it("a 0.5 factor halves the effective width and restores it when the pressure clears", async () => {
    let factor = 0.5;
    const transitions: string[] = [];
    const gate = new AdaptiveConcurrencyGate({
      base: 4,
      factor: () => factor,
      onChange: (effective, previous) => transitions.push(`${previous}->${effective}`),
    });
    const t = parkedTasks();
    const runs = [1, 2, 3, 4].map(() => gate.run(t.task));
    await flush();
    expect(t.inFlight()).toBe(2); // 4 × 0.5 — two dispatches parked despite 4 workers

    factor = 1; // pressure cleared — the next release re-samples and admits the parked pair
    t.releaseOne();
    await flush();
    expect(t.inFlight()).toBe(3); // 1 finished + 2 waiters admitted under the restored width of 4
    t.releaseAll();
    await flush();
    t.releaseAll();
    await Promise.all(runs);
    expect(transitions).toContain("2->4"); // the restore transition was observable
  });

  it("factor 0 floors at 1 — a trickle probe, never a full stop", async () => {
    const gate = new AdaptiveConcurrencyGate({ base: 8, factor: () => 0 });
    const t = parkedTasks();
    const runs = [1, 2, 3].map(() => gate.run(t.task));
    await flush();
    expect(t.inFlight()).toBe(1);
    t.releaseOne();
    await flush();
    expect(t.inFlight()).toBe(1); // still serialized
    t.releaseAll();
    await flush();
    t.releaseAll();
    await Promise.all(runs);
    expect(t.max()).toBe(1);
  });

  it("shrinking never cancels in-flight work — excess finishes naturally and is not replaced", async () => {
    let factor = 1;
    const gate = new AdaptiveConcurrencyGate({ base: 3, factor: () => factor });
    const t = parkedTasks();
    const first = [1, 2, 3].map(() => gate.run(t.task));
    await flush();
    expect(t.inFlight()).toBe(3);

    factor = 1 / 3; // shrink to 1 while 3 are in flight
    const late = gate.run(t.task);
    await flush();
    expect(t.inFlight()).toBe(3); // the running trio is untouched; the newcomer parks

    t.releaseOne();
    await flush();
    expect(t.inFlight()).toBe(2); // freed capacity is NOT refilled while over the shrunken width
    t.releaseOne();
    t.releaseOne();
    await flush();
    expect(t.inFlight()).toBe(1); // only now does the parked task run, alone
    t.releaseAll();
    await Promise.all([...first, late]);
  });
});
