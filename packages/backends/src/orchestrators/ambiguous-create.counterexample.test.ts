import { type CaseJob, type RuntimeWorkRef, encodeResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sBackend } from "./k8s.js";
import { NomadBackend } from "./nomad.js";

// ── A CREATE THAT ERRORED MAY STILL HAVE CREATED (arch-review 63 P1) ─────────────────────────────────
//
// Both lanes now hold one cleanup scope from the moment their object exists. The scope opens AFTER the
// create returns, and that is one call too late:
//
//     control plane → API server: create the inert object
//     API server: created
//     response: lost — a reset connection, a proxy timeout, a client abort
//     control plane: the call threw, so we are not in the scope yet
//     → an inert object nobody owns
//
// It costs no compute, which is why it is a P1 and not a P0, and it is never cleaned up: an inert object is
// not terminal, so `ttlSecondsAfterFinished` never fires and no dead-job sweep matches it. The namespace's
// object count climbs by one per lost response, forever.
//
// "The call threw" is not "nothing was created" — the same three-valued reading rule the rest of this
// codebase applies to reads, applied to a WRITE. Both lanes reserved the exact handle before the create, so
// the question is answerable: ask by that exact name.
//
// Seen RED before the readback, on each lane in turn, observed:
//   a create whose response was lost left its object behind: expected [] to contain 'deleted'

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

// ── K8s ──────────────────────────────────────────────────────────────────────────────────────────────

// An API server that APPLIES the Job and then loses the response. `created` is what the cluster holds;
// `events` is what this dispatch did about it.
function k8sApi(opts: { created: Set<string>; events: string[]; loseResponse: boolean; deleteFails?: boolean }) {
  return {
    async ensureNamespace() {},
    async applyJob(m: { kind?: string; metadata?: { name?: string } }) {
      if (m.kind === "NetworkPolicy") return;
      const name = m.metadata?.name ?? "?";
      opts.created.add(name);
      opts.events.push("applied");
      if (opts.loseResponse) throw new Error("socket hang up");
    },
    async jobsByLabel() {
      // The cluster answers honestly: the object IS there, which is the whole point.
      return [...opts.created].map((name) => ({ name, namespace: "everdict", suspended: true }));
    },
    async jobUid() {
      return "uid-1";
    },
    async patchOwnedByJob() {},
    async resumeJob() {},
    async jobStatus() {
      return { succeeded: 1, failed: 0 };
    },
    async podLogs() {
      return encodeResult({
        caseId: "c1",
        harness: "agent@1",
        trace: [],
        scores: [],
        snapshot: { kind: "prompt", output: "done" },
      });
    },
    async deleteJob(name: string) {
      opts.events.push("deleted");
      if (opts.deleteFails) return { status: "failed" as const, reason: "the API server refused the delete" };
      opts.created.delete(name);
      return { status: "stopped" as const };
    },
    async deleteDependent() {
      return { status: "stopped" as const };
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

const k8sDispatch = async (api: ReturnType<typeof k8sApi>) =>
  await new K8sBackend({ image: "runner:1", api, pollIntervalMs: 0, maxPolls: 2 } as never)
    .dispatch(JOB(), { authority: AUTHORITY })
    .catch((e: unknown) => e);

describe("[R63 COUNTEREXAMPLE] K8s: a create whose response was lost leaves no orphan", () => {
  it("asks the cluster and reclaims what it finds", async () => {
    const created = new Set<string>();
    const events: string[] = [];
    await k8sDispatch(k8sApi({ created, events, loseResponse: true }));

    expect(events, "a create whose response was lost left its object behind").toContain("deleted");
    expect(created.size, "the object this dispatch created is still in the cluster").toBe(0);
  });

  it("SAYS SO when the reclaim did not converge", async () => {
    // "We asked" is not "it is gone" (rule `protocol` L5). An operator needs to know an object may be
    // stranded, and the thrown failure is where they will look.
    const err = await k8sDispatch(k8sApi({ created: new Set(), events: [], loseResponse: true, deleteFails: true }));
    expect(
      (err as { extra?: { reclaimed?: string } })?.extra?.reclaimed,
      "an unconfirmed reclaim was reported as though the lane had tidied up",
    ).toBe("failed");
  });

  it("does NOT reclaim when the ordinary dispatch succeeds", async () => {
    // The control. A readback that fired on the happy path would delete the object this dispatch is about to
    // run, which is far worse than the leak it closes.
    const created = new Set<string>();
    const events: string[] = [];
    await k8sDispatch(k8sApi({ created, events, loseResponse: false }));
    expect(events.filter((e) => e === "deleted")).toHaveLength(1); // the ordinary end-of-dispatch reclaim only
    expect(events.indexOf("applied")).toBeLessThan(events.indexOf("deleted"));
  });
});

// ── Nomad ────────────────────────────────────────────────────────────────────────────────────────────

function nomadHttp(opts: { registered: Set<string>; events: string[]; loseResponse: boolean }) {
  return {
    request: async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/v1/jobs") {
        const job = (body as { Job: { ID: string; TaskGroups: Array<{ Count: number }> } }).Job;
        const inert = (job.TaskGroups[0]?.Count ?? 0) === 0;
        opts.registered.add(job.ID);
        opts.events.push(inert ? "register(inert)" : "start");
        if (inert && opts.loseResponse) throw new Error("ECONNRESET");
        return { status: 200, text: JSON.stringify({ JobModifyIndex: inert ? 7 : 8 }) };
      }
      if (method === "GET" && path.startsWith("/v1/jobs")) {
        opts.events.push("probed");
        return { status: 200, text: JSON.stringify([...opts.registered].map((ID) => ({ ID, Namespace: "default" }))) };
      }
      if (method === "DELETE") {
        opts.events.push("deleted");
        const id = decodeURIComponent(path.split("/v1/job/")[1]?.split("?")[0] ?? "");
        opts.registered.delete(id);
        return { status: 200, text: "{}" };
      }
      throw new Error("stop after the birth");
    },
  };
}

const nomadDispatch = async (http: ReturnType<typeof nomadHttp>) =>
  await new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never)
    .dispatch(JOB(), { authority: AUTHORITY })
    .catch((e: unknown) => e);

describe("[R63 COUNTEREXAMPLE] Nomad: a registration whose response was lost leaves no orphan", () => {
  it("asks the cluster and purges what it finds", async () => {
    const registered = new Set<string>();
    const events: string[] = [];
    await nomadDispatch(nomadHttp({ registered, events, loseResponse: true }));

    expect(events, "a registration whose response was lost left the job on the cluster").toContain("deleted");
    expect(registered.size, "the job this dispatch registered is still there").toBe(0);
  });

  it("does NOT purge when the registration answered", async () => {
    // The control: the ordinary path registers and goes on to start, and this readback must not touch it.
    const registered = new Set<string>();
    const events: string[] = [];
    await nomadDispatch(nomadHttp({ registered, events, loseResponse: false }));
    expect(events[0]).toBe("register(inert)");
    expect(events.slice(0, 2)).not.toContain("deleted");
  });
});
