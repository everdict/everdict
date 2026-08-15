import { attemptIdOf } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "./execution-attempt-store.js";

describe("InMemoryExecutionAttemptStore — the physical execution ledger", () => {
  it("mints a fresh ordinal per execution, starting at 1", async () => {
    // Given a ledger
    const store = new InMemoryExecutionAttemptStore();

    // When three attempts of one execution open, and one of a different execution
    const first = await store.open({ executionId: "evd-sc1-c1", tenant: "acme" });
    const second = await store.open({ executionId: "evd-sc1-c1", tenant: "acme" });
    const third = await store.open({ executionId: "evd-sc1-c1", tenant: "acme" });
    const other = await store.open({ executionId: "evd-sc1-c2", tenant: "acme" });

    // Then the ordinal counts per execution and starts at 1 — generation 0 is what a producer that was never
    // told a number stamps, and it must never be a real attempt's coordinate.
    expect([first.generation, second.generation, third.generation]).toEqual([1, 2, 3]);
    expect(other.generation).toBe(1);
    // …and the id is the one spelling every other ledger uses.
    expect(second.attemptId).toBe(attemptIdOf("evd-sc1-c1", 2));
    expect((await store.list("evd-sc1-c1")).map((a) => a.generation)).toEqual([1, 2, 3]);
  });

  it("records the attempt as `created` with the coordinate its opener knew", async () => {
    // Given an attempt opened with a batch coordinate
    const store = new InMemoryExecutionAttemptStore();
    const { attemptId } = await store.open({
      executionId: "evd-sc1-c1-t2",
      tenant: "acme",
      scorecardId: "sc1",
      caseId: "c1",
      trial: 2,
      driverEpoch: 7,
    });

    // Then the row exists before anything has executed — an attempt is recorded because it BEGAN, not
    // because it produced evidence.
    const [row] = await store.listForScorecard("sc1");
    expect(row).toMatchObject({
      attemptId,
      state: "created",
      caseId: "c1",
      trial: 2,
      driverEpoch: 7,
      unisolated: false,
    });
  });

  it("FIRST TERMINAL WINS — a second terminal transition is a silent no-op", async () => {
    // Given a committed attempt
    const store = new InMemoryExecutionAttemptStore();
    const { attemptId } = await store.open({ executionId: "evd-sc1-c1", tenant: "acme" });
    expect(await store.transition(attemptId, "committed", { childRunId: "run-1" })).toBe(true);

    // When a late supersede (or a late failure report) arrives for the same attempt
    const superseded = await store.transition(attemptId, "superseded");
    const failed = await store.transition(attemptId, "failed", { error: { code: "INTERNAL", message: "late" } });

    // Then both are refused, and the row still says what the winning transition said. A ledger whose terminal
    // state can be rewritten afterwards answers "which row was touched last", not "how did this attempt end".
    expect(superseded).toBe(false);
    expect(failed).toBe(false);
    const [row] = await store.list("evd-sc1-c1");
    expect(row?.state).toBe("committed");
    expect(row?.childRunId).toBe("run-1");
    expect(row?.error).toBeUndefined();
  });

  it("`executing` is reachable only from `created` — an attempt cannot start twice, or after it has ended", async () => {
    // Given an attempt that has already started
    const store = new InMemoryExecutionAttemptStore();
    const { attemptId } = await store.open({ executionId: "evd-run-0", tenant: "acme" });
    expect(await store.transition(attemptId, "executing")).toBe(true);

    // When a second "compute started" report arrives (the self-hosted lane's reports are fire-and-forget, so
    // a duplicate is ordinary rather than exceptional)
    // Then it is refused: the attempt is past `created`, and `executing` is not a state to re-enter.
    expect(await store.transition(attemptId, "executing")).toBe(false);

    // …and the same holds once the attempt has ENDED — a late start report must not rewind a settled row.
    const ended = await store.open({ executionId: "evd-run-1", tenant: "acme" });
    await store.transition(ended.attemptId, "superseded");
    expect(await store.transition(ended.attemptId, "executing")).toBe(false);
    expect((await store.list("evd-run-1"))[0]?.state).toBe("superseded");
  });

  it("an attempt executes, then commits — the ordinary life of a row", async () => {
    const store = new InMemoryExecutionAttemptStore();
    const { attemptId } = await store.open({ executionId: "evd-run-2", tenant: "acme" });

    expect(await store.transition(attemptId, "executing", { childRunId: "run-2" })).toBe(true);
    expect(await store.transition(attemptId, "committed")).toBe(true);
    const [row] = await store.list("evd-run-2");
    expect(row?.state).toBe("committed");
    expect(row?.childRunId).toBe("run-2"); // the patch from the earlier transition survives
  });

  it("markUnisolated is not a transition — the attempt goes on to commit from wherever it was", async () => {
    // Given an attempt whose recording coordinate could not be claimed
    const store = new InMemoryExecutionAttemptStore();
    const { attemptId } = await store.open({ executionId: "evd-run-3", tenant: "acme" });
    await store.markUnisolated(attemptId);

    // Then the attempt is still `created` — "no fence was raised" says nothing about where in its life the
    // attempt is — and it commits normally, carrying the flag onto its terminal row.
    expect((await store.list("evd-run-3"))[0]).toMatchObject({ state: "created", unisolated: true });
    expect(await store.transition(attemptId, "committed")).toBe(true);
    expect((await store.list("evd-run-3"))[0]).toMatchObject({ state: "committed", unisolated: true });
  });

  it("a transition against an attempt nobody opened is refused, never invented", async () => {
    const store = new InMemoryExecutionAttemptStore();
    expect(await store.transition(attemptIdOf("evd-run-9", 1), "committed")).toBe(false);
    expect(await store.list("evd-run-9")).toEqual([]);
  });
});
