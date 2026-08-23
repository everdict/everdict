import { InMemoryExecutionAttemptStore } from "@everdict/application-control";
import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRunStore } from "./run-store.js";

// ── A SETTLEMENT CANNOT CLOSE THE DOOR ITS OWN STAMP WALKS THROUGH (arch-review 63 P1-high) ─────────
//
// Two changes, each correct, each with its own counterexample, each shipped green:
//
//   arch-review 62  `committed` requires the parent to be OPEN — a verdict may not claim a settlement that
//                   already closed without it.
//   arch-review 62  the recovery stamps `committed` AFTER the settle — the attempt must not claim an answer
//                   the run has not recorded.
//
// A successful settle makes the run terminal. So the stamp runs at the one moment the parent is guaranteed
// closed, is refused every single time, and every successful recovery leaves its attempt `reserved` — the
// exact defect arch-review 61 P2-audit closed. Neither change is wrong; their composition is.
//
// `settleWith` exists precisely so the two writes are ONE decision (arch-review 45), and it did not help:
// both twins ran `update` first and `stamp.apply` second, so inside the transaction the parent was already
// terminal when the guard read it. Being atomic is not the same as being ordered.
//
// The stamp goes FIRST. The guard's question — "may this attempt still claim an answer?" — has an answer
// while the settlement is in flight and none after it lands, and a refused settle rolls the stamp back with
// it where the store has a transaction to roll back.
//
// Seen RED before the order was fixed, observed:
//   a successful settlement left its attempt open: expected 'reserved' to be 'committed'

const RUN = (id: string): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "cc", version: "1" },
  caseId: "c1",
  status: "running",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
});

describe("[R63 COUNTEREXAMPLE] a settlement stamps the attempt that produced it", () => {
  // The REAL stores on both sides — the defect is a disagreement between two real guards, and a double that
  // answers `true` to every transition is exactly what hid it (rule `testing`).
  const world = async (runId: string) => {
    const runs = new InMemoryRunStore();
    await runs.create(RUN(runId));
    const attempts = new InMemoryExecutionAttemptStore(undefined, {
      // The parent authority the ledger consults: open while the run is, closed once it settles — which is
      // what the real Postgres predicate reads off `everdict_runs.status`.
      authorityOf: async () => {
        const row = await runs.get(runId);
        return row !== undefined && (row.status === "queued" || row.status === "running") ? { epoch: 1 } : undefined;
      },
    });
    const { attemptId } = await attempts.open({ executionId: `evd-run-${runId}`, tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: `evd-run-${runId}`, externalJobId: "j-1" });
    return { runs, attempts, attemptId };
  };

  it("leaves the attempt COMMITTED after a successful settle", async () => {
    const { runs, attempts, attemptId } = await world("r1");

    const settled = await runs.settleWith(
      "r1",
      { status: "succeeded", updatedAt: "2026-08-23T00:00:01.000Z" },
      undefined,
      { expectNonTerminal: true },
      { attempts, attemptId, apply: async (ledger) => void (await ledger.transition(attemptId, "committed")) },
    );

    expect(settled?.status, "the settlement itself did not land, so this test measured nothing").toBe("succeeded");
    const [row] = await attempts.list("evd-run-r1");
    expect(row?.state, "a successful settlement left its attempt open").toBe("committed");
  });

  it("does NOT stamp when the settlement was refused", async () => {
    // A fence that refuses means somebody else settled this run, so this attempt did not produce the answer
    // and must not say it did.
    const { runs, attempts, attemptId } = await world("r2");
    await runs.update("r2", { status: "succeeded", updatedAt: "2026-08-23T00:00:01.000Z" }, undefined, {
      expectNonTerminal: true,
    });

    const settled = await runs.settleWith(
      "r2",
      { status: "failed", updatedAt: "2026-08-23T00:00:02.000Z" },
      undefined,
      { expectNonTerminal: true },
      { attempts, attemptId, apply: async (ledger) => void (await ledger.transition(attemptId, "committed")) },
    );

    expect(settled, "the terminal write was not refused, so the assertion below is vacuous").toBeUndefined();
    const [row] = await attempts.list("evd-run-r2");
    expect(row?.state, "a losing settlement stamped its attempt anyway").not.toBe("committed");
  });

  it("still refuses `committed` for an attempt whose parent settled WITHOUT it", async () => {
    // The guard arch-review 62 added, unchanged: this is the case it exists for — a verdict arriving after
    // the settlement closed, outside any settlement of its own.
    const { runs, attempts, attemptId } = await world("r3");
    await runs.update("r3", { status: "succeeded", updatedAt: "2026-08-23T00:00:01.000Z" }, undefined, {
      expectNonTerminal: true,
    });

    expect(
      await attempts.transition(attemptId, "committed"),
      "an attempt claimed the answer of a settlement that closed without it",
    ).toBe(false);
  });
});
