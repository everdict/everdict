import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { RecoveryPlanner } from "./recovery-planner.js";

// ── THE LEDGER IS KEYED BY THE EXECUTION, NOT BY THE ROW (arch-review 63 P0) ─────────────────────────
//
// A scorecard child has TWO identifiers and they are not the same string:
//
//     child.id          = newId()                              a database row id
//     child.executionId = evd-<scorecardId>-<caseId>[-t<n>]    the physical coordinate
//
// The attempt ledger is opened under the second and the child carries it as its own field precisely so
// nothing has to re-derive it (mig 0172). The batch recovery read `attempts.list(c.id)`.
//
// So `list` matched no row — for every child, always. Recovery saw an empty handle list, adopted nothing,
// interrupted the child and re-dispatched a case whose managed Job may still have been running:
//
//     old Job live · recovery sees [] · child interrupted · case re-dispatched
//     → two executions of one case, competing evidence, duplicate spend
//     → a private verifier that had already finished, thrown away
//     → an inert object that adoption could have reclaimed, never found
//
// The inert-recovery arm and the staged-half merge were both correct and both UNREACHABLE, because the
// handle that leads into them was never fetched. That is the shape worth remembering: a coordinate error
// does not break the protocol it feeds, it makes the protocol dead code.
//
// Nothing types a string as an execution id, which is why it read as consistent — the verifier lookup beside
// it used `c.id` too, under a comment approving them for matching. Being consistent with the wrong string is
// exactly as broken as being inconsistent, and looks better.
//
// Seen RED before the coordinate was fixed, observed:
//   a recovery found no handles for a child whose attempt row exists: expected 0 to be 1

describe("[R63 COUNTEREXAMPLE] a child's attempts are found by the id the ledger was written with", () => {
  // The production shape, which is the whole point: the two ids DIFFER. A fixture that sets them equal
  // cannot see a lookup using the wrong one — see rule `testing`.
  const CHILD = { id: "child-9f2a3b", executionId: storedExecutionId("evd-sc-1-c1"), caseId: "c1" };

  const ledgerWithWork = async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: CHILD.executionId, tenant: "acme" });
    await attempts.reserveWork(attemptId, {
      tenant: "acme",
      runId: CHILD.executionId,
      externalJobId: "everdict-c1-aaaa",
    });
    return attempts;
  };

  it("finds the handle under the EXECUTION id", async () => {
    const attempts = await ledgerWithWork();
    const rows = await attempts.list(storedExecutionId(CHILD.executionId));
    expect(rows, "the fixture recorded no attempt, so every assertion here is vacuous").toHaveLength(1);
    expect(rows[0]?.runtimeWork?.externalJobId).toBe("everdict-c1-aaaa");
  });

  it("finds NOTHING under the row id — the read that was shipped", async () => {
    // This is not a hypothetical: it is what the recovery did for every child of every batch.
    const attempts = await ledgerWithWork();
    expect(
      await attempts.list(storedExecutionId(CHILD.id)),
      "the row id happened to match the ledger, so this file proves nothing about the defect",
    ).toHaveLength(0);
  });

  it("the recovery resolves the coordinate the way production stamps it", async () => {
    // The rule the fix encodes, asserted directly because the planner's own read is buried in a batch plan
    // that needs a scorecard, a dataset and a committer to reach. `executionId` when the child has one; the
    // row id only for children written before the field existed.
    const resolve = (c: { id: string; executionId?: string }) => c.executionId ?? c.id;

    expect(resolve(CHILD), "a stamped child was still addressed by its row id").toBe(CHILD.executionId);
    // …and a legacy row, which has nothing else to be addressed by.
    expect(resolve({ id: "legacy-1" })).toBe("legacy-1");
  });

  it("a handle written under the row id is NOT found under the execution id either", async () => {
    // The control for the control: if `list` matched loosely, both directions would answer and neither of
    // the assertions above would mean anything.
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: storedExecutionId(CHILD.id), tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: CHILD.id, externalJobId: "j" });
    expect(await attempts.list(storedExecutionId(CHILD.executionId))).toHaveLength(0);
    expect(await attempts.list(storedExecutionId(CHILD.id))).toHaveLength(1);
  });
});

// ── …AND THE PLANNER ITSELF, DRIVEN (arch-review 63 P0) ─────────────────────────────────────────────
//
// The assertions above pin the ledger's contract and the resolution rule. Neither drives the code that got
// this wrong, and a mutation of the planner would leave them green — which is the same "checking the line
// beside the protocol" this repo has been caught by before.
//
// So: one running child in the shape production makes (row id ≠ execution id), one attempt row under its
// EXECUTION id holding a handle, and the question is whether adoption is reached at all. With the wrong
// coordinate the handle list is empty, `adoptWork` is never called, and the case goes to re-dispatch while
// its Job may still be live.
//
// Seen RED before the fix, observed:
//   the recovery never reached adoption, so the case would be re-dispatched over live work: expected [] to
//   have a length of 1
describe("[R63 COUNTEREXAMPLE] the planner reaches adoption for a child whose ids differ", () => {
  const SCORECARD = "sc-1";
  const CHILD = {
    id: "child-9f2a3b",
    executionId: storedExecutionId("evd-sc-1-c1"),
    caseId: "c1",
    tenant: "acme",
    status: "running" as const,
    harness: { id: "h", version: "1" },
    parentScorecardId: SCORECARD,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };

  it("asks adoption about the handle its ledger row holds", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: CHILD.executionId, tenant: "acme" });
    await attempts.reserveWork(attemptId, {
      tenant: "acme",
      runId: CHILD.executionId,
      externalJobId: "everdict-c1-aaaa",
    });

    const asked: string[] = [];
    const planner = new RecoveryPlanner(
      {
        runStore: { list: async () => [CHILD] },
        caseReceipts: { list: async () => [] },
        attempts,
        adoptWork: async (_t: string, _r: string | undefined, work: { externalJobId: string }) => {
          asked.push(work.externalJobId);
          // Stop here: this file asks whether adoption was REACHED, and letting the plan continue would
          // add a committer's lifecycle to a question that is already answered.
          return { kind: "unknown", reason: "stop once the handle was found" };
        },
      } as never,
      {} as never,
      {} as never,
      { now: () => "2026-08-23T00:00:00.000Z" },
    );

    await planner
      .seedFromLedger({
        scorecardId: SCORECARD,
        tenant: "acme",
        dataset: { id: "d", version: "1", cases: [] } as never,
        judges: [],
      })
      .catch(() => undefined); // an `unknown` adoption refuses the plan, which is the arm above

    expect(asked, "the recovery never reached adoption, so the case would be re-dispatched over live work").toEqual([
      "everdict-c1-aaaa",
    ]);
  });
});
