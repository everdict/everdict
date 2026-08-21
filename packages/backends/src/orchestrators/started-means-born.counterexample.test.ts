import type { CaseJob, RuntimeWorkRef } from "@everdict/contracts";
import { MAY_STILL_CREATE_WORK, mayStillCreateWork } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sBackend } from "./k8s.js";
import { NomadBackend } from "./nomad.js";

// ── A LIFECYCLE STAMP NAMES AN OBSERVED FACT (arch-review 60 P0) ─────────────────────────────────────
//
// `onStarted` flips the run queued→running AND stamps the attempt `executing`. Both managed lanes fired it
// before anything existed in the cluster:
//
//     reserve → activate → onStarted (→ executing) → ensureNamespace → NetworkPolicy → applyJob
//
// The cancellation reads attempt state to decide what may still be BORN — killing handles and probing them
// absent answers "nothing is running", never "nothing can start". Its guard covered `reserved` (revoke it)
// and `active` (stay owed inside the lease), and an attempt already stamped `executing` fell through both:
//
//     dispatch: reserve · activate · stamp executing · PAUSE (no object yet)
//     cancel:   kill W → absent · probe W → absent · no reserved · no active · CERTIFY ZERO
//     dispatch: resume · applyJob
//
// A certificate of zero followed by a birth — the exact thing the previous wave's `active` guard was added
// to stop, escaping through the state one transition later. The stamp was not wrong about the future; it was
// wrong about the TENSE, and a guard that consumes state needs statements about what has happened.
//
// So `executing` is stamped after the create returns, and the birth guard consumes ONE owned list
// (`MAY_STILL_CREATE_WORK`) instead of spelling a subset that a growing state machine outruns.
//
// Seen RED with the stamp put back before the submit, on each lane in turn, observed:
//   the ledger said this attempt was executing before any object existed: expected
//   [ 'started', 'apply(job)', 'started' ] to deeply equal [ 'apply(job)', 'started' ]

const JOB = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60, tags: [] },
  }) as unknown as CaseJob;

const AUTHORITY = {
  reserve: async (work: RuntimeWorkRef) => ({ attemptId: "a1", work, persistedAt: new Date(0).toISOString() }),
  activate: async () => ({ kind: "activate" as const }),
};

// A cluster that records the order of everything, and stops right after the object is born.
function k8sApi(order: string[]) {
  return {
    async ensureNamespace() {},
    async patchNetworkPolicy() {},
    async applyJob(m: { kind?: string }) {
      if (m.kind === "NetworkPolicy") return;
      order.push("apply(job)");
    },
    // The object now exists, which is the whole precondition under test; the dispatch stops at the first poll
    // rather than here, because an apply that THREW must not report started and would hide the ordering.
    async jobStatus(): Promise<{ status: "succeeded" }> {
      throw new Error("stop after the birth");
    },
    async podLogs() {
      return "";
    },
    async deleteJob() {
      return { status: "stopped" as const };
    },
    async podsForJob() {
      return [];
    },
    async namespaceEvents() {
      return [];
    },
  };
}

describe("[R60 COUNTEREXAMPLE] a run is 'started' only once its external object exists", () => {
  it("K8s: stamps started AFTER the Job is applied", async () => {
    const order: string[] = [];
    const backend = new K8sBackend({ image: "runner:1", api: k8sApi(order) } as never);

    await backend
      .dispatch(JOB(), { authority: AUTHORITY, onStarted: () => order.push("started") })
      .catch(() => undefined);

    expect(order, "the ledger said this attempt was executing before any object existed").toEqual([
      "apply(job)",
      "started",
    ]);
  });

  it("Nomad: the same", async () => {
    const order: string[] = [];
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "runner:1",
      http: {
        request: async (method: string, path: string) => {
          if (method === "POST" && path === "/v1/jobs") {
            order.push("apply(job)");
            return { status: 200, text: "{}" };
          }
          // Whatever the poll asks next, this dispatch is over as far as the ordering question goes.
          throw new Error("stop after the birth");
        },
      },
    } as never);

    await backend
      .dispatch(JOB(), { authority: AUTHORITY, onStarted: () => order.push("started") })
      .catch(() => undefined);

    expect(order, "the ledger said this attempt was executing before any object existed").toEqual([
      "apply(job)",
      "started",
    ]);
  });

  it("the birth guard's state set has ONE owner, and it includes every pre-birth state", () => {
    // The other half. Moving the stamp is only correct if the guard covers everything that can still cause a
    // birth — and the previous version spelled `reserved`/`active` inline, which a growing machine outran.
    for (const state of ["created", "reserved", "active"] as const)
      expect(mayStillCreateWork(state), `${state} can still create an external object`).toBe(true);
    // …and NOT the states where the object either exists or never will: those are the handle's problem, and
    // treating them as unborn would make a teardown wait forever on work it can already address.
    for (const state of ["executing", "committed", "failed", "revoked", "superseded"] as const)
      expect(mayStillCreateWork(state), `${state} is not a pre-birth state`).toBe(false);
    expect(MAY_STILL_CREATE_WORK).toHaveLength(3);
  });
});
