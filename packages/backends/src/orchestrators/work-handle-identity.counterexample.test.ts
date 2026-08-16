import type { CaseJob, RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type K8sApi, K8sBackend, buildK8sJob, k8sJobName } from "./k8s.js";
import { NomadBackend, type NomadHttp } from "./nomad.js";

// ── A PLACEMENT HANDLE NAMES ONE EXECUTION (arch-review 52, Wave 2) ─────────────────────────────────
//
// Both managed backends address live work by CASE ID alone: the K8s job carries `everdict.dev/case=<slug>`
// and `kill` deletes every job matching it; the Nomad kill lists `prefix=everdict-<caseId>-&namespace=*` and
// deregisters whatever comes back. A case id is not an execution, though — the same case runs concurrently
// under two runs (a re-evaluation beside a scheduled batch, a shadow beside its baseline), in two tenants'
// namespaces, and — on K8s — under two DIFFERENT case ids that truncate to one label value. So one run's
// cancellation reaches into another run's compute, and the blast radius is invisible to the caller: kill is
// best-effort and returns void, so nothing downstream can tell that it stopped a stranger's job.
//
// The invariant these three pin: a stop is scoped to the WORK it was issued for. Wave 2 gives the backends an
// exact handle (`RuntimeWorkRef`) to carry that scope — the shape asserted below.

// The handle the placement layer now takes (`RuntimeWorkRef`, @everdict/contracts — Wave 2 landed it as the
// shape below was drafted, with the orchestrator's own external id in place of the case id the draft used).
// `caseId` alone can address several live executions; the run, the tenant, the exact external id and the
// namespace the work was placed in are what make it one.
interface ExactHandleBackend {
  killWork(work: RuntimeWorkRef): Promise<void>;
}
// `kill(caseId: string)` survives beside it as the no-handle fallback and cannot express the scope at all.
const exact = (backend: K8sBackend | NomadBackend): ExactHandleBackend => backend;

const caseJob = (caseId: string, runId: string, tenant = "acme"): CaseJob => ({
  harness: { id: "h", version: "1.0.0" },
  runId,
  tenant,
  evalCase: {
    id: caseId,
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
});

interface LabeledManifest {
  metadata: { name: string; labels: Record<string, string> };
}
const labelsOf = (job: CaseJob): Record<string, string> =>
  (buildK8sJob(job, { image: "reg/job-runner:1" }, k8sJobName(job), "everdict-acme") as unknown as LabeledManifest)
    .metadata.labels;

// `k=v,k2=v2` — the only selector form our kill/adopt reads. A selector MATCHES a job when every pair it
// names is present on that job's labels.
function selectorMatches(selector: string, labels: Record<string, string>): boolean {
  return selector.split(",").every((pair) => {
    const [key, value] = pair.split("=");
    return key !== undefined && labels[key] === value;
  });
}

function k8sRecorder(): { api: K8sApi; selectors: string[] } {
  const selectors: string[] = [];
  const api = {
    async ensureNamespace() {},
    async applyJob() {},
    async deleteJobsByLabel(selector: string) {
      selectors.push(selector);
    },
    async deleteJob() {},
    async jobsByLabel() {
      return [];
    },
  } as unknown as K8sApi;
  return { api, selectors };
}

function nomadRecorder(jobs: Array<{ ID: string; Namespace: string; Status: string }>): {
  http: NomadHttp;
  requests: string[];
} {
  const requests: string[] = [];
  const http: NomadHttp = {
    async request(method, path) {
      requests.push(`${method} ${path}`);
      if (method === "GET" && path.startsWith("/v1/jobs")) return { status: 200, text: JSON.stringify(jobs) };
      return { status: 200, text: "" };
    },
  };
  return { http, requests };
}

// [WAVE-2 COUNTEREXAMPLE #3] RED as of 02a3e15e: `AssertionError: expected [] to have a length of 1 but got +0`
// — K8sBackend.kill takes a caseId, so the run-scoped handle reaches caseSlug as an object, throws inside the
// best-effort try, and no selector is ever issued (today's caseId kill would instead delete BOTH runs' jobs).
// UN-SKIPPED (wave 2): `killWork` takes the handle and selects on (app, tenant, run).
describe("a stop reaches only the work it was issued for (K8s)", () => {
  it("cancelling one run of a case leaves a concurrent run of the SAME case running", async () => {
    // Given two runs of one case, live at the same time on one cluster
    const runA = caseJob("c1", "evd-run-a");
    const runB = caseJob("c1", "evd-run-b");
    const { api, selectors } = k8sRecorder();
    const backend = new K8sBackend({ image: "reg/job-runner:1", api });

    // When run A is cancelled — by the handle its dispatch reported, not by the case it was about
    await exact(backend).killWork({
      tenant: "acme",
      runId: "evd-run-a",
      externalJobId: k8sJobName(runA, "aaaaa"),
      namespace: "everdict-acme",
    });

    // Then exactly one selector was issued, and it addresses A's job and only A's. A selector that matches
    // both is a cancellation of somebody else's evaluation — the compute is gone and the batch that owned it
    // reads an infra failure it never caused.
    expect(selectors).toHaveLength(1);
    const selector = selectors[0] ?? "";
    expect(selectorMatches(selector, labelsOf(runA))).toBe(true);
    expect(selectorMatches(selector, labelsOf(runB))).toBe(false);
  });

  // [WAVE-2 COUNTEREXAMPLE #4] RED as of 02a3e15e: `AssertionError: expected 'case-aaaa…aaaa' not to be
  // 'case-aaaa…aaaa' // Object.is equality` — caseSlug truncates at 50 chars, so two distinct case ids share one
  // label value and therefore one addressable unit. Un-skip when wave 2 lands.
  it("two case ids that truncate to one label value stay separately addressable", () => {
    // Given two case ids identical for the first 50 characters (a generated benchmark's id shape: one long
    // prefix, the discriminator at the end)
    const prefix = `case-${"a".repeat(46)}`;
    const first = caseJob(`${prefix}-alpha`, "evd-run-a");
    const second = caseJob(`${prefix}-omega`, "evd-run-b");
    expect(first.evalCase.id).not.toBe(second.evalCase.id);

    // Then the cluster identity that kill/adopt select on distinguishes them. It does not today: both jobs
    // carry the same `everdict.dev/case`, so one case's kill stops the other's job and one case's adopt
    // harvests the other's result — a verdict attributed to a case that never produced it.
    expect(labelsOf(first)["everdict.dev/case"]).not.toBe(labelsOf(second)["everdict.dev/case"]);
  });
});

// [WAVE-2 COUNTEREXAMPLE #5] RED as of 02a3e15e: `AssertionError: expected [ Array(1) ] to deeply equal []`,
// received `[ "GET /v1/jobs?prefix=everdict-%5Bobject%20Object%5D-&namespace=*" ]` — NomadBackend.kill sweeps every
// namespace by caseId prefix, so a tenant's cancellation deregisters another tenant's job of the same case.
// Un-skip when wave 2 lands.
// UN-SKIPPED (wave 2): killWork deregisters the handle's own id in its own namespace — no listing at all.
describe("a stop stays inside the namespace its work was placed in (Nomad)", () => {
  it("cancelling one namespace's run of a case does not deregister another namespace's job of the same case", async () => {
    // Given the same case live in two trust zones — one job per namespace, both alive
    const jobs = [
      { ID: "everdict-c1-aaaaa", Namespace: "everdict-acme", Status: "running" },
      { ID: "everdict-c1-bbbbb", Namespace: "everdict-globex", Status: "running" },
    ];
    const { http, requests } = nomadRecorder(jobs);
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "reg/job-runner:1", http });

    // When acme's run is cancelled — by the handle its dispatch reported
    await exact(backend).killWork({
      tenant: "acme",
      runId: "evd-run-a",
      externalJobId: "everdict-c1-aaaaa",
      namespace: "everdict-acme",
    });

    // Then nothing was looked up across all namespaces…
    expect(requests.filter((r) => r.includes("namespace=*"))).toEqual([]);
    // …and the only deregistration is acme's own job, by its exact id, in its own namespace. Globex's job
    // sharing the case id is not this cancellation's business — a cross-tenant stop is the same defect as a
    // cross-tenant read, and it is silent because kill returns void.
    const deletes = requests.filter((r) => r.startsWith("DELETE "));
    expect(deletes).toEqual(["DELETE /v1/job/everdict-c1-aaaaa?namespace=everdict-acme"]);
  });
});
