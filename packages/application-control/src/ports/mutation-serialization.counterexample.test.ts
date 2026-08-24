import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "./execution-attempt-store.js";

// ── THE DEV STORE MAY NOT REACH A STATE POSTGRES CANNOT (arch-review 64 P1-adapter) ──────────────────
//
// arch-review 63 serialized `reserveWork` and `activateWork` and left `transition` and `revokeReservation`
// outside the same queue. `transition` is read current → await the parent-authority check → write from that
// stale read, so a revocation landing inside the await is silently overwritten:
//
//     commit  reads `active`, awaits parentAuthority
//     cancel  revokeReservation → `revoked`
//     commit  resumes, writes `committed` from the stale `current`
//
// A cancellation that took the reservation back, and an attempt that claimed the case's answer anyway.
// Postgres cannot reach it — its guarded `UPDATE … WHERE` re-evaluates on the latest row version under the
// row lock, so the losing statement simply updates nothing.
//
// That asymmetry is the expensive part. Most counterexamples in this repository, and every mutation rung that
// touches the ledger, run against THIS store: a state production cannot reach must not be reachable here
// either, or the suite certifies a protocol the real adapter does not have.
//
// Seen RED before the serialization, observed:
//   a revoked reservation was overwritten by a commit that read the row before it: expected 'committed' to be 'revoked'

const EXECUTION = storedExecutionId("evd-run-r1");

describe("[R64 COUNTEREXAMPLE] every attempt mutation shares one serialization domain", () => {
  // A parent-authority check the test can HOLD OPEN — the await inside `transition` where the race lives.
  const storeWithPausableAuthority = () => {
    let release: (() => void) | undefined;
    const opened = new Promise<void>((r) => {
      release = r;
    });
    let pause = false;
    const attempts = new InMemoryExecutionAttemptStore(undefined, {
      authorityOf: async () => {
        if (pause) await opened;
        return { epoch: 1 };
      },
    });
    const hold = () => {
      pause = true;
    };
    return { attempts, hold, release: () => release?.() };
  };

  it("REFUSES a commit that read the row before a revocation landed", async () => {
    const { attempts, hold, release } = storeWithPausableAuthority();
    const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" });
    await attempts.activateWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" });

    hold();
    const commit = attempts.transition(attemptId, "committed"); // pauses inside the parent check
    const revoke = attempts.revokeReservation(attemptId); // arrives while it is paused
    release();

    const [committed, revoked] = await Promise.all([commit, revoke]);
    const [row] = await attempts.list(EXECUTION);

    // ⚠️ THE ASSERTION THAT WOULD NOT HAVE CAUGHT IT was `expect(["committed","revoked"]).toContain(state)` —
    // the unserialized store lands on `committed`, which that accepts. A counterexample has to name the pair,
    // not the set of outcomes: BOTH may not win. Serialized, the loser is told it lost.
    const bothWon = committed && revoked.kind === "revoked";
    expect(bothWon, "a revoked reservation was overwritten by a commit that read the row before it").toBe(false);
    // …and the row agrees with whoever was told they won.
    expect(row?.state).toBe(committed ? "committed" : "revoked");
  });

  it("still lets an ordinary commit through", async () => {
    // The control: serialization must not turn a lone transition into a refusal.
    const attempts = new InMemoryExecutionAttemptStore(undefined, { authorityOf: async () => ({ epoch: 1 }) });
    const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" });

    expect(await attempts.transition(attemptId, "committed")).toBe(true);
    expect((await attempts.list(EXECUTION))[0]?.state).toBe("committed");
  });

  it("does not WEDGE the attempt when one mutation refuses", async () => {
    // The hazard a promise-chain lock introduces if the tail is the caller's promise: one rejection and every
    // later call on this attempt waits forever. Now that four verbs share the chain, the blast radius of that
    // mistake would be the whole row.
    const attempts = new InMemoryExecutionAttemptStore(undefined, { authorityOf: async () => ({ epoch: 1 }) });
    const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" });
    await expect(
      attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-B" }),
    ).rejects.toThrow();

    // …and the row still answers every verb afterwards.
    expect(await attempts.transition(attemptId, "committed")).toBe(true);
    expect((await attempts.revokeReservation(attemptId)).kind).toBe("settled");
  });
});
