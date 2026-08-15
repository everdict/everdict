import { InternalError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { RecordingStore } from "../ports/recording-store.js";
import { openPhysicalAttempt } from "./open-physical-attempt.js";

// A recording store that records what it was asked for and answers as told — only `open` matters here.
function recordings(open: (runId: string, generation?: number) => Promise<number>): {
  store: RecordingStore;
  calls: Array<{ runId: string; generation?: number }>;
} {
  const calls: Array<{ runId: string; generation?: number }> = [];
  const store: RecordingStore = {
    async open(runId, generation) {
      calls.push({ runId, ...(generation !== undefined ? { generation } : {}) });
      return open(runId, generation);
    },
    async append() {},
    async seal() {
      return undefined;
    },
    async get() {
      return undefined;
    },
    async peek() {
      return undefined;
    },
  };
  return { store, calls };
}

describe("openPhysicalAttempt — the one verb for 'a physical execution begins'", () => {
  it("the LEDGER mints the ordinal and the recording store CLAIMS it — never two MAX+1 opinions", async () => {
    // Given both stores wired, and a recording store that agrees with whatever coordinate it is handed
    const attempts = new InMemoryExecutionAttemptStore();
    const { store, calls } = recordings(async (_runId, generation) => generation ?? 99);

    // When two attempts of one execution open
    const first = await openPhysicalAttempt(
      { attempts, recordings: store },
      { executionId: "evd-run-1", tenant: "acme" },
    );
    const second = await openPhysicalAttempt(
      { attempts, recordings: store },
      { executionId: "evd-run-1", tenant: "acme" },
    );

    // Then the recording store was TOLD the coordinate rather than asked for one, and the two planes agree
    // by construction instead of by both happening to count the same rows.
    expect(calls).toEqual([
      { runId: "evd-run-1", generation: 1 },
      { runId: "evd-run-1", generation: 2 },
    ]);
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect(second.attemptId).toBe("evd-run-1#g2");
    expect(first.unisolated).toBe(false);
  });

  it("a refused recording claim STRIPS the generation but KEEPS the attempt row (fail-closed, now recorded)", async () => {
    // Given a recording store whose claim fails — the fence we could not raise
    const attempts = new InMemoryExecutionAttemptStore();
    const { store } = recordings(async () => {
      throw new InternalError("UPSTREAM_ERROR", {}, "recording table unavailable");
    });

    // When an attempt opens
    const opened = await openPhysicalAttempt(
      { attempts, recordings: store },
      { executionId: "evd-run-2", tenant: "acme" },
    );

    // Then the JOB carries no generation — byte-compatible with the pre-ledger behaviour: producers stamp 0,
    // the recording fence refuses them, and the case runs knowing its replay is not canonical…
    expect(opened.generation).toBeUndefined();
    expect(opened.unisolated).toBe(true);
    // …while the LEDGER still holds the attempt, marked unisolated. This is the whole point: an execution
    // whose fence could not be raised used to leave no trace anywhere at all.
    expect(opened.attemptId).toBe("evd-run-2#g1");
    expect((await attempts.list("evd-run-2"))[0]).toMatchObject({ generation: 1, unisolated: true, state: "created" });
  });

  it("with no ledger wired the recording store self-mints, exactly as before", async () => {
    // Given only a recording store
    const { store, calls } = recordings(async () => 4);

    const opened = await openPhysicalAttempt({ recordings: store }, { executionId: "evd-run-3", tenant: "acme" });

    // Then it was asked for a coordinate (no generation argument) and no attempt id exists to report.
    expect(calls).toEqual([{ runId: "evd-run-3" }]);
    expect(opened).toEqual({ generation: 4, unisolated: false });
  });

  it("a ledger fault NEVER falls back to the recording self-mint — the attempt runs unfenced (arch-review 47 P0-4)", async () => {
    // Given a wired ledger that cannot take the write. Pre-fix this degraded to the recording store's own
    // MAX+1 — re-activating the two-authority split: attempt A holds g1 on the ledger (recording claim had
    // failed), the outage lets attempt B self-mint g1 again, and B's evidence then NAMES A's identity.
    const attempts = new InMemoryExecutionAttemptStore();
    attempts.open = async () => {
      throw new InternalError("UPSTREAM_ERROR", {}, "attempt table unavailable");
    };
    const { store, calls } = recordings(async () => 7);

    const opened = await openPhysicalAttempt(
      { attempts, recordings: store },
      { executionId: "evd-run-4", tenant: "acme" },
    );

    // The recording store was never asked — no coordinate exists that another authority might own.
    expect(calls).toEqual([]);
    expect(opened).toEqual({ unisolated: true });
  });

  it("with neither store wired nothing is opened and nothing is unisolated", async () => {
    expect(await openPhysicalAttempt({}, { executionId: "evd-run-5", tenant: "acme" })).toEqual({ unisolated: false });
  });
});
