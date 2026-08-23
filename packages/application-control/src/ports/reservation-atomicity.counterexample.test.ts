import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "./execution-attempt-store.js";

// ── THE DEV STORE MAY NOT REACH A STATE POSTGRES CANNOT (arch-review 63 P1-adapter) ──────────────────
//
// `reserveWork` is read the row → `await` the parent check → write. An `await` yields the event loop, so two
// concurrent callers both read `created`, both pass the check, and both are handed a `PersistedWorkIntent` —
// while the map keeps whichever wrote last:
//
//     A read created            B read created
//     A parent check passes     B parent check passes
//     A writes job-A            B writes job-B          → the row holds job-B
//     A holds an authorization for job-A, which nothing can address
//
// That is the failure L1 exists to prevent, and the loser's dispatch creates a cluster object whose handle
// no row holds. The Postgres twin cannot reach it: its claim is a guarded `UPDATE … RETURNING` and the second
// caller simply gets no row.
//
// This store is dev/test, and that is precisely why it matters. Most counterexamples in this repository run
// against it, so a state production cannot reach must not be reachable here either — otherwise the suite
// certifies behaviour the real adapter does not have, which is the fake-more-permissive rule in its most
// expensive form.
//
// Measured before the fix, observed:
//   authorizations handed out: 2 ["job-A","job-B"]   row holds: job-B

describe("[R63 COUNTEREXAMPLE] one attempt hands out one work authorization", () => {
  const opened = async () => {
    const attempts = new InMemoryExecutionAttemptStore(undefined, { authorityOf: async () => ({ epoch: 1 }) });
    const { attemptId } = await attempts.open({ executionId: "evd-run-r1", tenant: "acme" });
    return { attempts, attemptId };
  };

  it("REFUSES the second of two concurrent reservations", async () => {
    const { attempts, attemptId } = await opened();
    const settled = await Promise.allSettled([
      attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" }),
      attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-B" }),
    ]);

    const granted = settled.filter((s) => s.status === "fulfilled");
    expect(granted, "two callers were authorized to create work for one attempt").toHaveLength(1);
    // …and the row holds exactly what the winner was told it holds, or the authorization names an object
    // nothing can address.
    const [row] = await attempts.list("evd-run-r1");
    expect(row?.runtimeWork?.externalJobId).toBe(
      (granted[0] as PromiseFulfilledResult<{ work: { externalJobId: string } }>).value.work.externalJobId,
    );
  });

  it("is IDEMPOTENT for the same work, which is not the same as a second grant", async () => {
    // A retry re-reserving the exact external id is repeating itself and must succeed — serializing must not
    // turn a correct dispatch's retry into a conflict.
    const { attempts, attemptId } = await opened();
    const work = { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" };
    const first = await attempts.reserveWork(attemptId, work);
    const again = await attempts.reserveWork(attemptId, work);
    expect(again.work.externalJobId).toBe(first.work.externalJobId);
    expect(again.attemptId).toBe(first.attemptId);
  });

  it("does not WEDGE the attempt after a refusal", async () => {
    // The hazard a promise-chain lock introduces if the tail is the caller's promise: one rejection and every
    // later call on this attempt waits forever. The chain's tail is settled, so a refusal costs nothing.
    const { attempts, attemptId } = await opened();
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" });
    await expect(
      attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-B" }),
    ).rejects.toThrow();

    // …and the store still answers afterwards.
    expect((await attempts.list("evd-run-r1"))[0]?.runtimeWork?.externalJobId).toBe("job-A");
    expect(await attempts.transition(attemptId, "committed")).toBe(true);
  });

  it("serializes ACTIVATION the same way", async () => {
    // Same read-await-write shape, same hazard: two activations of one reservation are two authorizations to
    // create the object.
    const { attempts, attemptId } = await opened();
    const work = { tenant: "acme", runId: "evd-run-r1", externalJobId: "job-A" };
    await attempts.reserveWork(attemptId, work);
    const [a, b] = await Promise.all([attempts.activateWork(attemptId, work), attempts.activateWork(attemptId, work)]);
    // Exactly ONE of them activates and the other is told the object already has an activation. That split
    // is the proof they ran in sequence: interleaved, both would have read `reserved` and both would have
    // answered `activate` — two authorizations to create one object.
    expect([a.kind, b.kind].sort(), "two callers were each authorized to create the object").toEqual([
      "activate",
      "already_active",
    ]);
    expect((await attempts.list("evd-run-r1"))[0]?.state).toBe("active");
  });
});
