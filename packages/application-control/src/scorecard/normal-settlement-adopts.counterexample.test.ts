import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore, attemptParentAuthority } from "../ports/execution-attempt-store.js";

// ── THE ORDINARY SETTLEMENT CONSUMES ITS ANSWER TOO (arch-review 67 P1-high) ────────────────────────
//
// arch-review 66 gave the RECOVERY lane a semantic adoption whose result aborts the transaction, and left
// this one calling `transition` and dropping the boolean — with a comment saying the answer was deliberately
// not read. That is the one-lane-only shape this review series has now found six times (58, 59, 61, 64, 66,
// 67), and here is the interleaving it costs:
//
//   • a scorecard cancellation terminalizes the parent and does NOT raise its owner epoch;
//   • the child's settle fence checks epoch equality, not that the parent is open;
//   • so a case completing just after the cancel settles its child and claims its receipt;
//   • and `PARENT_AUTHORIZES` — which DOES check the parent is open — refuses both attempt transitions.
//
//     scorecard          cancelled
//     child              succeeded
//     receipt            committed
//     agent attempt      executing      ← never settled
//
// `committed` goes through the same adoption verb the recovery uses now, so the policy is stated once: a
// settlement adopts the attempts it settles, or it settles nothing. The other terminals keep `transition` —
// a `failed` row must still settle under a closed parent or attempts read live forever (L5).
//
// Seen RED before the normal lane adopted, observed:
//   a cancelled batch committed a case whose attempt never settled: expected 'executing' to be 'committed'

const SCORECARD = "sc-1";
const EXECUTION = storedExecutionId("evd-sc-1-c1");

// The ledger as the composition root builds it — with the parent authority WIRED, which is the detail whose
// absence makes every test of this path vacuous (rule `testing`).
const ledgerUnder = async (batch: { status: string; ownerEpoch: number }) => {
  const attempts = new InMemoryExecutionAttemptStore(
    () => "2026-08-25T00:00:00.000Z",
    attemptParentAuthority({ scorecards: { get: async () => batch }, runs: { get: async () => undefined } }),
  );
  const { attemptId } = await attempts.open({
    executionId: EXECUTION,
    tenant: "acme",
    scorecardId: SCORECARD,
    caseId: "c1",
    driverEpoch: batch.ownerEpoch,
  });
  await attempts.reserveWork(attemptId, {
    tenant: "acme",
    runId: EXECUTION,
    externalJobId: "everdict-c1",
    attemptId,
  });
  await attempts.transition(attemptId, "executing");
  return { attempts, attemptId };
};

const stateOf = async (attempts: InMemoryExecutionAttemptStore, attemptId: string) =>
  (await attempts.list(EXECUTION)).find((a) => a.attemptId === attemptId)?.state;

describe("[R67 COUNTEREXAMPLE] the ordinary settlement adopts the attempt it commits", () => {
  it("ADOPTS under a live parent, exactly as it always did", async () => {
    // The control first: the ordinary case must keep working, and a fail-closed change that fails everything
    // is not a fix.
    const batch = { status: "running", ownerEpoch: 0 };
    const { attempts, attemptId } = await ledgerUnder(batch);

    const outcome = await attempts.adoptAtSettlement(attemptId, {
      parent: { kind: "scorecard", id: SCORECARD, adoptingEpoch: 0 },
      expectedExecutionId: EXECUTION,
      childRunId: "child-1",
    });

    expect(outcome.kind, "an ordinary completing case could not adopt its own attempt").toBe("adopted");
    expect(await stateOf(attempts, attemptId)).toBe("committed");
  });

  it("REFUSES under a cancelled parent — and the receipt must follow the row", async () => {
    // The divergence. A cancellation does not move the epoch, so every guard that checks only the epoch
    // still passes; the one that checks OPENNESS refuses. Before this change the refusal was a dropped
    // boolean and the receipt committed anyway.
    const batch = { status: "running", ownerEpoch: 0 };
    const { attempts, attemptId } = await ledgerUnder(batch);
    batch.status = "cancelled";

    const outcome = await attempts.adoptAtSettlement(attemptId, {
      parent: { kind: "scorecard", id: SCORECARD, adoptingEpoch: 0 },
      expectedExecutionId: EXECUTION,
      childRunId: "child-1",
    });

    expect(outcome.kind, "a cancelled batch adopted a case's attempt as though it were still driving").toBe(
      "wrong_parent",
    );
    expect(
      await stateOf(attempts, attemptId),
      "the attempt was terminalized under a batch that had already been cancelled",
    ).toBe("executing");
  });

  it("still lets a FAILED row settle under a closed parent", async () => {
    // The other half of the policy, and the reason `committed` is the only state routed through adoption: a
    // failure that cannot settle leaves the row reading as live compute forever, which is the debt L5 is
    // about — and it asserts nothing was measured, so no canonicality rests on it.
    const batch = { status: "running", ownerEpoch: 0 };
    const { attempts, attemptId } = await ledgerUnder(batch);
    batch.status = "cancelled";

    expect(
      await attempts.transition(attemptId, "failed", { error: { code: "X", message: "the container died" } }),
      "a failed attempt could not settle under a cancelled batch, so its row reads live forever",
    ).toBe(true);
    expect(await stateOf(attempts, attemptId)).toBe("failed");
  });

  it("REFUSES a settlement that names a DIFFERENT parent, even with the right epoch", async () => {
    // ── THE PROOF THE CONTRACT ASKS FOR IS THE PROOF IT CONSUMES (arch-review 67 P2-contract) ───────
    //
    // `AttemptAdoption` advertises `parent: {kind, id, adoptingEpoch}` and only the epoch reached a guard:
    // both adapters branched on the row's OWN parent and compared the number. Two of three advertised fields
    // were a proof nobody consumed — the annotation failure this rule file exists to stop, inside the type
    // introduced to fix an instance of it.
    //
    // Production callers happen to pass the right coordinate, which is what kept it unreachable. "Nobody
    // misuses it today" is not the property; the property is that misusing it is refused.
    const batch = { status: "running", ownerEpoch: 0 };
    const { attempts, attemptId } = await ledgerUnder(batch);

    const wrongId = await attempts.adoptAtSettlement(attemptId, {
      parent: { kind: "scorecard", id: "some-other-scorecard", adoptingEpoch: 0 },
      expectedExecutionId: EXECUTION,
      childRunId: "child-1",
    });
    expect(wrongId.kind, "a settlement adopted an attempt belonging to another batch").toBe("wrong_parent");

    const wrongKind = await attempts.adoptAtSettlement(attemptId, {
      parent: { kind: "run", id: SCORECARD, adoptingEpoch: 0 },
      expectedExecutionId: EXECUTION,
      childRunId: "child-1",
    });
    expect(wrongKind.kind, "a run settlement adopted a scorecard child's attempt").toBe("wrong_parent");

    expect(await stateOf(attempts, attemptId), "the row was terminalized by a settlement that misnamed it").toBe(
      "executing",
    );
  });
});
