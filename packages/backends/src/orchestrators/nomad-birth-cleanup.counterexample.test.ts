import { type CaseJob, type RuntimeWorkRef, encodeResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { NomadBackend } from "./nomad.js";

// ── ONE CLEANUP SCOPE, FROM THE MOMENT THE OBJECT EXISTS (arch-review 62 follow-through) ─────────────
//
// arch-review 61 gave the K8s lane exactly this and the Nomad lane kept hand-rolled deletes on the two
// refusal paths somebody had thought of. The one nobody had thought of is the START:
//
//     register W at Count:0        the object exists
//     activate W                   authorized
//     POST W at Count:1  →  5xx / connection reset / timeout
//     throw                        …outside every try, so nothing removes W
//
// The registration stays, inert, forever: it is not terminal, so no dead-job sweep collects it, and the
// caller has been told the dispatch failed. Worse on the ambiguous half — a start the server APPLIED whose
// response was lost leaves a job that is actually RUNNING while this process reports failure, so the retry
// places a second one and two containers write competing evidence for one case.
//
// A reclaim per failure mode is a list somebody has to keep complete, and this is the third review to find a
// mode missing from it. One scope from the moment the object exists, and the two hand-rolled deletes fold
// into it — the property is "this dispatch made an object, so this dispatch removes it", not "these four
// failures were enumerated".
//
// The reclaim READS ITS ANSWER (rule `protocol` L5): a purge that did not converge means this dispatch's
// failure may still be burning compute, and the infra trace says so rather than the lane pretending it
// tidied up.
//
// Seen RED before the scope, observed:
//   a start that failed left its registration on the cluster: expected [] to contain 'DELETE'

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

// A Nomad whose START fails in whichever way the test asks for. The inert registration always succeeds, so
// the object exists by the time the failure happens — which is the whole point.
function nomad(opts: {
  startFails?: "status" | "throw";
  purgeFails?: boolean;
  calls: string[];
  live: Set<string>;
}) {
  return {
    request: async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/v1/jobs") {
        const job = (body as { Job: { ID: string; TaskGroups: Array<{ Count: number }> } }).Job;
        const count = job.TaskGroups[0]?.Count ?? 0;
        if (count === 0) {
          opts.calls.push("register(inert)");
          opts.live.add(job.ID);
          return { status: 200, text: JSON.stringify({ JobModifyIndex: 7 }) };
        }
        opts.calls.push("start");
        if (opts.startFails === "throw") throw new Error("connection reset by peer");
        if (opts.startFails === "status") return { status: 502, text: "bad gateway" };
        return { status: 200, text: JSON.stringify({ JobModifyIndex: 8 }) };
      }
      if (method === "DELETE") {
        opts.calls.push("DELETE");
        if (opts.purgeFails) return { status: 500, text: "cannot purge" };
        const id = decodeURIComponent(path.split("/v1/job/")[1]?.split("?")[0] ?? "");
        opts.live.delete(id);
        return { status: 200, text: "{}" };
      }
      // A started job that actually RUNS: the control below needs the ordinary path to complete, because a
      // dispatch that fails after the start now reclaims too (arch-review 63 P1-high) — so "stop at the
      // poll" would be a failure, not a success.
      if (path.includes("/allocations"))
        return { status: 200, text: JSON.stringify([{ ID: "a1", ClientStatus: "complete" }]) };
      if (path.includes("/logs/"))
        return {
          status: 200,
          // The PRODUCTION encoder — a hand-spelled sentinel makes the control fail for a reason that has
          // nothing to do with this file (rule `testing`, and the third time this session).
          text: encodeResult({
            caseId: "c1",
            harness: "agent@1",
            trace: [],
            scores: [],
            snapshot: { kind: "prompt", output: "done" },
          }),
        };
      return { status: 404, text: "" };
    },
  };
}

const dispatch = async (http: ReturnType<typeof nomad>, authority = AUTHORITY) =>
  await new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never)
    .dispatch(JOB(), { authority })
    .catch((e: unknown) => e);

describe("[R62-followup COUNTEREXAMPLE] a Nomad dispatch removes the object it made, whichever step failed", () => {
  it("reclaims the registration when the START returns a failure status", async () => {
    const calls: string[] = [];
    const live = new Set<string>();
    await dispatch(nomad({ startFails: "status", calls, live }));

    expect(calls, "a start that failed left its registration on the cluster").toContain("DELETE");
    expect(live.size, "the object this dispatch created is still on the cluster").toBe(0);
  });

  it("reclaims it when the start response is LOST — the ambiguous half", async () => {
    // The server may have applied it, so the job may be RUNNING while this process reports failure. Leaving
    // it is how a retry ends up with two containers writing evidence for one case.
    const calls: string[] = [];
    const live = new Set<string>();
    await dispatch(nomad({ startFails: "throw", calls, live }));

    expect(calls, "a start whose response was lost left compute nobody is waiting on").toContain("DELETE");
    expect(live.size).toBe(0);
  });

  it("still reclaims it when the ACTIVATION is refused", async () => {
    // The path that already had a hand-rolled delete: folding the deletes into one scope must not lose it.
    const calls: string[] = [];
    const live = new Set<string>();
    await dispatch(nomad({ calls, live }), {
      ...AUTHORITY,
      activate: async () => {
        throw new Error("this execution was cancelled");
      },
    });

    expect(calls, "a refused activation left its object behind").toContain("DELETE");
    expect(live.size).toBe(0);
  });

  it("SAYS SO when the reclaim did not converge", async () => {
    // "Cleanup attempted" is not "cleanup converged" (rule `protocol` L5). A purge the cluster refused leaves
    // an object this dispatch cannot account for, and the infra record is where an operator sees it.
    const calls: string[] = [];
    const err = await dispatch(nomad({ startFails: "status", purgeFails: true, calls, live: new Set() }));
    expect(calls).toContain("DELETE");
    expect(
      (err as { extra?: { reclaimed?: string } })?.extra?.reclaimed,
      "a reclaim that failed was reported as though the lane had tidied up",
    ).toBe("failed");
  });

  it("does NOT reclaim a job that started AND FINISHED — the scope must not eat the ordinary path", async () => {
    // The control. A cleanup scope that removed the object on success would be a far worse defect than the
    // leak it closes, and every assertion above would still pass. Note what changed in arch-review 63: a
    // dispatch that fails AFTER the start reclaims as well, so the success path has to complete for real.
    const calls: string[] = [];
    const live = new Set<string>();
    await dispatch(nomad({ calls, live }));

    expect(
      calls.filter((c) => c === "DELETE"),
      "the dispatch reclaimed the job it had just started",
    ).toHaveLength(0);
    expect(live.size, "the started job was removed before it could run").toBe(1);
  });
});

// ── …AND AFTER THE START TOO (arch-review 63 P1-high) ───────────────────────────────────────────────
//
// The block above covers every failure BEFORE the job runs. After a successful start the lane reclaimed on
// exactly one condition: the caller had cancelled. `waitForAlloc` and the log fetch throw for a dozen other
// reasons that say nothing about the job — a 5xx from `/allocations`, a reset connection, a poll timeout,
// unparseable JSON — and on each of them the allocation kept running while this process reported a retryable
// infra failure. The batch retried and placed a SECOND job: two containers, one case, competing evidence.
//
// The K8s twin has held apply-to-result inside one scope since arch-review 61. This is the same contract, and
// it is a STOP rather than a purge so the job's record and logs stay readable for whoever investigates.
//
// Seen RED before the reclaim was widened, observed:
//   a transport failure after the start left the allocation running: expected [] to contain 'DELETE'
function startedThenBroken(opts: { calls: string[]; live: Set<string> }) {
  return {
    request: async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/v1/jobs") {
        const job = (body as { Job: { ID: string; TaskGroups: Array<{ Count: number }> } }).Job;
        const count = job.TaskGroups[0]?.Count ?? 0;
        opts.calls.push(count === 0 ? "register(inert)" : "start");
        opts.live.add(job.ID);
        return { status: 200, text: JSON.stringify({ JobModifyIndex: count === 0 ? 7 : 8 }) };
      }
      if (method === "DELETE") {
        opts.calls.push("DELETE");
        const id = decodeURIComponent(path.split("/v1/job/")[1]?.split("?")[0] ?? "");
        opts.live.delete(id);
        return { status: 200, text: "{}" };
      }
      // The job is RUNNING and the control plane cannot reach the API: the failure this file is about.
      throw new Error("ECONNRESET while reading allocations");
    },
  };
}

describe("[R63 COUNTEREXAMPLE] a Nomad dispatch reclaims after the start too, not only on an abort", () => {
  it("stops the allocation when the poll fails for a transport reason", async () => {
    const calls: string[] = [];
    const live = new Set<string>();
    await new NomadBackend({
      addr: "http://nomad:4646",
      image: "runner:1",
      http: startedThenBroken({ calls, live }),
    } as never)
      .dispatch(JOB(), { authority: AUTHORITY })
      .catch(() => undefined);

    // The control first: the job really did start, or this is the pre-start case the block above covers.
    expect(calls, "the dispatch never got past the inert registration").toContain("start");
    expect(calls, "a transport failure after the start left the allocation running").toContain("DELETE");
    expect(live.size, "the job this dispatch started is still on the cluster").toBe(0);
  });
});
