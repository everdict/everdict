import type { CaseResult } from "@everdict/contracts";
import { CaseResultSchema, storedExecutionId } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { agentHalfDigest, agentHalfKey } from "../execution/agent-half.js";
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
  // ⚠️ WITH ITS PARENT. A batch case's attempt always carries `scorecardId` in production, and the adoption
  // checks that the parent a settlement NAMES is the parent the row has (arch-review 67 P2-contract) — so a
  // fixture that omits it is describing a standalone run and refusing a batch settlement for the right
  // reason (rule `testing`: a fixture must be the production shape).
  const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme", scorecardId: SCORECARD });
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
    const verifier = await attempts.open({
      executionId: EXECUTION,
      tenant: "acme",
      scorecardId: SCORECARD,
      caseId: "c1#verify",
    });
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

  // ── AND WHEN THE VERIFIER'S HANDLE IS THE ONE THAT ANSWERED (arch-review 65 P0-verifier) ──────────
  //
  // The branch above adopts `stage: "case"` — the agent's own handle — so `contributing.agent` is the handle
  // that was harvested and the receipt is right by construction. The VERIFIER branch is the one that was
  // wrong: it reached the merge through the judging container's handle, and that single ref became both
  // `receipt.attemptId` and the settlement's stamp. `receipt.attemptId` is what a trajectory read resolves an
  // evidence plane against, so a recovered case could serve the verifier's output as the case's evidence.
  //
  // Seen RED with the merge returning one coordinate again, observed:
  //   the receipt named the JUDGING container as the case's execution: expected 'evd-sc-1-c1#g2' to be 'evd-sc-1-c1#g1'
  it("names the AGENT's attempt on the receipt when the verdict's handle is what answered", async () => {
    const { attempts, attemptId: agentAttempt } = await ledgerHolding();
    const verifier = await attempts.open({
      executionId: EXECUTION,
      tenant: "acme",
      scorecardId: SCORECARD,
      caseId: "c1#verify",
    });

    // PARSED FIRST, and the digests taken from the parsed document. `readAgentHalf` runs the schema on what it
    // reads back, and a schema that fills a default makes `contentDigest(parsed.snapshot)` a different string
    // from the raw one — the merge then refuses for a reason that has nothing to do with this test (the first
    // draft of this case did exactly that: "produced against a different workspace").
    const AGENT_HALF = CaseResultSchema.parse({
      caseId: "c1",
      harness: "h@1",
      trace: [],
      scores: [{ graderId: "steps", metric: "steps", value: 3 }],
      snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "b", headSha: "h" },
    });
    const digest = agentHalfDigest(AGENT_HALF);
    const halves = new Map<string, Uint8Array>([
      [agentHalfKey("acme", "evd-sc-1-c1", digest), new TextEncoder().encode(JSON.stringify(AGENT_HALF))],
    ]);

    // The verifier's handle, as `reserveWork` stored it: it names the half it judged AND the agent execution
    // that produced it, which is what makes the two contributors separable at all.
    await attempts.reserveWork(verifier.attemptId, {
      tenant: "acme",
      runId: "evd-sc-1-c1",
      externalJobId: "everdict-c1-verify",
      attemptId: verifier.attemptId,
      verifier: {
        planDigest: "sha256:plan",
        workspaceDigest: contentDigest(AGENT_HALF.snapshot),
        caseId: "c1",
        agentResultDigest: digest,
        agentAttemptId: agentAttempt,
      },
    });
    await attempts.transition(verifier.attemptId, "verdict_produced");

    const receipts = receiptsOver(attempts);
    const planner = plannerOver(
      {
        // Only the verifier's handle answers — the agent's container is long gone, which is the whole shape
        // of this crash.
        adoptWork: async (_t: string, _r: unknown, work: { attemptId?: string }) =>
          work.attemptId === verifier.attemptId
            ? {
                kind: "adopted",
                adopted: {
                  stage: "verifier",
                  invocation: {
                    planDigest: "sha256:plan",
                    workspaceDigest: contentDigest(AGENT_HALF.snapshot),
                    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
                    agentAttemptId: agentAttempt,
                  },
                },
              }
            : { kind: "absent" },
        agentHalves: {
          async get(key: string) {
            return halves.get(key);
          },
          async put(key: string, data: Uint8Array) {
            halves.set(key, data);
            return key;
          },
          async remove(key: string) {
            halves.delete(key);
          },
        },
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

    expect(receipts.claimed, "the recovery never committed, so this case measured nothing").toHaveLength(1);
    expect(receipts.claimed[0]?.attemptId, "the receipt named the JUDGING container as the case's execution").toBe(
      agentAttempt,
    );
    // …and BOTH rows are closed, each as what it is.
    expect(await stateOf(attempts, agentAttempt)).toBe("committed");
    expect(await stateOf(attempts, verifier.attemptId)).toBe("committed");
  });
});
