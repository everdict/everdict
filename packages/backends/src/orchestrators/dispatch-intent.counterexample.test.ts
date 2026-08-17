import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type K8sApi, K8sBackend } from "./k8s.js";
import { NomadBackend, type NomadHttp } from "./nomad.js";

// ── IDENTITY BEFORE EFFECT (arch-review 53, Wave A) ──────────────────────────────────────────────────
//
// Wave 2 gave the placement layer an exact handle and Wave 3 gave the stop an honest answer, but the handle
// is still born on the WRONG SIDE of the effect it names. Both managed backends create the external object
// first and report the handle after: K8s applies the Job then calls `onWork`, Nomad submits then calls it.
// The window between those two statements is where the control plane dies in production — and a process that
// dies there leaves a running Job that NOTHING can address, because the only record of its exact name was a
// local variable in the frame that vanished. Teardown then falls back to the case-id kill, which is the
// over-broad path Wave 2 was written to retire; recovery cannot adopt it at all.
//
// The hook's own contract makes this structural rather than accidental: `onWork` is OPTIONAL and
// "best-effort — a throw must not break dispatch". A dispatch whose identity was never persisted is
// therefore a SUCCESSFUL dispatch. Nothing in the type system, and nothing at runtime, distinguishes it
// from one whose handle landed.
//
// The invariant these pin: the exact external name is DECIDED and DURABLE before the external object exists.
// Both backends already compute that name locally before they call the cluster (`k8sJobName(job, suffix)`,
// the Nomad `jobId`), so this is a reordering of statements the code already has — not a new id-allocation
// protocol. Wave A splits `dispatch` into `reserve` (decide the name, no external effect) and `submit`
// (create exactly the reserved object), with a durable `DispatchIntent` commit between them.

const JOB: CaseJob = {
  harness: { id: "h", version: "1.0.0" },
  runId: "evd-run-1",
  tenant: "acme",
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
};

// The Wave-A surface, probed structurally: a backend that can create managed external work must be able to
// NAME that work without creating it. Typed as an unknown-keyed lookup so this file compiles against the
// pre-Wave-A shape — the assertion is the point, not the cast.
const methodOf = (backend: object, name: string): unknown => (backend as Record<string, unknown>)[name];

// RED as of 186f9fd9: `expected 'undefined' to be 'function'` (both).
describe.skip("[R53 WAVE-A COUNTEREXAMPLE #1] a managed backend can name its work without creating it", () => {
  it("K8sBackend exposes reserve() — the name is decided before the cluster is touched", () => {
    const backend = new K8sBackend({ image: "i", api: {} as K8sApi });
    expect(typeof methodOf(backend, "reserve")).toBe("function");
  });

  it("NomadBackend exposes reserve() — same protocol, same reason", () => {
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http: {} as NomadHttp,
    });
    expect(typeof methodOf(backend, "reserve")).toBe("function");
  });
});

// RED as of 186f9fd9: `expected 'apply' to be 'work'`.
describe.skip("[R53 WAVE-A COUNTEREXAMPLE #2] the K8s handle exists before the Job does", () => {
  it("reports the exact work handle BEFORE applyJob, so a crash mid-dispatch still leaves it addressable", async () => {
    const order: string[] = [];
    const api: K8sApi = {
      async ensureNamespace() {},
      async applyJob() {
        order.push("apply");
        // The control plane dies the instant the cluster accepted the object. Everything after this point in
        // dispatch() — including the current onWork call — never runs.
        throw new Error("__CRASH__: control plane died the moment the Job was created");
      },
      async jobStatus() {
        return { succeeded: 1, failed: 0 };
      },
      async podLogs() {
        return "";
      },
      async deleteJob() {
        return { status: "stopped" as const };
      },
      async deleteJobsByLabel() {
        return { status: "stopped" as const };
      },
      async jobsByLabel() {
        return [];
      },
      async countActiveJobs() {
        return 0;
      },
      async serverVersion() {
        return "v1.30.0";
      },
    } as unknown as K8sApi;

    const backend = new K8sBackend({ image: "i", api, pollIntervalMs: 1 });
    await backend.dispatch(JOB, { onWork: () => order.push("work") }).catch(() => undefined);

    // RED as of 186f9fd9: order is ["apply"] — the handle is never reported, because the frame that held it
    // died with the process. The exact Job name the cluster is now running is unrecoverable.
    expect(order[0]).toBe("work");
    expect(order).toContain("apply");
  });
});

// RED as of 186f9fd9: `expected 'submit' to be 'work'`.
describe.skip("[R53 WAVE-A COUNTEREXAMPLE #3] the Nomad handle exists before the job does", () => {
  it("reports the exact work handle BEFORE the submit returns, for the same reason", async () => {
    const order: string[] = [];
    const http: NomadHttp = {
      async request(_method, path) {
        if (path === "/v1/jobs") {
          order.push("submit");
          throw new Error("__CRASH__: control plane died the moment the job was submitted");
        }
        return { status: 404, text: "" };
      },
    };

    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
    });
    await backend.dispatch(JOB, { onWork: () => order.push("work") }).catch(() => undefined);

    // RED as of 186f9fd9: ["submit"] only. Nomad may well have accepted the job before the socket died —
    // an ambiguous submit failure is precisely the case where the handle matters most, and it is precisely
    // the case where today's ordering guarantees there is none.
    expect(order[0]).toBe("work");
  });
});
