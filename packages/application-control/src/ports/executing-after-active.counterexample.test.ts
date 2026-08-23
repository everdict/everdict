import { runExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "./execution-attempt-store.js";

// ── A NEW STATE MUST JOIN THE EXISTING TRANSITION TABLE (arch-review 58 P1) ─────────────────────────
//
// arch-review 57 added `active` between `reserved` and the external object's birth. It did not add it to the
// guard that lets an attempt reach `executing`, which still reads
//
//     created | reserved  →  executing
//
// in both twins. That was invisible for a wave because nothing supplied `onActivate`, so no attempt ever
// became `active`. The moment production supplies it — which is the fix for the P0 beside this one — every
// managed run walks:
//
//     reserved → active → (executing REFUSED) → committed
//
// The run still finishes, which is why this is not a P0: the outcome is right and the LEDGER is wrong. It
// records that the work was authorized and then settled, with no phase saying it ran. Every reader that asks
// "what is executing right now" — the ops view, a stuck-run sweep, a human — gets a false answer, and a
// silent one.
//
// This is vocabulary drift: a protocol descriptor added beside an existing transition table instead of into
// it. The general rule it earns is that a new state is not done until every guard that mentions its
// neighbours has been re-read.
//
// RED as of 26147830, observed:
//   expected false to be true — an attempt that had authorized its work could not report that it started

describe("[R58 COUNTEREXAMPLE] an activated attempt can still report that it started", () => {
  const opened = async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: runExecutionId("r1"), tenant: "acme" });
    return { attempts, attemptId };
  };

  it("moves active → executing", async () => {
    const { attempts, attemptId } = await opened();
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "r1", externalJobId: "job-1" });
    const decision = await attempts.activateWork(attemptId, {
      tenant: "acme",
      runId: "r1",
      externalJobId: "job-1",
    });
    expect(decision.kind).toBe("activate");

    expect(
      await attempts.transition(attemptId, "executing"),
      "an attempt that had authorized its work could not report that it started",
    ).toBe(true);
    expect((await attempts.list(runExecutionId("r1")))[0]?.state).toBe("executing");
  });

  it("still moves reserved → executing, for a lane that reports no activation", async () => {
    // A deployment whose backend does not activate (no ledger, an in-process driver) keeps the old path.
    const { attempts, attemptId } = await opened();
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "r1", externalJobId: "job-1" });
    expect(await attempts.transition(attemptId, "executing")).toBe(true);
  });

  it("REFUSES executing from a revoked attempt — the new state is not a free pass", async () => {
    // The point of widening a guard is to admit one more legal predecessor, not to stop guarding. A
    // cancellation took this reservation back; it may not then report that it started.
    const { attempts, attemptId } = await opened();
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "r1", externalJobId: "job-1" });
    await attempts.revokeReservation(attemptId);
    expect(await attempts.transition(attemptId, "executing")).toBe(false);
  });
});
