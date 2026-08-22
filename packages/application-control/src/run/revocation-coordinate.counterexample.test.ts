import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { RunStore } from "../ports/run-store.js";
import { RunService } from "./run-service.js";

// ── A TEARDOWN THAT REVOKES NOTHING (arch-review 62 P1) ──────────────────────────────────────────────
//
// arch-review 57 P0 added the first arm of `stopRun`: take the RESERVATIONS back before stopping anything,
// because killing what exists cannot stop what has not been created yet. A driver paused mid-dispatch is
// invisible to every probe — its object does not exist — and it would create one the moment it woke, after
// the teardown had verified zero live work and completed.
//
// The arm was written against the wrong coordinate. A standalone run's attempts are opened under the
// EXECUTION id, `evd-run-<record id>`, and the same method computes exactly that one line earlier for its
// handle read:
//
//     const executionId = `evd-run-${rec.id}`;
//     const worksRead = await this.workHandles(executionId);        // ← finds the run's attempts
//     for (const attemptId of await this.revocableAttempts(rec.id)) // ← asks the ledger for "r1"
//
// `attempts.list("r1")` matches no row, so the loop body never runs. The teardown then kills the handles it
// DID find, probes them absent, and certifies zero — with every reservation still spendable. The fix for the
// race and the race are both in this method, four lines apart, and the arm looks present at a glance.
//
// This is the shape rule `protocol` names as a proof with a lifetime: it is not enough for the revocation to
// exist, it has to reach the rows the rest of the operation is talking about. Nothing types a string as "an
// execution id", which is why the coordinate has to be the SAME VALUE rather than the same-looking one.
//
// Seen RED before the coordinate was fixed, observed:
//   a cancellation certified zero with a live reservation still spendable: expected 'reserved' to be 'revoked'

const runningRun = (id: string): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "cc", version: "1.0.0" },
  caseId: "case-1",
  status: "running",
  runtime: "nomad-dev",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
});

function store(records: RunRecord[]): RunStore {
  const rows = new Map(records.map((r) => [r.id, r]));
  return {
    async create(record: RunRecord) {
      rows.set(record.id, record);
    },
    async update(id: string, patch: Partial<RunRecord>) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      return next;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
    },
    async deleteByScorecard() {
      return 0;
    },
    async countActiveByEnvelope() {
      return 0;
    },
    async inFlightByTenant() {
      return {};
    },
    async liveSessions() {
      return [];
    },
  };
}

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("not under test");
  },
};

describe("[R62 COUNTEREXAMPLE] a standalone cancellation takes back the reservations it is about", () => {
  // The world a paused submitter leaves behind: an attempt row opened under the execution id, holding a
  // reservation for an object it has not created yet.
  const paused = async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: "evd-run-r1", tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-c1-aaaa" });
    return { attempts, attemptId };
  };

  it("REVOKES the reservation of an attempt that has not created its object", async () => {
    const { attempts, attemptId } = await paused();
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: store([runningRun("r1")]),
      attempts,
      killWork: async () => ({ status: "absent" as const }),
    });

    await service.cancel({ tenant: "acme", id: "r1" });

    const [row] = await attempts.list("evd-run-r1");
    expect(row?.state, "a cancellation certified zero with a live reservation still spendable").toBe("revoked");
  });

  it("still reaches the attempt when the ledger is asked for the run's OWN handles", async () => {
    // The control that makes the assertion above non-vacuous: if the fixture opened its attempt under a
    // coordinate nothing uses, both the broken and the fixed code would find nothing and this file would be
    // green over the defect. The handles the teardown kills come from the same list.
    const { attempts } = await paused();
    const rows = await attempts.list("evd-run-r1");
    expect(rows, "the fixture recorded no attempt, so every assertion here is vacuous").toHaveLength(1);
    expect(rows[0]?.runtimeWork?.externalJobId).toBe("everdict-c1-aaaa");
  });

  it("leaves a SETTLED attempt alone", async () => {
    // Revocation is for reservations somebody may still spend. An attempt that already committed is history,
    // and rewriting it would make the ledger disagree with the evidence it settled.
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: "evd-run-r2", tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r2", externalJobId: "everdict-c2-bbbb" });
    await attempts.transition(attemptId, "committed");

    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: store([runningRun("r2")]),
      attempts,
      killWork: async () => ({ status: "absent" as const }),
    });
    await service.cancel({ tenant: "acme", id: "r2" });

    const [row] = await attempts.list("evd-run-r2");
    expect(row?.state).toBe("committed");
  });
});
