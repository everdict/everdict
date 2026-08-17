import type { CaseJob } from "@everdict/contracts";
import {
  describeManagedDispatch,
  describeRuntimeWorkControl,
  describeUnknownPropagation,
} from "../conformance/index.js";
import { type K8sApi, K8sBackend } from "./k8s.js";
import { NomadBackend, type NomadHttp } from "./nomad.js";

// ── THE MANAGED BACKENDS RUN THE SAME SUITE (arch-review 53, Wave F) ────────────────────────────────
//
// Each adapter used to be certified by its own hand-written file, which is how `onWork` came to be threaded
// in one driver and absent in another for a whole wave. These four lines are the difference: a protocol
// change edits the suite once, and every implementation is re-asked.

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

function k8sWorld() {
  const effects: string[] = [];
  const api = {
    async ensureNamespace() {},
    async applyJob() {
      effects.push("apply");
      // The dispatch is not the subject here — the ORDER around it is. Throwing keeps each case short
      // without making the wait loop part of what is being certified.
      throw new Error("__STOP__: the conformance world does not run the job to completion");
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
    async jobsByLabel() {
      return [];
    },
    async serverVersion() {
      return "v1.30.0";
    },
  } as unknown as K8sApi;
  return { backend: new K8sBackend({ image: "i", api, pollIntervalMs: 1 }), job: JOB, effects };
}

function nomadWorld() {
  const effects: string[] = [];
  const http: NomadHttp = {
    async request(_method, path) {
      if (path === "/v1/jobs") {
        effects.push("submit");
        throw new Error("__STOP__: the conformance world does not run the job to completion");
      }
      return { status: 404, text: "" };
    },
  };
  return {
    backend: new NomadBackend({ addr: "http://nomad:4646", image: "img", http, pollIntervalMs: 1 }),
    job: JOB,
    effects,
  };
}

describeManagedDispatch("K8sBackend", k8sWorld);
describeManagedDispatch("NomadBackend", nomadWorld);

describeRuntimeWorkControl("K8sBackend", () => k8sWorld().backend);
describeRuntimeWorkControl("NomadBackend", () => nomadWorld().backend);

// The unknown-propagation claim at the BACKEND rung: a stop whose cluster listing failed is `unknown`, never
// `absent`. (The composition rung's version of the same claim — a registry read that failed — is certified by
// `registry-unknown.counterexample.test.ts`, which is where that seam lives.)
describeUnknownPropagation("NomadBackend", async () => {
  const http: NomadHttp = {
    async request() {
      throw new Error("cluster unreachable");
    },
  };
  const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http, pollIntervalMs: 1 });
  return backend.killWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" });
});
