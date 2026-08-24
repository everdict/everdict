import type { CaseResult } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { RecoveryPlanner } from "./recovery-planner.js";

// ── THE PLANNER KNEW WHICH ATTEMPT ANSWERED, AND DID NOT WRITE IT DOWN (arch-review 64 P1-high) ──────
//
// Batch recovery adopts by the exact `RuntimeWorkRef` the attempt ledger holds, so it has `work.attemptId`
// in hand. It kept the result and dropped the coordinate. So a recovered case settled as:
//
//     child row        succeeded
//     case receipt     committed, naming no attempt
//     external Job     deleted by the adoption
//     attempt row      reserved / active / executing — for compute that is gone
//
// `CaseReceiptStore.commitCase` has taken a transaction-bound `ExecutionAttemptStore` since arch-review 40
// precisely so the child's terminal write, the receipt claim and the attempt's terminal stamp are ONE
// decision. This owner passed neither the id nor the store.
//
// And a two-phase case has TWO rows under one execution id, so the transaction adopts both: the handle it
// harvested from, and — when the adopted document carries a verdict — the row that produced it. Since
// arch-review 64 that row stops at `verdict_produced`, which makes the omission visible instead of hidden
// behind a `committed` the lane wrote for itself.
//
// Seen RED before the planner carried its handle, observed:
//   the attempt whose work this batch counted was left reading as live: expected 'reserved' to be 'committed'

const SCORECARD = "sc-1";
const EXECUTION = storedExecutionId("evd-sc-1-c1");

const CHILD = {
  id: "child-9f2a3b",
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

// The world the recovery wakes into: one running child, one attempt row holding the handle its dispatch
// reserved. The adoption harvests THAT handle.
const ledgerHolding = async () => {
  const attempts = new InMemoryExecutionAttemptStore();
  const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
  await attempts.reserveWork(attemptId, {
    tenant: "acme",
    runId: "evd-sc-1-c1",
    externalJobId: "everdict-c1-aaaa",
    attemptId,
  });
  return { attempts, attemptId };
};

const stateOf = async (attempts: InMemoryExecutionAttemptStore, attemptId: string) =>
  (await attempts.list(EXECUTION)).find((a) => a.attemptId === attemptId)?.state;

// The receipt store, reduced to the one thing this file is about: it hands the settle closure the
// transaction-bound ledger, which is the seam the planner was not using.
function receiptsOver(attempts: InMemoryExecutionAttemptStore) {
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
        const settled = await settle(runs, attempts);
        return settled === undefined ? { kind: "unsettled" as const } : { kind: "committed" as const, receipt };
      },
    },
  };
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
      ...deps,
    } as never,
    {} as never,
    { receiptOf: (_id: string, result: CaseResult, entry: Record<string, unknown>) => ({ ...entry, result }) } as never,
    { now: () => "2026-08-24T00:00:00.000Z" },
  );
}

describe("[R64 COUNTEREXAMPLE] a batch recovery settles the attempt it adopted", () => {
  const recover = async (result: CaseResult) => {
    const { attempts, attemptId } = await ledgerHolding();
    const receipts = receiptsOver(attempts);
    const planner = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result } }),
        caseReceipts: receipts.store,
      },
      attempts,
    );
    await planner
      .seedFromLedger({
        scorecardId: SCORECARD,
        tenant: "acme",
        dataset: { id: "d", version: "1", cases: [] } as never,
        judges: [],
      })
      .catch(() => undefined);
    return { attempts, attemptId, receipts };
  };

  it("stamps the adopted attempt inside the commit, and NAMES it on the receipt", async () => {
    const { attempts, attemptId, receipts } = await recover(ADOPTED);

    expect(receipts.claimed, "the recovery never committed, so this file measured nothing").toHaveLength(1);
    expect(receipts.claimed[0]?.attemptId, "the receipt could not say which attempt this batch counted").toBe(
      attemptId,
    );
    expect(
      await stateOf(attempts, attemptId),
      "the attempt whose work this batch counted was left reading as live",
    ).toBe("committed");
  });

  it("adopts the VERDICT's row too, when the recovered document carries one", async () => {
    // A two-phase case is two physical executions under one execution id. Adopting only the harvested handle
    // leaves the row that produced the verdict at `verdict_produced` for a case that finished.
    const { attempts } = await ledgerHolding();
    const verifier = await attempts.open({ executionId: EXECUTION, tenant: "acme", caseId: "c1#verify" });
    await attempts.reserveWork(verifier.attemptId, {
      tenant: "acme",
      runId: "evd-sc-1-c1",
      externalJobId: "everdict-c1-verify",
    });
    await attempts.transition(verifier.attemptId, "verdict_produced");

    const { attemptId } = await (async () => {
      const [row] = await attempts.list(EXECUTION);
      return { attemptId: row?.attemptId ?? "" };
    })();

    const receipts = receiptsOver(attempts);
    const withVerdict = {
      ...ADOPTED,
      verifier: {
        planDigest: "sha256:plan",
        workspaceDigest: "sha256:tree",
        scores: [],
        work: { tenant: "acme", runId: "evd-sc-1-c1", externalJobId: "v", attemptId: verifier.attemptId },
        complete: true,
      },
    } as unknown as CaseResult;

    const planner = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: withVerdict } }),
        caseReceipts: receipts.store,
      },
      attempts,
    );
    await planner
      .seedFromLedger({
        scorecardId: SCORECARD,
        tenant: "acme",
        dataset: { id: "d", version: "1", cases: [] } as never,
        judges: [],
      })
      .catch(() => undefined);

    expect(await stateOf(attempts, attemptId)).toBe("committed");
    expect(
      await stateOf(attempts, verifier.attemptId),
      "the verdict's row was left waiting for a case that had already settled",
    ).toBe("committed");
  });
});
