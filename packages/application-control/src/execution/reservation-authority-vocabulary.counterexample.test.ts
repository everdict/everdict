import { OPEN_SCORECARD_STATUSES, type RuntimeWorkRef, TERMINAL_SCORECARD_STATUSES } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore, attemptParentAuthority } from "../ports/execution-attempt-store.js";

// ── A NEGATED STATUS LIST IS FAIL-OPEN (arch-review 56, Wave A) ──────────────────────────────────────
//
// Wave 1 of the last review made `reserveWork` a conditional transition, so a dispatch may only bring new
// compute into existence while its parent is still allowed to place work. The condition it wrote was:
//
//     AND s.status NOT IN ('succeeded', 'failed')
//
// which was true of the enum ON THE DAY IT WAS WRITTEN and is not true of the enum. A scorecard's terminal
// set is `succeeded · failed · superseded · cancelled`, and a run's is `succeeded · failed · suspended`. So
// the guard answers "yes, this parent may still place compute" for a batch the user CANCELLED and for one a
// takeover SUPERSEDED — which is precisely the authorization the wave was written to remove.
//
// The shape is the finding, not the two missing strings. A negated list is fail-OPEN: every status added
// after it is written silently joins the permitted side, and nothing anywhere asks. An allowlist is
// fail-CLOSED: a status nobody has classified is simply not open, and `satisfies` makes the compiler ask at
// the moment the enum grows.
//
// AND IT WAS IN BOTH ADAPTERS. The review that found this reported the in-memory store as correct "because it
// uses the domain terminal predicate". It does not — the composition root's `authorityOf` hand-writes
// `status === "succeeded" || status === "failed"` too. That is why Wave 1's counterexample, which drives the
// in-memory store, could not catch it: there was no lane left where the right vocabulary was used, so a test
// comparing the two lanes would have agreed with itself.

const WORK: RuntimeWorkRef = { tenant: "acme", runId: "evd-sc-1-c1", externalJobId: "everdict-c1-aaaa" };

// The batch the attempt belongs to, and what its parent authority answers. Modelled exactly as the
// composition root wires it: `authorityOf` resolves the parent row and decides whether it may still act.
async function reserveUnderParent(status: string): Promise<{ reserved: boolean; refusal?: string }> {
  // THE PRODUCTION PREDICATE, wired exactly as the composition root wires it. Re-deriving "is this open?"
  // inside the test would have agreed with the defect — which is what the previous wave's counterexample did
  // by injecting its own `authorityOf`, and why it passed over a store that permitted a cancelled parent.
  const attempts = new InMemoryExecutionAttemptStore(
    undefined,
    attemptParentAuthority({
      scorecards: {
        async get() {
          return { status, ownerEpoch: 0 };
        },
      },
      runs: {
        async get() {
          return undefined;
        },
      },
    }),
  );
  const opened = await attempts.open({
    executionId: "evd-sc-1-c1",
    tenant: "acme",
    scorecardId: "sc-1",
    caseId: "c1",
  } as never);
  try {
    await attempts.reserveWork(opened.attemptId, { ...WORK, attemptId: opened.attemptId });
    return { reserved: true };
  } catch (err) {
    return { reserved: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}

// RED as of 7299afd9, observed (structural arm):
//   the reservation guard is a NEGATED status list, so every status added after it was written is silently
//   permitted: expected 's.status NOT IN …' to contain "s.status IN ('queued', 'running')"
describe("[R56 WAVE-A COUNTEREXAMPLE #1 — CLOSED] a reservation guard names the statuses that MAY act", () => {
  it("refuses under every terminal parent status, not only the two the query happened to list", async () => {
    for (const status of TERMINAL_SCORECARD_STATUSES) {
      const outcome = await reserveUnderParent(status);
      expect(outcome.reserved, `a ${status} batch was allowed to authorize new compute`).toBe(false);
    }
  });

  it("still authorizes an open parent — the guard must not be a refusal of everything", async () => {
    // The other direction, and the reason the allowlist is stated rather than inferred: a guard that refused
    // `running` would pass the assertion above while stopping the product.
    for (const status of OPEN_SCORECARD_STATUSES) {
      expect((await reserveUnderParent(status)).reserved, `a ${status} batch could not place its work`).toBe(true);
    }
  });

  // The SQL twin is certified in `packages/db` (`pg-execution-attempt-store.test.ts`): a fake `SqlClient`
  // cannot evaluate a WHERE clause, so that lane asserts the TEXT the store emits — and it must live there
  // rather than here, because `db` depends on this package and a test reaching the other way is a reverse
  // edge. Both lanes assert against the SAME exported allowlist, which is the whole point of the wave.
});
