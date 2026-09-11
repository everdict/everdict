import type { RunRecord, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRunStore } from "./run-store.js";
import { InMemoryScorecardStore } from "./scorecard-store.js";

// ── [pnpm scan · adapters · 2026-09-11] THE TWIN ADMITTED WHAT POSTGRES REFUSES ─────────────────────
//
// `parentAdmitsWork` asked only for the parent's STATUS, and `InMemoryScorecardStore.peek` returns
// `undefined` both for a scorecard that is not there and for one whose status is unset. The function read
// that single `undefined` as "no constraint", so a run naming a parent this store does not have was
// admitted — while `PgExecutionAttemptStore`'s `PARENT_AUTHORIZES` opens with
// `EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.id = a.scorecard_id …)` and refuses it.
//
// That is the divergence rule `testing` names: a guard the in-memory twin does not have is a guard no unit
// test can see, and the twin was the more permissive of the two on an AUTHORIZATION axis. `peek`'s epoch
// accessor defaults an absent row to 0, so a dispatch claiming epoch 0 walked straight through.
//
// Seen red under neutralization: "promise resolved \"undefined\" instead of rejecting" — the dispatch the
// Postgres twin would have refused, going through.
const scorecard = (over: Partial<ScorecardRecord> = {}) =>
  ({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "running",
    ownerEpoch: 0,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...over,
  }) as unknown as ScorecardRecord;

const child = (parentScorecardId: string): RunRecord =>
  ({
    id: "r-1",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "queued",
    parentScorecardId,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  }) as RunRecord;

const paired = async (present: boolean) => {
  const scorecards = new InMemoryScorecardStore();
  const runs = new InMemoryRunStore();
  runs.attachScorecards(scorecards);
  if (present) await scorecards.create(scorecard());
  return runs;
};

describe("[COUNTEREXAMPLE] an in-memory parent that is not there does not admit work", () => {
  it("refuses a dispatch whose parent scorecard row is absent — as the Pg EXISTS clause does", async () => {
    const runs = await paired(false);
    await expect(runs.create(child("sc-1"), [], { parentDriver: { scorecardId: "sc-1", epoch: 0 } })).rejects.toThrow();
  });

  it("refuses an UPDATE fenced on a parent row that is absent — the sibling of the check above", async () => {
    // `create` was repaired first and `update`'s parallel inline check was left standing, which `pnpm review`
    // found on that very commit. It matters more, not less: `CaseOutcomeCommitter.settleChildOn → settleRun`
    // reaches this path on every batch settlement, and the Pg twin asks existence and epoch in ONE clause —
    // `EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.id = $1 AND s.owner_epoch = $2)`.
    //
    // Seen red under neutralization: "expected { id: 'r-1', tenant: 'acme', …(6) } to be undefined" — the
    // settlement coming back with a record, i.e. admitted against a parent that is not there.
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    runs.attachScorecards(scorecards);
    await scorecards.create(scorecard());
    await runs.create(child("sc-1"), [], { parentDriver: { scorecardId: "sc-1", epoch: 0 } });
    // …now settle it against a parent this store never saw, with the epoch a missing row defaults to.
    const admitted = await runs.update("r-1", { status: "succeeded" }, [], {
      parentDriver: { scorecardId: "sc-gone", epoch: 0 },
    });
    expect(admitted).toBeUndefined();
    expect((await runs.get("r-1"))?.status).not.toBe("succeeded");
  });

  it("…and still admits one whose parent is present and open — the refusal is not a ban", async () => {
    const runs = await paired(true);
    await runs.create(child("sc-1"), [], { parentDriver: { scorecardId: "sc-1", epoch: 0 } });
    expect(await runs.get("r-1")).toMatchObject({ id: "r-1", parentScorecardId: "sc-1" });
  });
});
