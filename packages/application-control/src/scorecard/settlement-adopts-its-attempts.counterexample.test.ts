import type { CaseResult } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore, attemptParentAuthority } from "../ports/execution-attempt-store.js";
import { RecoveryPlanner } from "./recovery-planner.js";

// ── A TRANSITION CALLED INSIDE A TRANSACTION IS NOT ONE THAT HAPPENED (arch-review 66 P0-protocol) ──
//
// The previous wave put both contributing attempts inside the settlement transaction and dropped the answer:
//
//     await boundAttempts.transition(contributing.agent, "committed", { childRunId: c.id });
//
// `committed` is a GUARDED write whose parent clause requires the batch still to be owned at the epoch the
// attempt was OPENED under. A boot recovery raises that epoch when it claims the dead owner's batch — the
// fencing token is the entire point of claiming — so every attempt a recovery adopts fails the comparison,
// every write is refused, and the transaction commits the canonical outcome on top of the refusals:
//
//     child           succeeded
//     receipt         committed
//     agent attempt   executing        ← for compute the adoption already reclaimed
//     verifier attempt verdict_produced
//
// ⚠️ THE PARENT AUTHORITY HAS TO BE WIRED FOR THIS FILE TO MEASURE ANYTHING. An `InMemoryExecutionAttemptStore`
// built with no `parents` skips the epoch comparison entirely — which is how every existing test of this path
// stayed green while production refused every call. The store here is built the way the composition root
// builds it (`attemptParentAuthority`), so the guard is the one production runs.
//
// Seen RED before `adoptAtSettlement` existed, observed:
//   the recovery settled a case whose agent attempt it could not close: expected 'executing' to be 'committed'

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

// The batch row, mutable so the recovery's claim can raise its epoch exactly as `claimOwnership` does.
function parentBatch(over: { status?: string; ownerEpoch?: number } = {}) {
  return { status: over.status ?? "running", ownerEpoch: over.ownerEpoch ?? 0 };
}

// The world a recovery wakes into: a batch that was running under epoch 0, and the two physical rows its
// dispatch opened under THAT epoch.
const worldBeforeRecovery = async (batch: { status: string; ownerEpoch: number }) => {
  const attempts = new InMemoryExecutionAttemptStore(
    () => "2026-08-24T00:00:00.000Z",
    // Wired exactly as the composition root wires it — see the warning above.
    attemptParentAuthority({
      scorecards: { get: async () => batch },
      runs: { get: async () => undefined },
    }),
  );
  const agent = await attempts.open({
    executionId: EXECUTION,
    tenant: "acme",
    scorecardId: SCORECARD,
    caseId: "c1",
    driverEpoch: batch.ownerEpoch,
  });
  await attempts.reserveWork(agent.attemptId, {
    tenant: "acme",
    runId: EXECUTION,
    externalJobId: "everdict-c1-agent",
    attemptId: agent.attemptId,
  });
  await attempts.transition(agent.attemptId, "executing");
  return { attempts, agent };
};

const stateOf = async (attempts: InMemoryExecutionAttemptStore, attemptId: string) =>
  (await attempts.list(EXECUTION)).find((a) => a.attemptId === attemptId)?.state;

// ⚠️ THE DOUBLE MODELS THE ROLLBACK, because the real one is a transaction (rule `protocol`, the
// always-succeeds-double law). `PgCaseReceiptStore.commitCase` runs the settle closure inside `BEGIN`, so a
// throw from the adoption takes the child's terminal write with it — which is the entire mechanism under
// test. A double that keeps the child `succeeded` after the throw is more permissive than production and
// would report this fix as not working; the first draft of this file did exactly that.
function receiptsOver(attempts: InMemoryExecutionAttemptStore, rows: Map<string, typeof CHILD>) {
  const claimed: Array<{ attemptId?: string }> = [];
  return {
    claimed,
    store: {
      async list() {
        return [];
      },
      async commitCase(
        receipt: { attemptId?: string },
        settle: (runs: unknown, bound: InMemoryExecutionAttemptStore) => Promise<unknown>,
        runs: unknown,
      ) {
        claimed.push(receipt);
        const before = new Map(rows);
        try {
          const settled = await settle(runs, attempts);
          return settled === undefined ? { kind: "unsettled" as const } : { kind: "committed" as const, receipt };
        } catch (err) {
          rows.clear();
          for (const [k, v] of before) rows.set(k, v);
          throw err;
        }
      },
    },
  };
}

function plannerOver(
  deps: Record<string, unknown>,
  attempts: InMemoryExecutionAttemptStore,
  rows: Map<string, typeof CHILD>,
) {
  return {
    rows,
    planner: new RecoveryPlanner(
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
        ...deps,
      } as never,
      {} as never,
      {
        receiptOf: (_id: string, result: CaseResult, entry: Record<string, unknown>) => ({ ...entry, result }),
      } as never,
      { now: () => "2026-08-24T00:00:00.000Z" },
    ),
  };
}

const seed = async (planner: RecoveryPlanner, parentDriver?: { scorecardId: string; epoch: number }) =>
  await planner
    .seedFromLedger({
      scorecardId: SCORECARD,
      tenant: "acme",
      dataset: { id: "d", version: "1", cases: [] } as never,
      judges: [],
      ...(parentDriver ? { parentDriver } : {}),
    })
    .then(() => undefined)
    .catch((err: unknown) => err);

describe("[R66 COUNTEREXAMPLE] a recovery adopts the attempts it settles, or it settles nothing", () => {
  it("CLOSES the attempt under the epoch its own claim raised", async () => {
    const batch = parentBatch();
    const { attempts, agent } = await worldBeforeRecovery(batch);
    // The claim: the fencing token rises. Everything below happens under the NEW epoch.
    batch.ownerEpoch = 1;

    const rows = new Map<string, typeof CHILD>([[CHILD.id, CHILD]]);
    const receipts = receiptsOver(attempts, rows);
    const { planner } = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: ADOPTED } }),
        caseReceipts: receipts.store,
      },
      attempts,
      rows,
    );
    await seed(planner, { scorecardId: SCORECARD, epoch: 1 });

    expect(receipts.claimed, "the recovery never committed, so this file measures nothing").toHaveLength(1);
    expect(
      await stateOf(attempts, agent.attemptId),
      "the recovery settled a case whose agent attempt it could not close",
    ).toBe("committed");
  });

  it("ABORTS the settlement when the attempt may not be adopted at all", async () => {
    // The other half, and the reason the answer has to be a union rather than a boolean: a superseded attempt
    // and an epoch that legitimately moved both used to be `false`, so a settlement could not tell "somebody
    // else owns this" from "our own claim raised the number". One proceeds; one must not.
    const batch = parentBatch();
    const { attempts, agent } = await worldBeforeRecovery(batch);
    batch.ownerEpoch = 1;
    await attempts.transition(agent.attemptId, "superseded");

    const rows = new Map<string, typeof CHILD>([[CHILD.id, CHILD]]);
    const receipts = receiptsOver(attempts, rows);
    const { planner } = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: ADOPTED } }),
        caseReceipts: receipts.store,
      },
      attempts,
      rows,
    );
    await seed(planner, { scorecardId: SCORECARD, epoch: 1 });

    // Asserted as the OUTCOME rather than as a thrown error: the planner deliberately turns a failed commit
    // into "leave this case active for the re-dispatch below", so what this pins is the world, not the
    // exception (rule `testing` — assert the outcome, not the call).
    expect(rows.get(CHILD_ID)?.status, "the child settled over an attempt nobody could close").toBe("running");
    expect(receipts.claimed.length, "a receipt was claimed for a case whose attempt could not be adopted").toBe(1);
    expect(await stateOf(attempts, agent.attemptId), "a superseded attempt was re-terminalized as committed").toBe(
      "superseded",
    );
  });

  it("REFUSES when this recovery's claim is not the one the batch is owned by", async () => {
    // A stale recovery — another replica claimed after it did. Its adoption names epoch 1 and the batch is at
    // 2, which is not "the fence moved for us" but "the fence moved past us".
    const batch = parentBatch();
    const { attempts, agent } = await worldBeforeRecovery(batch);
    batch.ownerEpoch = 2;

    const rows = new Map<string, typeof CHILD>([[CHILD.id, CHILD]]);
    const receipts = receiptsOver(attempts, rows);
    const { planner } = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: ADOPTED } }),
        caseReceipts: receipts.store,
      },
      attempts,
      rows,
    );
    await seed(planner, { scorecardId: SCORECARD, epoch: 1 });

    expect(rows.get(CHILD_ID)?.status, "a displaced recovery settled the batch's case anyway").toBe("running");
    expect(await stateOf(attempts, agent.attemptId), "a displaced recovery adopted the attempt anyway").toBe(
      "executing",
    );
  });
});
