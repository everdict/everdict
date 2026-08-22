import type { CaseJob, RuntimeWorkRef } from "@everdict/contracts";
import { MAY_STILL_CREATE_WORK, mayStillCreateWork } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sBackend, buildK8sJob } from "./k8s.js";
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

// The K8s authority, recording the transition so the ORDER around the inert object is observable.
const recordingAuthority = (order: string[]) => ({
  reserve: async (work: RuntimeWorkRef) => ({ attemptId: "a1", work, persistedAt: new Date(0).toISOString() }),
  activate: async () => {
    order.push("activate");
    return { kind: "activate" as const };
  },
});

// A cluster that records the order of everything, and stops right after the object is born.
function k8sApi(order: string[]) {
  return {
    async ensureNamespace() {},
    async patchOwnedByJob() {},
    async applyJob(m: { kind?: string }) {
      if (m.kind === "NetworkPolicy") return;
      order.push("apply(inert)");
    },
    async resumeJob() {
      order.push("resume");
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
      .dispatch(JOB(), { authority: recordingAuthority(order), onStarted: () => order.push("started") })
      .catch(() => undefined);

    // ── AND THE OBJECT COMES FIRST (arch-review 60 P0 follow-through) ──────────────────────────────
    //
    // Activating immediately before the apply narrowed the window to one call and did not remove it. The Job
    // is created INERT (`suspend: true` — it exists, it is addressable, it creates no pods), the reservation
    // is re-presented against an object a teardown can already find, and only then is it made runnable. A
    // cancellation probing in that window can no longer truthfully answer ABSENT.
    expect(order, "the ledger said this attempt was executing before any object existed").toEqual([
      "apply(inert)",
      "activate",
      "resume",
      "started",
    ]);
  });

  it("Nomad: the same", async () => {
    const order: string[] = [];
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "runner:1",
      http: {
        request: async (method: string, path: string, body?: unknown) => {
          if (method === "POST" && path === "/v1/jobs") {
            // The COUNT is what says whether this registration can run anything — see the Nomad half of the
            // inert protocol (arch-review 61 P0).
            const count = (body as { Job: { TaskGroups: Array<{ Count: number }> } }).Job.TaskGroups[0]?.Count;
            order.push(count === 0 ? "register(inert)" : "start");
            // A register REPORTS the version it produced, as the real cluster does — the start carries it
            // back as `EnforceIndex` so it can never create the job it is meant to be starting
            // (arch-review 62 P0). A fake that answered `{}` was more permissive than Nomad, which is the
            // shape that leaves a production branch unverified.
            return { status: 200, text: JSON.stringify({ JobModifyIndex: 1 }) };
          }
          // Whatever the poll asks next, this dispatch is over as far as the ordering question goes.
          throw new Error("stop after the birth");
        },
      },
    } as never);

    await backend
      .dispatch(JOB(), { authority: recordingAuthority(order), onStarted: () => order.push("started") })
      .catch(() => undefined);

    // ── AND THE OBJECT COMES FIRST HERE TOO (arch-review 61 P0) ────────────────────────────────────
    //
    // This lane kept `activate → submit` when K8s moved to inert-first, so a submitter paused across that
    // call could still create its job after a cancellation had killed nothing, probed absent and certified
    // zero. Registered at `Count: 0` now — the job exists, `killWork` can delete exactly it, and Nomad
    // schedules no allocation — and only an authorized dispatch re-registers it at one.
    expect(order, "the ledger said this attempt was executing before any object existed").toEqual([
      "register(inert)",
      "activate",
      "start",
      "started",
    ]);
  });

  it("the Job is APPLIED inert — the ordering is worth nothing if the object can already run", () => {
    // The mutation that found this gap: flipping `suspend` in the manifest leaves the call ORDER untouched,
    // so a test that only watches apply/activate/resume stays green over a Job that was runnable the moment
    // it existed. The order and the inertness are two claims and both need asserting.
    const spec = buildK8sJob(JOB(), { image: "runner:1" }, "evd-c1", "ns") as { spec: { suspend?: boolean } };
    expect(spec.spec.suspend, "the Job could create pods before its authority was re-presented").toBe(true);
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
