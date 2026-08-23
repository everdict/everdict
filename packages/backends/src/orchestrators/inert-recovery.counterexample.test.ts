import { type AdoptedWork, type RuntimeWorkRef, encodeResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { adoptionStep } from "../backend.js";
import { K8sBackend } from "./k8s.js";
import { NomadBackend } from "./nomad.js";

// ── A PHASE THE WRITER ADDED AND NO READER CAN NAME (arch-review 62 P0) ──────────────────────────────
//
// The previous review closed a birth race by giving external objects an INERT phase: a K8s Job at
// `suspend: true`, a Nomad job at `TaskGroups[].Count: 0`. It exists, `killWork` can delete exactly it,
// `probeWork` can read it, and it schedules nothing. That was verified on live clusters.
//
// Nobody told adoption. `AdoptOutcome` said `adopted | absent | unknown`, so boot recovery — which holds the
// durable handle the dispatch persisted BEFORE it created anything — found the object present and waited for
// it to finish:
//
//     dispatch: reserve W · create W inert · CRASH (before activate/resume)
//     recovery: workHandlesFor → [W] · adoptWork(W) → the Job is there → waitForJob …
//     → a suspended Job never completes → poll exhausted → throw → `unknown`
//     → `retry_later` → the next sweep does exactly the same thing, forever
//
// No owner resumes it, no transition deletes it, and its dependents (the pull Secret, the NetworkPolicy) stay
// with it — a suspended Job is not terminal, so `ttlSecondsAfterFinished` never fires either. The object is
// durable and its continuation is not, which is the distinction the phase was supposed to make impossible:
//
//     the object is born inert   ≠   every owner of that object can recover it
//
// `inert` is a real third answer rather than a rename of `unknown`, and the difference is what makes it worth
// having: `unknown` means compute MAY be burning, so re-driving might double-spend. Inert means nothing has
// been spent — zero pods, zero allocations, both verified against live clusters in arch-review 61 — so
// reclaiming it and re-driving is exactly as safe as `absent`, which is what recovery already does.
//
// Reclaiming is still L5: the answer is `inert` only after a delete that was READ BACK. A delete nobody
// confirmed is a certificate over an object that may yet be resumed by a submitter paused across the crash.
//
// Seen RED before the arm existed, on each lane in turn, observed:
//   a recovery could not tell an object that can never run from one it must wait for: expected 'unknown' to
//   be 'inert'

const WORK: RuntimeWorkRef = { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-c1-aaaa" };

// ── K8s ──────────────────────────────────────────────────────────────────────────────────────────────

// A cluster holding exactly one Job for this handle. `suspended` is what the listing reports, and `deleted`
// records whether the reclaim actually happened.
function k8sApi(opts: { suspended: boolean; deleteFails?: boolean; polls: string[]; deleted: string[] }) {
  return {
    async ensureNamespace() {},
    async applyJob() {},
    async patchOwnedByJob() {},
    async resumeJob() {},
    async jobsByLabel() {
      return [
        {
          name: WORK.externalJobId,
          namespace: "everdict",
          ...(opts.suspended ? { suspended: true } : {}),
        },
      ];
    },
    async jobStatus() {
      // A suspended Job reports neither success nor failure — this is the poll that never converges, and the
      // test's `maxPolls` is what stops it standing in for the real 30 minutes.
      opts.polls.push("jobStatus");
      return { succeeded: 0, failed: 0 };
    },
    async podLogs() {
      // The PRODUCTION encoder, so the control below adopts a document the real reader accepts — a
      // hand-spelled sentinel would make it fail for a reason that has nothing to do with this file.
      return encodeResult({
        caseId: "c1",
        harness: "agent@1",
        trace: [],
        scores: [],
        snapshot: { kind: "prompt", output: "done" },
      });
    },
    async deleteJob(name: string) {
      opts.deleted.push(name);
      return opts.deleteFails
        ? { status: "failed" as const, reason: "the API server refused the delete" }
        : { status: "stopped" as const };
    },
    async podFailureReason() {
      return undefined;
    },
    async podsForJob() {
      return [];
    },
    async namespaceEvents() {
      return [];
    },
  };
}

const k8s = (api: ReturnType<typeof k8sApi>) =>
  new K8sBackend({ image: "runner:1", api, pollIntervalMs: 0, maxPolls: 3 } as never);

describe("[R62 COUNTEREXAMPLE] K8s: an inert Job is recovered, not waited on forever", () => {
  it("answers INERT and reclaims the object", async () => {
    const polls: string[] = [];
    const deleted: string[] = [];
    const outcome = await k8s(k8sApi({ suspended: true, polls, deleted })).adoptWork(WORK);

    expect(outcome.status, "a recovery could not tell an object that can never run from one it must wait for").toBe(
      "inert",
    );
    // …and it did not sit through the poll loop to get there. Reading the phase off the listing is the point:
    // the cluster already said `suspend: true` in the answer recovery had in its hand.
    expect(polls, "the recovery waited on a Job that cannot finish").toHaveLength(0);
    // …and the object is GONE, or the next boot finds the same orphan.
    expect(deleted, "the inert object was classified and then left in the cluster").toEqual([WORK.externalJobId]);
  });

  it("stays UNKNOWN when the reclaim could not be confirmed", async () => {
    // L5: `inert` is a certificate that nothing can come of this object. A delete the API server refused
    // leaves it resumable by a submitter paused across the crash, so the cancellation stays owed.
    const outcome = await k8s(k8sApi({ suspended: true, deleteFails: true, polls: [], deleted: [] })).adoptWork(WORK);
    expect(outcome.status, "an unconfirmed delete was reported as a reclaimed object").toBe("unknown");
  });

  it("still ADOPTS a Job that is actually running", async () => {
    // The control. Teaching adoption the birth phase must not cost it the answer it exists to recover —
    // otherwise this file would pass because adoption stopped working.
    const polls: string[] = [];
    const api = k8sApi({ suspended: false, polls, deleted: [] });
    let done = false;
    api.jobStatus = async () => {
      polls.push("jobStatus");
      const answer = done ? { succeeded: 1, failed: 0 } : { succeeded: 0, failed: 0 };
      done = true;
      return answer;
    };
    const outcome = await k8s(api).adoptWork(WORK);
    expect(outcome.status).toBe("adopted");
    if (outcome.status !== "adopted") throw new Error("unreachable");
    expect(outcome.adopted.stage).toBe("case");
  });
});

// ── Nomad ────────────────────────────────────────────────────────────────────────────────────────────

// A Nomad holding one job for this handle. `count` is the TaskGroup count the register set — 0 is the inert
// registration this lane makes before it asks for authority.
function nomadHttp(opts: { count: number; deleteStatus?: number; calls: string[] }) {
  return {
    request: async (method: string, path: string) => {
      opts.calls.push(`${method} ${path.split("?")[0]}`);
      if (method === "GET" && path.startsWith("/v1/jobs"))
        return { status: 200, text: JSON.stringify([{ ID: WORK.externalJobId, Namespace: "default" }]) };
      if (method === "GET" && path.startsWith(`/v1/job/${WORK.externalJobId}`))
        return {
          status: 200,
          text: JSON.stringify({
            ID: WORK.externalJobId,
            Namespace: "default",
            JobModifyIndex: 42,
            TaskGroups: [{ Name: "agent", Count: opts.count }],
          }),
        };
      if (method === "DELETE") return { status: opts.deleteStatus ?? 200, text: "{}" };
      // Any allocation query: an inert job has none, and the pre-fix path is what asks.
      if (path.startsWith("/v1/job") && path.includes("allocations")) return { status: 200, text: "[]" };
      return { status: 404, text: "" };
    },
  };
}

const nomad = (http: ReturnType<typeof nomadHttp>) =>
  new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http, pollIntervalMs: 0, maxPolls: 3 } as never);

describe("[R62 COUNTEREXAMPLE] Nomad: an inert registration is recovered, not waited on forever", () => {
  it("answers INERT and purges the registration", async () => {
    const calls: string[] = [];
    const outcome = await nomad(nomadHttp({ count: 0, calls })).adoptWork(WORK);

    expect(outcome.status, "a recovery could not tell an object that can never run from one it must wait for").toBe(
      "inert",
    );
    expect(
      calls.some((c) => c.startsWith("DELETE")),
      "the inert registration was classified and then left on the cluster",
    ).toBe(true);
  });

  it("stays UNKNOWN when the purge could not be confirmed", async () => {
    const outcome = await nomad(nomadHttp({ count: 0, deleteStatus: 500, calls: [] })).adoptWork(WORK);
    expect(outcome.status, "an unconfirmed purge was reported as a reclaimed object").toBe("unknown");
  });

  it("does NOT call an inert job absent — the two answers mean different things", async () => {
    // `absent` says the listing succeeded and there is no object. Answering it here would be a lie about the
    // cluster that happens to route to the same place today; a later reader that trusts it (an operator view,
    // a leak sweep) would be told an object that exists does not.
    const outcome = await nomad(nomadHttp({ count: 0, calls: [] })).adoptWork(WORK);
    expect(outcome.status).not.toBe("absent");
  });
});

// ── …AND THE FOLD ABOVE THEM NAMES IT (arch-review 62 P0, the reader half) ───────────────────────────
//
// Teaching the lanes a phase closes nothing on its own. The control plane folds every lane's answer into one
// decision, and that fold read `adopted` and `unknown` and treated everything else as "no work here" — so
// `inert` was absorbed by a fall-through that happened to route somewhere survivable. The compiler was happy
// and every suite stayed green, which is exactly the state the phase-readers law exists to make impossible.
//
// `adoptionStep` is where one lane's answer becomes a decision, and it is a pure exported function rather
// than a closure in the composition root, because the fold that used to hold this logic is unreachable from
// any test (arch-review 56). Exhaustive by construction: a fifth status stops compiling here.
describe("[R62 COUNTEREXAMPLE] the recovery fold has a word for every answer a lane can give", () => {
  it("re-drives an INERT answer instead of deferring on it", () => {
    // The behaviour the P0 is about: the lane reclaimed an object that could never run, so this run stands
    // exactly where one whose object was never created stands.
    const step = adoptionStep({ status: "inert", work: WORK });
    expect(step.kind, "a reclaimed birth-phase object left the run deferred").toBe("redrive");
    // …and it NAMES the object it removed, so the attempt that owned it can be closed rather than left
    // reading as live work beside a fresh execution (arch-review 63 P1).
    expect(step.kind === "redrive" && step.reclaimed?.externalJobId, "the reclaim was anonymous").toBe(
      WORK.externalJobId,
    );
  });

  it("keeps UNKNOWN undecided — the arm inert must not be confused with", () => {
    // If `inert` were merely a politer `unknown`, this file would be ceremony. It is not: `unknown` means
    // compute may still be burning, so re-placing it can double-spend.
    expect(adoptionStep({ status: "unknown" }).kind).toBe("unresolved");
  });

  it("still harvests a finished container, carrying its stage", () => {
    const adopted: AdoptedWork = {
      stage: "case",
      result: { caseId: "c1", harness: "agent@1", trace: [], scores: [], snapshot: { kind: "prompt", output: "x" } },
    };
    const step = adoptionStep({ status: "adopted", adopted });
    expect(step.kind).toBe("harvest");
    if (step.kind !== "harvest") throw new Error("unreachable");
    expect(step.adopted.stage).toBe("case");
  });
});
