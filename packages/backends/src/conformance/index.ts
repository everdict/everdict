import { type KillOutcome, type PersistedWorkIntent, type RuntimeWorkRef, killConverged } from "@everdict/contracts";
// ── ONE SUITE, EVERY IMPLEMENTATION (arch-review 53, Wave F) ────────────────────────────────────────
//
// Every protocol this program introduced is a claim about ALL implementations of a port, and until now each
// implementation was certified by its own hand-written file. That is how `onWork` came to be threaded in the
// in-process driver and absent in the Temporal one for a whole wave, and how the K8s and Nomad kills drifted
// apart before Wave 2 pulled them back: nothing forced the same questions to be asked of both.
//
// A conformance suite is a FUNCTION OVER AN IMPLEMENTATION. Adding a backend means running the suite; changing
// a protocol means changing the suite once rather than remembering every adapter that implements it. The
// suites take a factory rather than an instance so each case gets a clean world — a suite that shared one
// backend across cases would let an earlier case's state decide a later one's verdict.
//
// They are exported from a non-test module on purpose: an adapter in another package imports and calls them,
// and a `.test.ts` file cannot be imported across package boundaries.
import { describe, expect, it } from "vitest";
import type { Backend } from "../backend.js";

// What a managed backend must hand a conformance suite: a fresh backend, the job to dispatch, and a record of
// what the fake cluster was asked to do. `effects` is append-only and ordered — the ORDER is what several of
// these protocols are about, so a harness that reported a set would make them unfalsifiable.
export interface ManagedDispatchWorld {
  backend: Backend;
  job: Parameters<Backend["dispatch"]>[0];
  // Every call the fake cluster received, in order — e.g. `["apply", "wait"]`.
  effects: string[];
}

// ── ManagedDispatchConformance — identity before effect (Wave A) ────────────────────────────────────
export function describeManagedDispatch(name: string, world: () => ManagedDispatchWorld): void {
  describe(`${name} — managed dispatch conformance`, () => {
    it("can name the work it is about to create, without creating it", async () => {
      const { backend, job } = world();
      const reserve = (backend as { reserve?: (j: unknown) => Promise<RuntimeWorkRef> }).reserve;
      expect(typeof reserve, "a managed backend must be able to NAME its work without creating it").toBe("function");
      const reserved = await reserve?.call(backend, job);
      expect(reserved?.externalJobId, "the reservation must carry the exact external id").toBeTruthy();
    });

    it("reports the handle BEFORE the external object exists", async () => {
      const { backend, job, effects } = world();
      await backend
        .dispatch(job, {
          onReserved: async (work) => {
            effects.push("reserved");
            return persisted(work);
          },
        })
        .catch(() => undefined);
      expect(
        effects[0],
        "the handle is reported after the effect — a crash in between leaves work nothing can address",
      ).toBe("reserved");
    });

    it("a rejecting onReserved consumer aborts the dispatch before anything is created", async () => {
      const { backend, job, effects } = world();
      await backend
        .dispatch(job, {
          onReserved: () => {
            throw new Error("ledger down");
          },
        })
        .catch(() => undefined);
      expect(
        effects,
        "the cluster was asked for work whose handle nobody could record — an unaddressable job is not a successful dispatch",
      ).toEqual([]);
    });

    // ── The rung ordering alone could not reach (arch-review 54, Phase 1) ────────────────────────────
    //
    // The two above prove the SEQUENCE. They pass just as happily when the hook writes nothing, because a
    // hook that resolves and a hook that persisted are the same observation from the backend's side. These
    // two make the store's answer the thing that licenses the effect.
    it("refuses to create work for a tracked run when no reservation hook is wired", async () => {
      const { backend, job, effects } = world();
      await backend.dispatch(job).catch(() => undefined);
      expect(
        effects,
        "a job that names a run was placed with nobody recording where — the handle exists only in a dead process's memory",
      ).toEqual([]);
    });

    it("refuses to create work when the reservation hook returns no proof", async () => {
      const { backend, job, effects } = world();
      await backend.dispatch(job, { onReserved: (async () => undefined) as never }).catch(() => undefined);
      expect(
        effects,
        "the hook resolved without persisting anything and the dispatch proceeded — 'it returned' is not 'it was written down'",
      ).toEqual([]);
    });
  });
}

// The proof a conformance world hands back when it is playing the part of a working ledger. Built from the
// handle the backend just reported, because that is what a real reservation returns: the row as persisted.
function persisted(work: RuntimeWorkRef): PersistedWorkIntent {
  return {
    attemptId: work.attemptId ?? `${work.runId}#g1`,
    work,
    persistedAt: "2026-08-18T00:00:00.000Z",
  };
}

// ── RuntimeWorkControlConformance — exact addressing is the default (Wave B) ────────────────────────
export function describeRuntimeWorkControl(name: string, backendOf: () => Backend): void {
  describe(`${name} — runtime work control conformance`, () => {
    it("implements the whole exact-work surface, or none of it", () => {
      const backend = backendOf() as unknown as Record<string, unknown>;
      // `probeWork` joins the all-or-none set (arch-review 56, Wave G): a lane that can stop work and cannot
      // read back whether it went away converges its cancellations on an accepted delete.
      const methods = [
        "adoptWork",
        "logsForWork",
        "eventsForWork",
        "execInWork",
        "inspectWork",
        "sampleWork",
        "probeWork",
      ];
      const present = methods.filter((m) => typeof backend[m] === "function");
      // All or nothing: a partial implementation puts a caller back to guessing which reads are exact, which
      // is the state Wave B exists to end.
      expect(present.length === 0 || present.length === methods.length, `partial: ${present.join(", ")}`).toBe(true);
    });
  });
}

// ── UnknownPropagationConformance — a failed read is not an empty set (Wave A.5) ────────────────────
export function describeUnknownPropagation(name: string, killWithUnreadableCluster: () => Promise<KillOutcome>): void {
  describe(`${name} — unknown propagation conformance`, () => {
    it("a stop that could not reach the cluster never reports convergence", async () => {
      const outcome = await killWithUnreadableCluster();
      // The rung decides WHICH non-converged answer: a listing that failed is `unknown` (a sweep that
      // learned nothing stopped nothing), an unreachable cluster is `failed` (the orchestrator's own words).
      // What no implementation may do is answer `stopped` or `absent` — that is the substitution the whole
      // wave exists to remove, and it is the claim a conformance suite can make about every adapter.
      expect(
        killConverged(outcome),
        `a teardown that reached no cluster certified convergence (${outcome.status})`,
      ).toBe(false);
    });
  });
}

// The publication and cancellation suites live in `@everdict/application-control` (`src/conformance`), with
// the ports they certify. They are not here for the reason the dependency cone gives: backends DEPENDS on
// application-control, so a suite here that its ports' implementations had to import would be a reverse edge.
