import type { CaseCommitReceipt, CaseResult } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { RecoveryPlanner } from "./recovery-planner.js";

// ── A COMMIT THAT THREW IS NOT A COMMIT THAT DID NOT HAPPEN (arch-review 66 P1-lifecycle) ───────────
//
// `RecoveryPlanner` wrapped its commit in `.catch(() => undefined)` and the `undefined` arm re-dispatched
// the case. A connection reset AFTER Postgres wrote the receipt, the child and both attempt rows raises in
// exactly the same way as an insert that failed — so a case that had settled was run a second time. The
// duplicate loses the receipt claim, which keeps the ledger honest and does nothing about the money: the
// compute is spent by then.
//
// This is the same distinction `runSuite`'s compensation learned two reviews ago (rule `suite`: an exception
// is not proof that a commit did not happen), arriving at the batch recovery.
//
// The answer is a READ, never an assumption. The exact receipt says which world we are in, and a read that
// ALSO fails leaves the batch owed rather than deciding from two failures in a row.
//
// Seen RED before the `unknown` arm existed, observed:
//   a committed case was re-dispatched because its commit response was lost: expected [] to have a length of 1

const SCORECARD = "sc-1";
const CHILD_ID = "child-9f2a3b";
const EXECUTION = storedExecutionId("evd-sc-1-c1");

const CHILD = {
  id: CHILD_ID,
  executionId: EXECUTION,
  caseId: "c1",
  tenant: "acme",
  status: "running" as const,
  harness: { id: "h", version: "1" },
  parentScorecardId: SCORECARD,
  ownerEpoch: 0,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const ADOPTED: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  scores: [{ graderId: "tests", metric: "tests_pass", value: 1, pass: true }],
  snapshot: { kind: "prompt", output: "done" },
} as unknown as CaseResult;

const RECEIPT = { scorecardId: SCORECARD, caseId: "c1", childRunId: CHILD_ID, kind: "executed" } as CaseCommitReceipt;

// A receipt store whose commit LANDED and whose response was lost — the world the old code could not tell
// from a commit that never happened.
function lostResponseStore(opts: { landed: boolean; readFails?: boolean }) {
  return {
    async list() {
      return opts.landed ? [RECEIPT] : [];
    },
    async read() {
      if (opts.readFails) return { kind: "unknown" as const, reason: "the receipt ledger is unreachable" };
      return { kind: "read" as const, value: opts.landed ? [RECEIPT] : [] };
    },
    async commitCase() {
      // Postgres wrote the rows (or did not) and then the connection died. Identical from here.
      throw new Error("connection terminated unexpectedly");
    },
  };
}

// The ledger a recovery actually finds: one attempt holding the handle its dispatch reserved. Without it
// `handles` is empty, the adoption loop never runs, and the commit under test is never reached — the first
// draft of this file measured nothing for exactly that reason (rule `testing`: a fixture must reach the
// predicate).
async function ledgerHoldingWork() {
  const attempts = new InMemoryExecutionAttemptStore();
  const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme", scorecardId: SCORECARD });
  await attempts.reserveWork(attemptId, {
    tenant: "acme",
    runId: EXECUTION,
    externalJobId: "everdict-c1-aaaa",
    attemptId,
  });
  return attempts;
}

function plannerOver(deps: Record<string, unknown>, attempts: InMemoryExecutionAttemptStore) {
  const rows = new Map<string, typeof CHILD>([[CHILD.id, CHILD]]);
  return new RecoveryPlanner(
    {
      runStore: {
        async list() {
          return [...rows.values()];
        },
        async get(id: string) {
          return rows.get(id);
        },
        async update(id: string, patch: Record<string, unknown>) {
          const cur = rows.get(id);
          if (!cur) return undefined;
          const next = { ...cur, ...patch };
          rows.set(id, next as typeof CHILD);
          return next;
        },
      },
      attempts,
      adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: ADOPTED } }),
      ...deps,
    } as never,
    {} as never,
    { receiptOf: (_id: string, result: CaseResult, entry: Record<string, unknown>) => ({ ...entry, result }) } as never,
    { now: () => "2026-08-24T00:00:00.000Z" },
  );
}

const seed = async (planner: RecoveryPlanner) =>
  await planner
    .seedFromLedger({
      scorecardId: SCORECARD,
      tenant: "acme",
      // The case must be IN the re-resolved selection or the seed is filtered out at the end and this file
      // measures the filter rather than the commit (rule `testing`: a fixture must reach the predicate).
      dataset: { id: "d", version: "1", cases: [{ id: "c1", task: "t" }] } as never,
      judges: [],
    })
    .then((r) => ({ kind: "planned" as const, ...r }))
    .catch((err: unknown) => ({ kind: "owed" as const, err }));

describe("[R66 COUNTEREXAMPLE] an ambiguous commit is converged on, not assumed absent", () => {
  it("SEEDS the case whose commit landed and whose response was lost", async () => {
    const planner = plannerOver({ caseReceipts: lostResponseStore({ landed: true }) }, await ledgerHoldingWork());

    const out = await seed(planner);
    expect(out.kind).toBe("planned");
    if (out.kind !== "planned") return;
    // Seeded means "already answered — do not run it again", which is the whole point: the alternative is
    // paying for this case twice and discarding the second answer.
    expect(out.seedRunIds, "a committed case was re-dispatched because its commit response was lost").toEqual([
      CHILD_ID,
    ]);
    expect(out.adopted).toBe(1);
  });

  it("leaves the case for the re-drive when nothing landed", async () => {
    // The control. A commit that genuinely failed must still re-dispatch — the fix is not "assume it
    // committed", it is "go and look".
    const planner = plannerOver({ caseReceipts: lostResponseStore({ landed: false }) }, await ledgerHoldingWork());

    const out = await seed(planner);
    expect(out.kind).toBe("planned");
    if (out.kind !== "planned") return;
    expect(out.seedRunIds, "a case that committed nothing was seeded as answered").toEqual([]);
    expect(out.adopted).toBe(0);
  });

  it("leaves the WHOLE BATCH owed when the read-back cannot answer either", async () => {
    // Two failures in a row is not evidence. Deciding here would be the same defect one layer down, so the
    // planner refuses to produce a plan at all — the batch is retried, which is what `retry_later` means.
    const planner = plannerOver(
      { caseReceipts: lostResponseStore({ landed: true, readFails: true }) },
      await ledgerHoldingWork(),
    );

    const out = await seed(planner);
    expect(out.kind, "the planner decided a case's fate from two failed reads").toBe("owed");
    if (out.kind !== "owed") return;
    expect((out.err as Error).message).toContain("cannot tell whether this case's commit landed");
  });
});
