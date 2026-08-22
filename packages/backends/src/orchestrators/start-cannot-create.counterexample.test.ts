import type { CaseJob, RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { NomadBackend } from "./nomad.js";

// ── THE SAME CALL SEQUENCE IS NOT THE SAME EFFECT (arch-review 62 P0) ────────────────────────────────
//
// Both managed lanes end up spelled `create inert → activate → start`, and the previous review's
// counterexample asserted exactly that order on each of them, and both were green. They do not mean the same
// thing:
//
//     K8s   start = PATCH the existing Job (`resumeJob`)  → a deleted Job makes the patch FAIL
//     Nomad start = POST /v1/jobs                         → a deleted job is silently RE-CREATED, and runs
//
// `POST /v1/jobs` is Nomad's register, and register is create-or-update. So the interleaving the inert phase
// was introduced to close reopened one call later, on one lane only:
//
//     dispatch:     register W at Count:0 · activate W · PAUSE
//     cancellation: revoke the reservation · DELETE W · probe W → absent · CERTIFY ZERO
//     dispatch:     wake · POST W at Count:1 → the job is created again, and this time it runs
//
// The certificate of zero is followed by a birth, which is the exact thing the phase exists to make
// impossible. Holding an activation is not the same as being allowed to act on it — the activation was
// granted against an object that no longer exists, and re-presenting it before the POST does not help: the
// window simply moves to between that check and the POST.
//
// What closes it is the orchestrator's own version fence. The inert registration answers a `JobModifyIndex`,
// and the start carries it as `EnforceIndex`, so Nomad itself refuses to apply the update unless the object
// is still exactly the one this dispatch made. A purged job has no index to match, so the refusal is the
// cluster's, not a check of ours that a pause can straddle.
//
// Seen RED before the fence, observed:
//   a start recreated the job a cancellation had already deleted: expected 'created-at-1' to be undefined

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

// A Nomad that a cancellation empties the moment the dispatch has its activation — the interleaving the
// ordering assertion cannot see, because the ORDER is unchanged and only the world underneath it moved.
function cancellingNomad(state: { jobs: Map<string, number>; events: string[] }) {
  return {
    request: async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/v1/jobs") {
        const job = (body as { Job: { ID: string; TaskGroups: Array<{ Count: number }>; JobModifyIndex?: number } })
          .Job;
        const count = job.TaskGroups[0]?.Count ?? 0;
        const enforce = (body as { EnforceIndex?: boolean }).EnforceIndex === true;
        const expected = (body as { JobModifyIndex?: number }).JobModifyIndex;
        const live = state.jobs.get(job.ID);
        // Nomad's own semantics: with EnforceIndex, the register applies only when the caller's index matches
        // the job's current one — and a job that is gone has no index, so the enforced value cannot match.
        if (enforce && live !== expected) {
          state.events.push(`refused-at-${count}`);
          return { status: 500, text: "enforcing index 0: job not found" };
        }
        state.events.push(live === undefined ? `created-at-${count}` : `updated-at-${count}`);
        state.jobs.set(job.ID, (live ?? 0) + 1);
        return { status: 200, text: JSON.stringify({ JobModifyIndex: state.jobs.get(job.ID) }) };
      }
      if (method === "DELETE") {
        const id = decodeURIComponent(path.split("/v1/job/")[1]?.split("?")[0] ?? "");
        state.jobs.delete(id);
        state.events.push("deleted");
        return { status: 200, text: "{}" };
      }
      // The dispatch is over as far as this question goes once the start has been decided.
      throw new Error("stop after the start");
    },
  };
}

const backend = (http: ReturnType<typeof cancellingNomad>) =>
  new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never);

describe("[R62 COUNTEREXAMPLE] a Nomad start can never create the job it is starting", () => {
  it("REFUSES to run after a cancellation deleted the inert registration", async () => {
    const state = { jobs: new Map<string, number>(), events: [] as string[] };
    const authority = {
      ...AUTHORITY,
      // The cancellation lands here: it has revoked the reservation and removed the object, and this
      // dispatch is about to wake up holding an activation for something that no longer exists.
      activate: async () => {
        for (const id of [...state.jobs.keys()]) state.jobs.delete(id);
        state.events.push("deleted");
        return { kind: "activate" as const };
      },
    };

    await backend(cancellingNomad(state))
      .dispatch(JOB(), { authority, onStarted: () => state.events.push("started") })
      .catch(() => undefined);

    expect(
      state.events.filter((e) => e.startsWith("created-at-1")),
      "a start recreated the job a cancellation had already deleted",
    ).toHaveLength(0);
    // …and specifically: the cluster refused it, so nothing ran and nothing was reported started.
    expect(state.events).toEqual(["created-at-0", "deleted", "refused-at-1"]);
    expect(state.jobs.size, "the cancellation's certificate of zero was made false").toBe(0);
  });

  it("still STARTS the job when nothing removed it — the fence must not cost the dispatch", async () => {
    // The control. A version fence that refuses the ordinary path would be a worse defect than the one it
    // closes, and this file would otherwise pass because dispatch stopped working entirely.
    const state = { jobs: new Map<string, number>(), events: [] as string[] };
    await backend(cancellingNomad(state))
      .dispatch(JOB(), { authority: AUTHORITY, onStarted: () => state.events.push("started") })
      .catch(() => undefined);

    expect(state.events).toEqual(["created-at-0", "updated-at-1", "started"]);
  });
});
