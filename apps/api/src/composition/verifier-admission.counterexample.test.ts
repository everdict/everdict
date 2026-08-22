import type { VerifierJob } from "@everdict/contracts";
import { PaymentRequiredError } from "@everdict/contracts";
import type { BudgetTracker } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildRuntimeAccess } from "./runtime-access.js";

// ── A VERIFIER TAKES COMPUTE, SO IT PASSES ADMISSION (arch-review 59 P1-high) ────────────────────────
//
// Rule `backends`: anything that takes compute passes the admission gate BEFORE a container is provisioned,
// and releases on any failure that produced nothing. The agent's half does, through `Scheduler.dispatch`.
//
// This lane resolves a backend and calls `dispatchVerifier` on it directly. So a batch of 500 private-verifier
// cases placed 500 FURTHER containers — each running the tenant's own task image, each bounded only by the
// case's own `timeoutSec` — with no reservation and nothing to 402 against. A workspace at its cap could not
// submit another run and was, at that same moment, doubling its container count.
//
// It is admission that is shared here, not the queue: `Scheduler.dispatch` is task-shaped over
// `Backend.dispatch`, while a verifier goes through `VerifierDispatchable` with a different payload. Routing
// it through the queue would mean giving the scheduler a second dispatch verb; the GATE is what the rule
// says the lanes share, and it is what a bill is made of.
//
// Seen RED before the gate existed, observed:
//   a verifier container was created for a workspace over its budget: expected NotFoundError: runtime 'rt-1'
//   cannot run … to be an instance of PaymentRequiredError
//
// …and the release half separately, which is the one that turns a gate into a leak if it is missed:
//   a reservation for a verifier that never ran was never released: expected 1 to be +0

const JOB: VerifierJob = {
  runId: "evd-sc-1-c1-t0",
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
  plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
  timeoutSec: 60,
  placementTarget: "rt-1",
} as unknown as VerifierJob;

// A budget that counts reservations and can be told to refuse, so both directions are observable.
function budget(opts: { refuse?: boolean } = {}) {
  let reserved = 0;
  const tracker: BudgetTracker & { reserved: () => number } = {
    admit: (tenant: string) => {
      if (opts.refuse) throw new PaymentRequiredError("BUDGET_EXCEEDED", { tenant }, "over the cap");
      reserved += 1;
    },
    release: () => {
      reserved -= 1;
    },
    settle: () => {},
    usage: () => ({ runs: reserved, usd: 0, tokens: 0 }),
    reserved: () => reserved,
  };
  return tracker;
}

// A deployment whose registry knows no runtime, so no lane can judge and NOTHING is placed. That is the
// interesting path for the release half: an admitted reservation with no container behind it.
const access = (b: BudgetTracker) =>
  buildRuntimeAccess({
    runtimeRegistry: { get: async () => undefined, list: async () => [] } as never,
    runtimeSecretsFor: async () => ({}),
    runtimeBuildBackend: () => ({}) as never,
    admitVerifierCompute: b,
  });

// ── …AND A SLOT, NOT ONLY A BUDGET (arch-review 60 P1-high) ─────────────────────────────────────────
//
// The budget gate limits SPEND — cumulative usd/tokens/run-count. It says nothing about how many containers a
// tenant may hold at once, and those are different questions. So a batch with budget headroom placed its
// agent halves through the Scheduler's capacity and fairness, and then submitted every verifier straight at
// the backend: the judging half doubled the fleet's container count against limits it never consulted.
//
// Not a second queue. `AdmissionLedger` is the fleet-wide atomic per-tenant permit the Scheduler already
// claims for exactly this, so the two halves draw on ONE pool rather than two accountings that must agree.
//
// Seen RED before the slot existed, observed:
//   a second verifier was placed while the workspace was at its concurrency limit: expected NotFoundError
//   (it went straight on to resolve a lane) to match { code: 'RATE_LIMITED' }

// ── …AND THE DEFAULT DEPLOYMENT IS THE ONE THAT MUST WORK (arch-review 61 P0) ───────────────────────
//
// `quotaFor` answers `Number.POSITIVE_INFINITY` when no tenant quota is configured — the default. The
// verifier lane bound that straight into the Pg ledger's `in_flight < $3` against an `integer` column, and
// Postgres answers `invalid input syntax for type integer: "Infinity"` (verified against a real one). The
// acquisition sat OUTSIDE the try, so the throw skipped the release:
//
//     budget.admit()      runs +1
//     tryAdmit(Infinity)  THROWS
//     budget.release()    never runs
//     verifier            never dispatched → tests_pass: unmeasured
//
// On Postgres, with no `EVERDICT_TENANT_QUOTAS` set, that was EVERY private-verifier case: the verdict lost
// and the workspace's run count permanently incremented, so a run budget eventually 402s it for verifiers
// that never existed. The Scheduler never had this — it asks `Number.isFinite(quota)` first — and two
// admission paths spelling one precondition differently is the shape rule `backends` names.
//
// Seen RED before the finite question and the single `finally`, observed:
//   a default deployment could not place a verifier at all: expected [Error: invalid input syntax for type
//   integer: "Infinity"] to be undefined

// ── …AND THE BACKEND'S ENVELOPE, AND A LEASE IT KEEPS (arch-review 61 P1) ───────────────────────────
//
// The tenant permit limits how many executions ONE workspace holds. Two things it does not do:
//
//   BACKEND CAPACITY. `maxConcurrent` is what stops a cluster being handed more work than it has slots, and
//   several tenants each inside their own quota can still put a lane past its total. A batch's verifier
//   fan-out is exactly the shape that does it.
//
//   THE LEASE. The ledger's permit expires after 30 minutes and the Scheduler renews the ones it holds every
//   ten. This lane was handed only `tryAdmit`/`releaseAdmission`, so a verifier running past the lease had
//   its permit reaped while its container kept going, and another execution could claim the slot it still
//   occupied. A capability a holder is not given is a lease it cannot keep.
//
// Seen RED before either, observed:
//   a verifier was placed on a runtime with no free slots: expected 'NOT_FOUND' to be 'RATE_LIMITED'
//   a verifier held a slot it never renewed: expected [] to deeply equal [ 'p1' ]

describe("[R61 COUNTEREXAMPLE] a verifier respects the backend's envelope and keeps its lease", () => {
  const backendAt = (used: number, total: number) => ({
    id: "rt-1",
    capacity: async () => ({ used, total }),
    dispatchVerifier: async () => ({ planDigest: "p", workspaceDigest: "w", scores: [] }),
  });

  const accessWith = (backend: unknown, slots?: unknown) =>
    buildRuntimeAccess({
      runtimeRegistry: {
        get: async () => ({ id: "rt-1", version: "1", kind: "k8s" }),
        list: async () => [],
      } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => backend as never,
      admitVerifierCompute: budget(),
      ...(slots ? { verifierSlots: slots as never } : {}),
    });

  it("REFUSES when the runtime has no free slot, even inside the tenant's quota", async () => {
    const err = await accessWith(backendAt(20, 20))
      .dispatchVerifier(JOB)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((err as { code?: string })?.code, "a verifier was placed on a runtime with no free slots").toBe(
      "RATE_LIMITED",
    );
  });

  it("places when the runtime has room", async () => {
    // The control: refusing a full lane must not cost the ordinary one.
    const out = await accessWith(backendAt(1, 20))
      .dispatchVerifier(JOB)
      .then(() => "placed")
      .catch(() => "refused");
    expect(out).toBe("placed");
  });

  it("RENEWS its permit while the container runs", async () => {
    const renewed: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const slots = {
      ledger: {
        tryAdmit: async () => true,
        releaseAdmission: async () => undefined,
        renewAdmissions: async (ids: string[]) => {
          renewed.push(...ids);
        },
      },
      quotaFor: () => 5,
      newPermitId: () => "p1",
      renewEveryMs: 5, // the lane's own interval, compressed so the test does not wait ten minutes
    };
    const backend = {
      ...backendAt(1, 20),
      dispatchVerifier: async () => {
        await slow;
        return { planDigest: "p", workspaceDigest: "w", scores: [] };
      },
    };

    const inflight = accessWith(backend, slots)
      .dispatchVerifier(JOB)
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 40));
    release();
    await inflight;

    expect(renewed, "a verifier held a slot it never renewed").toContain("p1");
  });
});

describe("[R61 COUNTEREXAMPLE] the default deployment places a verifier, and releases what it took", () => {
  // The Pg ledger's own precondition, as a fake: an integer column cannot be compared with Infinity.
  const integerColumnLedger = () => {
    const held = new Set<string>();
    return {
      held,
      ledger: {
        tryAdmit: async (_t: string, permitId: string, quota: number) => {
          if (!Number.isInteger(quota)) throw new Error(`invalid input syntax for type integer: "${quota}"`);
          if (held.size >= quota) return false;
          held.add(permitId);
          return true;
        },
        releaseAdmission: async (permitId: string) => {
          held.delete(permitId);
        },
      },
    };
  };

  const access = (b: BudgetTracker, slots: ReturnType<typeof integerColumnLedger>, quota: number) =>
    buildRuntimeAccess({
      runtimeRegistry: { get: async () => undefined, list: async () => [] } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => ({}) as never,
      admitVerifierCompute: b,
      verifierSlots: { ledger: slots.ledger, quotaFor: () => quota, newPermitId: () => "p1" },
    });

  it("claims NO fleet slot when the workspace has no quota — the default", async () => {
    const slots = integerColumnLedger();
    const b = budget();
    const err = await access(b, slots, Number.POSITIVE_INFINITY)
      .dispatchVerifier(JOB)
      .then(() => undefined)
      .catch((e: unknown) => e);

    // It gets as far as resolving a lane — which finds none in this fixture — rather than dying on the quota.
    expect((err as { code?: string })?.code, "a default deployment could not place a verifier at all").toBe(
      "NOT_FOUND",
    );
    expect(slots.held.size, "an unlimited quota still claimed a fleet permit").toBe(0);
    expect(b.reserved(), "the budget reservation leaked on the default path").toBe(0);
  });

  it("RELEASES the budget when the ledger throws", async () => {
    // A transient ledger failure is neither a refusal nor an admission. What must not happen is the budget
    // staying held for a verifier that never ran (rule `protocol` L2 — and L1 on what a failed acquisition
    // owes back).
    const slots = integerColumnLedger();
    const b = budget();
    // A FINITE quota, so the guard does consult the ledger, and a ledger that will not answer.
    const outage = {
      held: slots.held,
      ledger: {
        tryAdmit: async () => {
          throw new Error("could not connect to the admission ledger");
        },
        releaseAdmission: async () => undefined,
      },
    } as unknown as ReturnType<typeof integerColumnLedger>;
    const err = await access(b, outage, 5)
      .dispatchVerifier(JOB)
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect((err as { code?: string })?.code, "a ledger outage was reported as a quota refusal").toBe("UPSTREAM_ERROR");
    expect(b.reserved(), "a verifier that never ran kept its budget reservation").toBe(0);
    expect(slots.held.size).toBe(0);
  });

  it("still REFUSES at a real limit, and still releases", async () => {
    // The finite path must keep working: the fix is about unlimited quotas and unwinding, not about admitting
    // everything.
    const slots = integerColumnLedger();
    const b = budget();
    await slots.ledger.tryAdmit("acme", "agent-half", 1);
    const err = await access(b, slots, 1)
      .dispatchVerifier(JOB)
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("RATE_LIMITED");
    expect(b.reserved(), "a refused verifier kept its budget reservation").toBe(0);
  });
});

describe("[R60 COUNTEREXAMPLE] a verifier draws a slot from the same pool the agent's half did", () => {
  // A ledger with room for exactly one in-flight execution per tenant — the Scheduler's own primitive.
  function ledgerWithQuotaOne() {
    const held = new Set<string>();
    return {
      held,
      ledger: {
        tryAdmit: async (_tenant: string, permitId: string, quota: number) => {
          if (held.size >= quota) return false;
          held.add(permitId);
          return true;
        },
        releaseAdmission: async (permitId: string) => {
          held.delete(permitId);
        },
      },
    };
  }

  const accessWithSlots = (b: BudgetTracker, slots: ReturnType<typeof ledgerWithQuotaOne>, placed: string[]) =>
    buildRuntimeAccess({
      runtimeRegistry: {
        get: async () => {
          placed.push("resolve-lane");
          return undefined;
        },
        list: async () => [],
      } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => ({}) as never,
      admitVerifierCompute: b,
      verifierSlots: {
        ledger: slots.ledger,
        quotaFor: () => 1,
        newPermitId: () => `verify-${placed.length}-${Math.floor(performance.now() * 1000)}`,
      },
    });

  it("REFUSES a second verifier while the workspace is at its concurrent-execution limit", async () => {
    const slots = ledgerWithQuotaOne();
    const b = budget();
    // Someone already holds the tenant's only slot — an agent half placed through the Scheduler.
    await slots.ledger.tryAdmit("acme", "agent-half", 1);

    const placed: string[] = [];
    await expect(
      accessWithSlots(b, slots, placed).dispatchVerifier(JOB),
      "a second verifier was placed while the workspace was at its concurrency limit",
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // …and it never reached a lane, so no container was created to be limited after the fact.
    expect(placed, "the verifier resolved a backend despite having no slot").toHaveLength(0);
    // …and the budget reservation it took on the way in went back, or a refused verifier would 402 the
    // workspace later for compute it never held.
    expect(b.reserved(), "a refused verifier kept its budget reservation").toBe(0);
  });

  it("RELEASES the slot when the dispatch is over", async () => {
    // A permit held past the container is a tenant limited by its own history. The lane below resolves no
    // runtime, so nothing is placed at all — which is precisely the path a leak would hide in.
    const slots = ledgerWithQuotaOne();
    const placed: string[] = [];
    await accessWithSlots(budget(), slots, placed)
      .dispatchVerifier(JOB)
      .catch(() => undefined);
    expect(slots.held.size, "the verifier's slot was never given back").toBe(0);
  });

  it("admits when a deployment has no ledger at all — absence is single-replica, not a bypass", async () => {
    // The ledger is what makes the limit fleet-wide. A deployment without one is the single-process case and
    // must keep working; making its absence a refusal would break every local run.
    const b = budget();
    await expect(
      buildRuntimeAccess({
        runtimeRegistry: { get: async () => undefined, list: async () => [] } as never,
        runtimeSecretsFor: async () => ({}),
        runtimeBuildBackend: () => ({}) as never,
        admitVerifierCompute: b,
      }).dispatchVerifier(JOB),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("[R59 COUNTEREXAMPLE] a verifier's compute is admitted before it exists", () => {
  it("REFUSES to place a verifier for a workspace over its budget", async () => {
    const b = budget({ refuse: true });
    await expect(
      access(b).dispatchVerifier(JOB),
      "a verifier container was created for a workspace over its budget",
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("admits BEFORE resolving a lane, not after the container exists", async () => {
    // The ordering is the whole gate. Admitting after the dispatch would report the 402 about compute that
    // has already been spent, which is a bill rather than a limit.
    const order: string[] = [];
    const b = budget();
    const spy: BudgetTracker = {
      ...b,
      admit: (t: string) => {
        order.push("admit");
        b.admit(t);
      },
    };
    await buildRuntimeAccess({
      runtimeRegistry: {
        get: async () => {
          order.push("resolve-lane");
          return undefined;
        },
        list: async () => [],
      } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => ({}) as never,
      admitVerifierCompute: spy,
    })
      .dispatchVerifier(JOB)
      .catch(() => undefined);

    // Both steps must actually have run: asserting only `order[0] === "admit"` would also pass if the lane
    // were never resolved at all, which is a green over a path this test never took (rule `testing`).
    expect(order, "a lane was resolved before the tenant was admitted").toEqual(["admit", "resolve-lane"]);
  });

  it("RELEASES the reservation when no lane could judge", async () => {
    // Nothing was placed, so holding the reservation would permanently inflate the tenant's run count and
    // eventually 402 them for containers that never existed — the exact failure the scheduler's own ordering
    // comment describes, one lane over.
    const b = budget();
    await access(b)
      .dispatchVerifier(JOB)
      .catch(() => undefined);
    expect(b.reserved(), "a reservation for a verifier that never ran was never released").toBe(0);
  });
});
