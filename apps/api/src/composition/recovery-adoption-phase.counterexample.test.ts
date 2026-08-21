import type { RecoveryTarget } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { DeferredRecoverySweep, recoverStandaloneRun } from "./runtime-access.js";

// ── THE RETRY RE-RUNS THE TRANSITION, NOT ITS LAST LINE (arch-review 59 P0-lifecycle) ────────────────
//
// Boot recovery for a standalone run is a PHASE, not a call: read the ledger's work handles, adopt each one
// EXACTLY, and only then resume — with `retry_later` at each step where the answer was "we could not find
// out". That is the whole reason a run whose cluster read failed is deferred rather than decided about.
//
// The periodic sweep was wired to the last line of it:
//
//     resumeRun: (r, authority) => deps.service.resume(r, undefined, authority)
//
// `undefined` is the adopted result. So a run deferred BECAUSE the cluster would not say whether its job was
// live came back sixty seconds later and skipped the question entirely, entering the non-adopt path — which
// re-dispatches. The compute that was live the whole time is now running twice, billed twice, and writing
// competing evidence, and the ledger says the retry succeeded.
//
// Two owners assembling the same transition is the shape: boot composed read → adopt → resume, the sweep
// composed resume, and nothing said they were meant to be the same thing. One function, called by both.
//
// Seen RED with the sweep wired to `service.resume` directly, observed:
//   the periodic retry re-dispatched a run without asking the cluster whether its work was still live:
//   expected [] to deeply equal [ 'adopt' ]

const target = (id: string): RecoveryTarget =>
  ({ kind: "run", id, authority: { ownerReplica: "r1", epoch: 1 }, attempts: 1 }) as unknown as RecoveryTarget;

const RECORD = { id: "r1", tenant: "acme", status: "running", ownerReplica: "r1", ownerEpoch: 1 };

// A world that records which recovery phases ran, and whose cluster answers whatever the test says.
function world(opts: { adopt: "adopted" | "unknown"; phases: string[] }) {
  const { phases } = opts;
  return {
    scorecardStore: { get: async () => undefined },
    store: { get: async () => RECORD },
    owner: "r1",
    replicas: { alive: async () => [] },
    scorecardService: { resume: async () => ({ kind: "resumed" }) },
    service: {
      resume: async (_r: unknown, adopted: unknown) => {
        phases.push(adopted === undefined ? "resume(no-adoption)" : "resume(adopted)");
        return { kind: "resumed" };
      },
    },
    workHandlesFor: async () => {
      phases.push("handles");
      return [{ tenant: "acme", runId: "r1", externalJobId: "job-1" }];
    },
    adoptWorkFn: async () => {
      phases.push("adopt");
      return opts.adopt === "adopted"
        ? {
            kind: "adopted",
            adopted: { stage: "case", result: { caseId: "c1", harness: "h@1", trace: [], scores: [] } },
          }
        : { kind: "unknown", reason: "the cluster would not say" };
    },
  } as unknown as ConstructorParameters<typeof DeferredRecoverySweep>[0];
}

describe("[R59 COUNTEREXAMPLE] a deferred run is re-adopted, not re-dispatched", () => {
  it("asks the cluster again before resuming", async () => {
    const phases: string[] = [];
    const sweep = new DeferredRecoverySweep(world({ adopt: "adopted", phases }), [target("r1")]);
    await sweep.tick();

    expect(
      phases,
      "the periodic retry re-dispatched a run without asking the cluster whether its work was still live",
    ).toEqual(["handles", "adopt", "resume(adopted)"]);
  });

  it("stays OWED when the cluster still cannot say — it does not fall through to a re-drive", async () => {
    // The case the deferral exists for. A second unreadable answer must be a second deferral, not a decision:
    // re-dispatching here is the double-spend, and it is silent.
    const phases: string[] = [];
    const sweep = new DeferredRecoverySweep(world({ adopt: "unknown", phases }), [target("r1")]);
    await sweep.tick();

    expect(phases, "an undecidable adoption fell through to a resume").toEqual(["handles", "adopt"]);
    expect(sweep.outstanding, "a run nobody could decide about was dropped from the worklist").toHaveLength(1);
  });

  it("is the SAME function boot recovery uses", async () => {
    // The property, not an implementation detail: two owners assembling the same transition is how they came
    // apart. Calling it directly is what boot does, and it has to produce the same phases.
    const phases: string[] = [];
    const outcome = await recoverStandaloneRun(
      world({ adopt: "adopted", phases }) as never,
      RECORD as never,
      {
        ownerReplica: "r1",
        epoch: 1,
      } as never,
    );
    expect(phases).toEqual(["handles", "adopt", "resume(adopted)"]);
    expect(outcome.kind).toBe("resumed");
  });
});
