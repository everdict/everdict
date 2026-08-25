import type { CaseCommitReceipt, CaseResult } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { caseObservationDigest, caseResultDigest } from "@everdict/domain";
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
// ── …AND THE READ RETURNS THE PERSISTED RESULT (arch-review 67 P0-canonicality) ─────────────────────
//
// The first version of this arm asked only whether SOME receipt named this child, then seeded the
// PROCESS-LOCAL document it had been about to commit. A concurrent writer that committed a different result
// for that child first therefore left the batch carrying a document the ledger does not hold — worse than
// the double-spend it replaced, because a double-spend is visible and this is not.
//
// Seen RED before the `unknown` arm existed, observed:
//   a committed case was re-dispatched because its commit response was lost: expected [] to have a length of 1
//
// …and RED again with the local result seeded (arch-review 67), observed:
//   the recovery seeded its own result over the one the ledger holds: expected 'RA' to be 'RB'

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

// The document the LEDGER holds — deliberately not the one the recovering process is about to commit.
const PERSISTED: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  scores: [{ graderId: "tests", metric: "tests_pass", value: 0, pass: false }],
  snapshot: { kind: "prompt", output: "somebody else got there first" },
} as unknown as CaseResult;

// Sealed the way a real commit seals it, so the corroboration below compares production digests rather than
// two literals.
const receiptFor = (result: CaseResult): CaseCommitReceipt =>
  ({
    scorecardId: SCORECARD,
    caseId: "c1",
    childRunId: CHILD_ID,
    kind: "executed",
    resultDigest: caseResultDigest(result),
    observationDigest: caseObservationDigest(result),
    committedAt: "2026-08-25T00:00:00.000Z",
  }) as CaseCommitReceipt;

// A receipt store whose commit LANDED and whose response was lost — the world the old code could not tell
// from a commit that never happened.
function lostResponseStore(opts: { landed?: CaseResult; readFails?: boolean }) {
  const receipts = opts.landed ? [receiptFor(opts.landed)] : [];
  return {
    async list() {
      return receipts;
    },
    async read() {
      if (opts.readFails) return { kind: "unknown" as const, reason: "the receipt ledger is unreachable" };
      return { kind: "read" as const, value: receipts };
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

function plannerOver(
  deps: Record<string, unknown>,
  attempts: InMemoryExecutionAttemptStore,
  // What the CONCURRENT WRITER lands while our commit is in flight. Absent = nothing landed.
  persisted?: CaseResult,
) {
  // ⚠️ THE ROW CHANGES BETWEEN THE LIST AND THE READ-BACK, because that is the interleaving. At planning
  // time the child is still running with no result — otherwise the planner seeds it from the ledger up
  // front and the ambiguous path is never reached, which is how the first draft of this case measured
  // nothing. The other writer's commit lands while ours is in flight, so `get` (the read-back's source)
  // answers with the settled row.
  const listed = { ...CHILD };
  const settled = persisted ? { ...CHILD, status: "succeeded", result: persisted } : undefined;
  return new RecoveryPlanner(
    {
      runStore: {
        async list() {
          return [listed];
        },
        async get(id: string) {
          if (id !== CHILD.id) return undefined;
          return settled ?? listed;
        },
        async update() {
          return listed;
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
  it("SEEDS THE PERSISTED result when the commit landed and the response was lost", async () => {
    // ⚠️ THE LEDGER HOLDS A DIFFERENT DOCUMENT THAN THIS RECOVERY IS CARRYING. That is the case the first
    // version could not see: it checked only that a receipt named this child and then seeded `adoptedResult`.
    const planner = plannerOver(
      { caseReceipts: lostResponseStore({ landed: PERSISTED }) },
      await ledgerHoldingWork(),
      PERSISTED,
    );

    const out = await seed(planner);
    expect(out.kind).toBe("planned");
    if (out.kind !== "planned") return;
    // Seeded means "already answered — do not run it again", which is the whole point: the alternative is
    // paying for this case twice and discarding the second answer.
    expect(out.seedRunIds, "a committed case was re-dispatched because its commit response was lost").toEqual([
      CHILD_ID,
    ]);
    expect(out.adopted).toBe(1);
    expect(out.seed[0]?.snapshot, "the recovery seeded its own result over the one the ledger holds").toEqual(
      PERSISTED.snapshot,
    );
  });

  it("leaves the batch OWED when the receipt and the child disagree", async () => {
    // A receipt vouching for bytes the row does not hold is not a tie to break in favour of whoever is
    // asking. Something is wrong, and a resume that picks a side makes it permanent.
    const planner = plannerOver(
      { caseReceipts: lostResponseStore({ landed: PERSISTED }) },
      await ledgerHoldingWork(),
      // The row holds ADOPTED while the receipt vouches for PERSISTED.
      ADOPTED,
    );

    const out = await seed(planner);
    expect(out.kind, "the recovery decided a case whose ledger contradicts itself").toBe("owed");
    if (out.kind !== "owed") return;
    expect((out.err as Error).message).toContain("could not settle it either");
  });

  it("leaves the case for the re-drive when nothing landed", async () => {
    // The control. A commit that genuinely failed must still re-dispatch — the fix is not "assume it
    // committed", it is "go and look".
    const planner = plannerOver({ caseReceipts: lostResponseStore({}) }, await ledgerHoldingWork());

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
      { caseReceipts: lostResponseStore({ landed: PERSISTED, readFails: true }) },
      await ledgerHoldingWork(),
    );

    const out = await seed(planner);
    expect(out.kind, "the planner decided a case's fate from two failed reads").toBe("owed");
    if (out.kind !== "owed") return;
    expect((out.err as Error).message).toContain("cannot tell whether this case's commit landed");
  });
});
