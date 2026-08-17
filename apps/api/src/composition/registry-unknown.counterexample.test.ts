import type { KillOutcome, RuntimeSpec, RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildRuntimeAccess } from "./runtime-access.js";

// ── A REGISTRY OUTAGE IS NOT AN EMPTY CLUSTER (arch-review 53, Wave A.5) ─────────────────────────────
//
// `eachRuntimeBackend` resolves the lane's runtimes with `runtimeRegistry.get(...).catch(() => undefined)`
// and then `if (!spec) continue`. Two situations collapse into one there: the tenant deregistered the
// runtime (a real absence), and the registry could not be read (a database blip, a network partition,
// a Postgres failover). Both skip the lane silently.
//
// The consequence is downstream and total. `killWork` collects the per-backend outcomes and folds them with
// `worstKillOutcome(outcomes)` — and `worstKillOutcome([])` is `{status: "absent"}`, because absent is the
// identity of that fold. So a teardown that reached NO cluster at all, asked NOTHING, and learned NOTHING
// returns a converged answer, and the cancellation operation completes on it.
//
// This is the sharpest form of the whole unknown-propagation defect: the strong `KillOutcome.unknown` value
// exists, is correct, and is unreachable through this seam — there is no code path in which a registry
// failure produces it.
//
// The invariant these pin: a lane that could not be RESOLVED is `unknown`, and a fold over zero outcomes is
// `unknown` rather than `absent` — "I asked nobody" is never "there was nobody".

const WORK: RuntimeWorkRef = {
  tenant: "acme",
  runId: "evd-run-1",
  externalJobId: "everdict-c1-aaaa",
  namespace: "everdict-acme",
};

const spec = (id: string): RuntimeSpec =>
  ({ id, version: "1", kind: "nomad", addr: "http://nomad:4646" }) as unknown as RuntimeSpec;

// RED as of 186f9fd9: `expected 'absent' to be 'unknown'` — the registry threw, no backend was built, and the
// empty fold certified that the work is gone.
describe("[R53 WAVE-A.5 COUNTEREXAMPLE #25 — CLOSED] a kill that reached no cluster is not a converged kill", () => {
  it("reports unknown when the runtime registry could not be read", async () => {
    const access = buildRuntimeAccess({
      runtimeRegistry: {
        async get() {
          throw new Error("runtime registry unavailable");
        },
      },
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => {
        throw new Error("never built — the registry read failed first");
      },
    } as never);

    const outcome: KillOutcome = await access.killWork("acme", "nomad-1", WORK);

    expect(outcome.status, "a registry outage certified that live work is absent").toBe("unknown");
  });
});

// RED as of 186f9fd9: same fold, reached through the case-id arm — the legacy lane certifies just as falsely.
describe("[R53 WAVE-A.5 COUNTEREXAMPLE #26 — CLOSED] the case-id fallback reports unknown for the same reason", () => {
  it("does not certify absence when no lane could be resolved", async () => {
    const access = buildRuntimeAccess({
      runtimeRegistry: {
        async get() {
          throw new Error("runtime registry unavailable");
        },
      },
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => {
        throw new Error("never built");
      },
    } as never);

    const outcome: KillOutcome = await access.killCase("acme", "nomad-1", "c1");

    expect(outcome.status).toBe("unknown");
  });
});

// RED as of 186f9fd9: a backend that cannot answer is skipped, and the skip is invisible in the fold.
describe("[R53 WAVE-A.5 COUNTEREXAMPLE #27 — CLOSED] a lane that answered nothing is counted as unknown", () => {
  it("a resolvable runtime whose backend is not work-addressable does not silently converge", async () => {
    const built = vi.fn(() => ({ id: "nomad-1", async dispatch() {}, async capacity() {} }) as never);
    const access = buildRuntimeAccess({
      runtimeRegistry: {
        async get() {
          return spec("nomad-1");
        },
      },
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: built,
    } as never);

    const outcome: KillOutcome = await access.killWork("acme", "nomad-1", WORK);

    // The backend exists and cannot be asked. That is not the same as asking and being told "gone".
    expect(outcome.status, "an unaskable backend was folded away into absent").toBe("unknown");
  });
});
