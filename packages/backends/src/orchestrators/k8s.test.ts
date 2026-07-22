import { stat } from "node:fs/promises";
import { RESULT_SENTINEL } from "@everdict/contracts";
import { BadRequestError, type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import { perTenantTrustZones, staticTrustZones } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { staticSecrets } from "../policy/secrets.js";
import {
  K8S_REGISTRY_AUTH_SECRET,
  type K8sApi,
  K8sBackend,
  buildK8sJob,
  k8sCpuToMillicores,
  k8sJobName,
  k8sMemToMiB,
  k8sRegistryAuthSecret,
  kubectlArgs,
  materializeKubeconfig,
  parseJobStatusOutput,
  podResourceAsk,
  usageByNode,
} from "./k8s.js";

const JOB: CaseJob = {
  harness: { id: "aider", version: "latest" },
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [{ id: "steps" }],
    timeoutSec: 60,
    tags: [],
  },
};
const RESULT: CaseResult = {
  caseId: "c1",
  harness: "aider@latest",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" },
  scores: [{ graderId: "steps", metric: "tool_calls", value: 0 }],
};

interface JobManifest {
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    template: {
      spec: {
        runtimeClassName?: string;
        imagePullSecrets?: Array<{ name: string }>;
        containers: Array<{ image: string; imagePullPolicy: string; env: Array<{ name: string; value: string }> }>;
      };
    };
  };
}
const envOf = (m: JobManifest, k: string) => m.spec.template.spec.containers[0]?.env.find((e) => e.name === k)?.value;

function mockApi(
  opts: {
    logs?: string;
    failed?: boolean;
    active?: number;
    version?: string;
    unreachable?: boolean;
    failureReason?: string;
    labeledJobs?: Array<{ selector: string; name: string; namespace: string; creationTimestamp?: string }>;
    nodes?: Array<{ name: string; ready: boolean; status: string; os?: string; diskMbTotal?: number }> | undefined;
    workloadPods?:
      | Array<{
          name: string;
          status: string;
          node?: string;
          creationTimestamp?: string;
          namespace?: string;
          cpu?: number;
          memoryMb?: number;
          everdict?: boolean; // default true — the pre-existing tests model everdict units
          ownerKind?: string;
        }>
      | undefined;
    stores?: Array<{ name: string; port?: number }> | undefined;
    nodeFs?: Record<string, { capacityBytes?: number; usedBytes?: number }>;
    // kind/ns/name → the resource JSON getResourceJson returns (external-unit owner resolution / resize reads).
    resources?: Record<string, Record<string, unknown>>;
    patchFails?: string;
    purged?: number;
  } = {},
) {
  const applied: JobManifest[] = [];
  const deleted: string[] = [];
  const control: string[] = [];
  let polls = 0;
  const api: K8sApi = {
    async ensureNamespace() {},
    async applyJob(m) {
      applied.push(m as JobManifest);
    },
    async jobStatus() {
      polls++;
      if (opts.failed) return { succeeded: 0, failed: 1 };
      return polls >= 2 ? { succeeded: 1, failed: 0 } : { succeeded: 0, failed: 0 };
    },
    async podLogs() {
      return opts.logs ?? `prelude\n${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n`;
    },
    async exec(_name, _ns, command) {
      return { stdout: `ran: ${command}`, stderr: "", exitCode: 0 };
    },
    async podFailureReason() {
      return opts.failureReason;
    },
    async deleteJob(name) {
      deleted.push(name);
    },
    async deleteJobsByLabel(selector) {
      deleted.push(`label:${selector}`);
    },
    async jobsByLabel(selector) {
      return opts.labeledJobs?.filter((j) => j.selector === selector) ?? [];
    },
    async countActiveJobs() {
      return opts.active ?? 3;
    },
    async serverVersion() {
      if (opts.unreachable) throw new Error("dial tcp: connection refused");
      return opts.version ?? "v1.30.0";
    },
    // Inspection reads — `"key" in opts` lets a test force undefined (query failed) vs. omit for a sensible default.
    async inspectNodes() {
      return "nodes" in opts ? opts.nodes : [{ name: "node-1", ready: true, status: "Ready" }];
    },
    async nodeFsStats(node) {
      return opts.nodeFs?.[node];
    },
    async inspectWorkload() {
      const pods = "workloadPods" in opts ? opts.workloadPods : [];
      return pods?.map((p) => ({ everdict: true, ...p }));
    },
    async inspectStores() {
      return "stores" in opts ? opts.stores : [];
    },
    async stopWorkloadJob(name) {
      control.push(`stop:${name}`);
    },
    async purgeCompletedJobs() {
      control.push("purge");
      return opts.purged ?? 0;
    },
    async setNodeSchedulable(node, schedulable) {
      control.push(`${schedulable ? "uncordon" : "cordon"}:${node}`);
    },
    async getResourceJson(kind, name, ns) {
      return opts.resources?.[`${kind}/${ns}/${name}`];
    },
    async deleteResource(kind, name, ns) {
      control.push(`delete:${kind}/${ns}/${name}`);
    },
    async patchResource(kind, name, ns, patch) {
      control.push(`patch:${kind}/${ns}/${name}:${JSON.stringify(patch)}`);
      return opts.patchFails ? { ok: false, message: opts.patchFails } : { ok: true };
    },
  };
  return { api, applied, deleted, control };
}

describe("buildK8sJob / k8sJobName", () => {
  it("puts the image, pull policy, job payload (EVERDICT_CASE_JOB), and namespace", () => {
    const m = buildK8sJob(
      JOB,
      { image: "reg/everdict-job-runner:1" },
      "everdict-c1",
      "everdict-acme",
    ) as unknown as JobManifest;
    expect(m.metadata.namespace).toBe("everdict-acme");
    expect(m.spec.template.spec.containers[0]?.image).toBe("reg/everdict-job-runner:1");
    expect(m.spec.template.spec.containers[0]?.imagePullPolicy).toBe("IfNotPresent");
    expect(m.spec.template.spec.runtimeClassName).toBeUndefined();
    const decoded = JSON.parse(Buffer.from(envOf(m, "EVERDICT_CASE_JOB") ?? "", "base64").toString("utf8"));
    expect(decoded.harness.id).toBe("aider");
    // The case label is the kill(caseId) selector — a superseded batch force-stops its live jobs by it.
    expect((m.metadata as { labels?: Record<string, string> }).labels?.["everdict.dev/case"]).toBe("c1");
  });

  it("kill deletes jobs by the everdict.dev/case label selector (best-effort, all namespaces)", async () => {
    const { api, deleted } = mockApi();
    const backend = new K8sBackend({ image: "i", api });
    await backend.kill("Case_1");
    expect(deleted).toEqual(["label:everdict.dev/case=case-1"]); // slugged the same way as the job label
  });

  it("adopt finds the NEWEST case-labeled job, waits for it, harvests the sentinel, and cleans up", async () => {
    const { api, deleted } = mockApi({
      labeledJobs: [
        {
          selector: "everdict.dev/case=c1",
          name: "everdict-c1-old",
          namespace: "ns",
          creationTimestamp: "2026-07-08T01:00:00Z",
        },
        {
          selector: "everdict.dev/case=c1",
          name: "everdict-c1-new",
          namespace: "ns",
          creationTimestamp: "2026-07-08T02:00:00Z",
        },
      ],
    });
    const backend = new K8sBackend({ image: "i", api, pollIntervalMs: 1 });
    const adopted = await backend.adopt("c1");
    expect(adopted.status).toBe("adopted");
    if (adopted.status === "adopted") expect(adopted.result.caseId).toBe("c1"); // harvested without applying a new Job
    expect(deleted).toContain("everdict-c1-new"); // the adopted job gets the same cleanup as a dispatch
    expect(deleted).not.toContain("everdict-c1-old");
  });

  it("adopt distinguishes absent (no labeled job) from unknown (label query failed / job harvest failed)", async () => {
    // No labeled job → the query succeeded and found nothing → definitively absent (safe to re-dispatch).
    const none = new K8sBackend({ image: "i", api: mockApi().api, pollIntervalMs: 1 });
    expect((await none.adopt("ghost")).status).toBe("absent");

    // The label query itself failed (jobsByLabel → undefined) → we can't tell if a job is live → unknown.
    const brokenApi = { ...mockApi().api, jobsByLabel: async () => undefined };
    const broken = new K8sBackend({ image: "i", api: brokenApi, pollIntervalMs: 1 });
    expect((await broken.adopt("c1")).status).toBe("unknown");

    // A labeled job exists but it failed to complete → harvest throws → unknown, never "absent".
    const failing = mockApi({
      failed: true,
      labeledJobs: [{ selector: "everdict.dev/case=c1", name: "everdict-c1-x", namespace: "ns" }],
    });
    const backend = new K8sBackend({ image: "i", api: failing.api, pollIntervalMs: 1 });
    expect((await backend.adopt("c1")).status).toBe("unknown");
  });

  it("with evalCase.image, override with the per-case container image (SWE-bench prebuilt)", () => {
    const withImage = { ...JOB, evalCase: { ...JOB.evalCase, image: "swebench/sweb.eval.x86_64.x_1776_y-1:latest" } };
    const m = buildK8sJob(withImage, { image: "reg/agent:1" }, "n", "ns") as unknown as JobManifest;
    expect(m.spec.template.spec.containers[0]?.image).toBe("swebench/sweb.eval.x86_64.x_1776_y-1:latest");
    const off = buildK8sJob(JOB, { image: "reg/agent:1" }, "n", "ns") as unknown as JobManifest;
    expect(off.spec.template.spec.containers[0]?.image).toBe("reg/agent:1");
  });

  it("renders imagePullSecrets when case.image is a workspace-registry one (the Secret is applied together by dispatch)", () => {
    const withAuth = {
      ...JOB,
      evalCase: { ...JOB.evalCase, image: "ghcr.io/acme/sbench:v1" },
      registryAuth: { host: "ghcr.io", username: "bot", password: "pull-tok" },
    };
    const m = buildK8sJob(withAuth, { image: "reg/agent:1" }, "n", "ns") as unknown as JobManifest;
    expect(m.spec.template.spec.imagePullSecrets).toEqual([{ name: K8S_REGISTRY_AUTH_SECRET }]);
    // On a host mismatch (the default job-runner image), not rendered.
    const off = buildK8sJob(
      { ...JOB, registryAuth: { host: "ghcr.io", password: "p" } },
      { image: "reg/agent:1" },
      "n",
      "ns",
    ) as unknown as JobManifest;
    expect(off.spec.template.spec.imagePullSecrets).toBeUndefined();
    // The Secret manifest itself is in dockerconfigjson format.
    const secret = k8sRegistryAuthSecret({ host: "ghcr.io", username: "bot", password: "pull-tok" }, "ns") as {
      type: string;
      data: Record<string, string>;
    };
    expect(secret.type).toBe("kubernetes.io/dockerconfigjson");
    const config = JSON.parse(Buffer.from(secret.data[".dockerconfigjson"] ?? "", "base64").toString());
    expect(Buffer.from(config.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:pull-tok");
  });

  it("with job.judge, injects the judge model env into the pod (keys via secretEnv)", () => {
    const m = buildK8sJob(
      { ...JOB, judge: { model: "gpt-5.4-mini" } },
      { image: "img", secretEnv: { OPENAI_API_KEY: "k" } },
      "n",
      "ns",
    ) as unknown as JobManifest;
    expect(envOf(m, "EVERDICT_JUDGE_MODEL")).toBe("gpt-5.4-mini");
    expect(envOf(m, "OPENAI_API_KEY")).toBe("k");
    const off = buildK8sJob(JOB, { image: "img" }, "n", "ns") as unknown as JobManifest;
    expect(envOf(off, "EVERDICT_JUDGE_MODEL")).toBeUndefined();
  });

  it("when runtimeClassName is given, it's carried in the pod spec", () => {
    const m = buildK8sJob(JOB, { image: "img" }, "n", "ns", "gvisor") as unknown as JobManifest;
    expect(m.spec.template.spec.runtimeClassName).toBe("gvisor");
  });

  it("the hostNetwork option is carried in the pod spec (dev: to reach host services)", () => {
    const m = buildK8sJob(JOB, { image: "img", hostNetwork: true }, "n", "ns") as unknown as {
      spec: { template: { spec: { hostNetwork?: boolean } } };
    };
    expect(m.spec.template.spec.hostNetwork).toBe(true);
    const off = buildK8sJob(JOB, { image: "img" }, "n", "ns") as unknown as {
      spec: { template: { spec: { hostNetwork?: boolean } } };
    };
    expect(off.spec.template.spec.hostNetwork).toBeUndefined();
  });

  it("a suffixed name stays within the DNS-1123 63-char cap even for a long case id", () => {
    const long = { ...JOB, evalCase: { ...JOB.evalCase, id: "x".repeat(80) } };
    const name = k8sJobName(long, "ab1cd");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-ab1cd")).toBe(true);
  });

  it("k8sJobName normalizes to DNS-1123", () => {
    expect(k8sJobName({ ...JOB, evalCase: { ...JOB.evalCase, id: "Web_Case#1" } })).toBe("everdict-web-case-1");
  });
});

describe("K8sBackend.dispatch", () => {
  it("Job apply → poll completion → parse pod-log sentinel → cleanup (delete)", async () => {
    const { api, applied, deleted } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    const result = await backend.dispatch(JOB);
    expect(result.caseId).toBe("c1");
    expect(result.harness).toBe("aider@latest");
    expect(applied).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^everdict-c1-[a-z0-9]{1,5}$/); // per-dispatch unique name, finally cleanup
  });

  it("Job failure → UpstreamError but cleanup still runs", async () => {
    const { api, deleted } = mockApi({ failed: true });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    await expect(backend.dispatch(JOB)).rejects.toBeInstanceOf(UpstreamError);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^everdict-c1-[a-z0-9]{1,5}$/);
  });

  it("a failed Job's error message carries the pod reason — not a mushy 'K8s Job failed'", async () => {
    const { api } = mockApi({ failed: true, failureReason: "ContainerCannotRun" });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    await expect(backend.dispatch(JOB)).rejects.toThrow(/K8s Job failed — pod: ContainerCannotRun/);
  });

  it("a Job that never progresses times out WITH the waiting pod's reason (e.g. ImagePullBackOff)", async () => {
    const { api } = mockApi({ failureReason: "ImagePullBackOff" });
    // never succeeds nor fails — jobStatus stays 0/0
    api.jobStatus = async () => ({ succeeded: 0, failed: 0 });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1, maxPolls: 2 });
    await expect(backend.dispatch(JOB)).rejects.toThrow(/timed out .* — pod: ImagePullBackOff/);
  });

  it("two dispatches of the SAME case get different Job names — concurrent same-dataset batches must not collide", async () => {
    const { api, deleted } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    await backend.dispatch(JOB);
    await backend.dispatch(JOB);
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).not.toBe(deleted[1]);
  });

  it("trustZones: applies the tenant zone per job (namespace + runtimeClassName=gvisor)", async () => {
    const { api, applied } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1, trustZones: perTenantTrustZones() });
    await backend.dispatch({ ...JOB, tenant: "acme" });
    expect(applied[0]?.metadata.namespace).toBe("everdict-acme");
    expect(applied[0]?.spec.template.spec.runtimeClassName).toBe("gvisor"); // runsc → gvisor mapping
  });

  it("trustZones: forcing runc on untrusted refuses the dispatch", async () => {
    const { api } = mockApi();
    const backend = new K8sBackend({
      image: "img",
      api,
      trustZones: staticTrustZones({}, { id: "weak", isolationRuntime: "runc", network: "open", trusted: false }),
    });
    await expect(backend.dispatch({ ...JOB, tenant: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("secrets: injects only that tenant's keys per job (no leakage)", async () => {
    const { api, applied } = mockApi();
    const backend = new K8sBackend({
      image: "img",
      api,
      pollIntervalMs: 1,
      secrets: staticSecrets({ acme: { ANTHROPIC_API_KEY: "sk-acme" }, globex: { ANTHROPIC_API_KEY: "sk-globex" } }),
    });
    await backend.dispatch({ ...JOB, tenant: "acme" });
    await backend.dispatch({ ...JOB, tenant: "globex" });
    expect(envOf(applied[0] as JobManifest, "ANTHROPIC_API_KEY")).toBe("sk-acme");
    expect(envOf(applied[1] as JobManifest, "ANTHROPIC_API_KEY")).toBe("sk-globex");
  });

  it("capacity: reports used via a live probe", async () => {
    const { api } = mockApi({ active: 5 });
    const backend = new K8sBackend({ image: "img", api, maxConcurrent: 10 });
    expect(await backend.capacity()).toEqual({ total: 10, used: 5 });
  });
});

describe("kubectlArgs (auth selector)", () => {
  it("puts --kubeconfig first when a kubeconfig (file path) is present", () => {
    expect(kubectlArgs({ kubeconfig: "/tmp/kc", context: "kind-everdict" })).toEqual([
      "--kubeconfig",
      "/tmp/kc",
      "--context",
      "kind-everdict",
    ]);
  });

  it("server + token are carried as external-cluster bearer auth", () => {
    expect(kubectlArgs({ server: "https://k8s:6443", token: "t" })).toEqual([
      "--server",
      "https://k8s:6443",
      "--token",
      "t",
    ]);
  });

  it("empty array when nothing is given (ambient kubeconfig)", () => {
    expect(kubectlArgs({})).toEqual([]);
  });
});

describe("materializeKubeconfig", () => {
  it("writes the kubeconfig YAML to a 0600 temp file and removes it via cleanup", async () => {
    const yaml = "apiVersion: v1\nkind: Config\n";
    const { path, cleanup } = await materializeKubeconfig(yaml);
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600); // decrypted cluster credential — owner read/write only
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf8")).toBe(yaml);
    await cleanup();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" }); // removed
  });
});

describe("K8sBackend.probe", () => {
  it("reachable when it gets the server version", async () => {
    const { api } = mockApi({ version: "v1.30.2" });
    const backend = new K8sBackend({ image: "img", api });
    expect(await backend.probe()).toEqual({ reachable: true, detail: "K8s server v1.30.2" });
  });

  it("unreachable + reason when the API server is unreachable/auth fails", async () => {
    const { api } = mockApi({ unreachable: true });
    const backend = new K8sBackend({ image: "img", api });
    const r = await backend.probe();
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("connection refused");
  });
});

// Resource plumbing + OOM classification — heavier harnesses declare their weight; starvation reads as infra.
describe("K8s harness resources + OOM classification", () => {
  it("a command harness's declared resources land as requests=limits on the agent container", async () => {
    const { api, applied } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    await backend.dispatch({
      ...JOB,
      harnessSpec: {
        kind: "command",
        id: "bu",
        version: "1",
        setup: [],
        command: "run",
        env: {},
        params: {},
        trace: { kind: "none" },
        resources: { cpu: 500, memoryMb: 2048 },
      },
    });
    const container = (applied[0] as { spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } })
      .spec.template.spec.containers[0];
    expect(container?.resources).toEqual({
      requests: { cpu: "500m", memory: "2048Mi" },
      limits: { cpu: "500m", memory: "2048Mi" },
    });
  });

  it("an OOMKilled pod classifies as fatal infra (OOM_KILLED signal), not a bare job failure", async () => {
    const { api } = mockApi({ failed: true, failureReason: "OOMKilled" });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    const err = await backend.dispatch(JOB).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.extra?.signal).toBe("OOM_KILLED");
    expect(err.message).toContain("resources.memoryMb");
  });
});

// Regression: a Failed-only job must never read as Succeeded. The old whitespace-split parsing shifted the failed
// count into the succeeded slot when succeeded was empty — every K8s job failure surfaced as a log-parse error.
describe("parseJobStatusOutput", () => {
  it("a failed-only job (empty succeeded) parses as failed, not succeeded", () => {
    expect(parseJobStatusOutput("/1")).toEqual({ succeeded: 0, failed: 1 });
  });
  it("a succeeded-only job parses as succeeded", () => {
    expect(parseJobStatusOutput("1/")).toEqual({ succeeded: 1, failed: 0 });
  });
  it("both present / both empty", () => {
    expect(parseJobStatusOutput("1/2")).toEqual({ succeeded: 1, failed: 2 });
    expect(parseJobStatusOutput("/")).toEqual({ succeeded: 0, failed: 0 });
  });
});

describe("K8sBackend.exec — one-shot exec into a live case pod", () => {
  it("resolves the case's newest job and runs sh -c <command> in it", async () => {
    const { api } = mockApi({
      labeledJobs: [
        {
          selector: "everdict.dev/case=c1",
          name: "everdict-c1-x",
          namespace: "default",
          creationTimestamp: "2026-01-02",
        },
        {
          selector: "everdict.dev/case=c1",
          name: "everdict-c1-old",
          namespace: "default",
          creationTimestamp: "2026-01-01",
        },
      ],
    });
    const backend = new K8sBackend({ image: "img", api });
    const out = await backend.exec("c1", "ls /work");
    expect(out).toEqual({ stdout: "ran: ls /work", stderr: "", exitCode: 0 });
  });

  it("returns undefined when the case has no live job", async () => {
    const { api } = mockApi({ labeledJobs: [] });
    const backend = new K8sBackend({ image: "img", api });
    expect(await backend.exec("gone", "ls")).toBeUndefined();
  });
});

describe("K8sBackend.inspect (live cluster view)", () => {
  it("returns not-reachable (with a reason) when the API server can't be reached", async () => {
    const { api } = mockApi({ unreachable: true });
    const backend = new K8sBackend({ image: "i", api });
    const r = await backend.inspect();
    expect(r).toMatchObject({ kind: "k8s", reachable: false, reason: "unreachable" });
    expect(r.nodes).toBeUndefined(); // no cluster sections when unreachable
  });

  it("classifies a rejected credential as an auth failure", async () => {
    const brokenApi = { ...mockApi().api, serverVersion: async () => Promise.reject(new Error("error: Unauthorized")) };
    const backend = new K8sBackend({ image: "i", api: brokenApi });
    const r = await backend.inspect();
    expect(r).toMatchObject({ reachable: false, reason: "auth" });
  });

  it("reports version, node readiness, capacity, live workload (everdict AND external), and pool stores", async () => {
    const { api } = mockApi({
      version: "v1.31.2",
      active: 4,
      nodes: [
        { name: "n1", ready: true, status: "Ready", os: "Ubuntu 22.04.4 LTS", diskMbTotal: 100_000 },
        { name: "n2", ready: false, status: "NotReady" },
      ],
      workloadPods: [
        {
          name: "everdict-c1-abc",
          status: "Running",
          node: "n1",
          creationTimestamp: "2020-01-01T00:00:00Z",
          cpu: 500,
          memoryMb: 1024,
        },
        // An external service on the same node — listed as role "other" (pod name + namespace + owner kind), and
        // its ask still counts toward the node's committed load.
        {
          name: "nginx-7bf8c-x2q",
          namespace: "web",
          status: "Running",
          node: "n1",
          cpu: 3000,
          memoryMb: 5120,
          everdict: false,
          ownerKind: "Deployment",
        },
      ],
      stores: [{ name: "everdict-shared-postgres", port: 5432 }],
      // n1's kubelet stats summary refines the disk figures (real fs capacity/usage).
      nodeFs: { n1: { capacityBytes: 200 * 1024 * 1024 * 1024, usedBytes: 50 * 1024 * 1024 * 1024 } },
    });
    const backend = new K8sBackend({ image: "i", api, maxConcurrent: 10, namespace: "everdict-shared" });
    const r = await backend.inspect();
    expect(r.reachable).toBe(true);
    expect(r.detail).toContain("v1.31.2");
    expect(r.cluster).toMatchObject({ version: "v1.31.2", namespace: "everdict-shared" });
    expect(r.nodes).toMatchObject({ total: 2, ready: 1 });
    // Node load = the sum over EVERY pod on the node (everdict + external), computed from the one pod listing.
    expect(r.nodes?.items.find((n) => n.name === "n1")).toMatchObject({
      cpuUsed: 3500,
      memoryMbUsed: 6144,
      os: "Ubuntu 22.04.4 LTS",
      diskMbTotal: 200 * 1024, // the kubelet summary's real capacity beats the allocatable fallback
      diskMbUsed: 50 * 1024,
    });
    expect(r.capacity).toEqual({ total: 10, used: 4, free: 6 });
    // Everdict units sort before external ones; the external pod carries namespace + ownerKind.
    expect(r.workload?.[0]).toMatchObject({ name: "everdict-c1-abc", role: "eval", node: "n1" });
    expect(r.workload?.[0]?.ageSeconds).toBeGreaterThan(0);
    expect(r.workload?.[1]).toMatchObject({
      id: "web/nginx-7bf8c-x2q",
      name: "nginx-7bf8c-x2q",
      role: "other",
      namespace: "web",
      ownerKind: "Deployment",
    });
    // The pool store's address is its deterministic Service DNS.
    expect(r.stores).toEqual([
      {
        name: "everdict-shared-postgres",
        status: "ready",
        address: "everdict-shared-postgres.everdict-shared.svc.cluster.local:5432",
      },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("degrades a failed sub-read to a warning instead of throwing", async () => {
    const { api } = mockApi({ version: "v1.30.0", nodes: undefined, stores: undefined });
    const backend = new K8sBackend({ image: "i", api });
    const r = await backend.inspect();
    expect(r.reachable).toBe(true); // still renders
    expect(r.nodes).toBeUndefined();
    expect(r.stores).toBeUndefined();
    expect(r.warnings).toContain("node listing failed");
    expect(r.warnings).toContain("shared-store listing failed");
  });
});

describe("K8sBackend.reclaimable (destructive control)", () => {
  it("stopWorkload deletes the named job (via the api)", async () => {
    const { api, control } = mockApi();
    const backend = new K8sBackend({ image: "i", api });
    await backend.stopWorkload("everdict-c1-abc");
    expect(control).toContain("stop:everdict-c1-abc");
  });

  it("purgeTerminal returns the count of completed jobs the api reaped", async () => {
    const { api } = mockApi({ purged: 3 });
    const backend = new K8sBackend({ image: "i", api });
    expect(await backend.purgeTerminal()).toEqual({ purged: 3 });
  });

  it("reclaimIdle stops only non-store everdict eval units older than the threshold — external pods are never swept", async () => {
    const { api, control } = mockApi({
      workloadPods: [
        { name: "everdict-old-1", status: "Running", creationTimestamp: "2000-01-01T00:00:00Z" }, // ancient → stop
        { name: "everdict-young-1", status: "Running", creationTimestamp: new Date(Date.now() - 60_000).toISOString() }, // 1m → keep
        { name: "everdict-shared-postgres", status: "Running", creationTimestamp: "2000-01-01T00:00:00Z" }, // store → never
        // an ancient EXTERNAL service — present in the listing now, but an idle sweep must not touch it
        {
          name: "nginx-old",
          namespace: "web",
          status: "Running",
          creationTimestamp: "2000-01-01T00:00:00Z",
          everdict: false,
        },
      ],
    });
    const backend = new K8sBackend({ image: "i", api });
    const r = await backend.reclaimIdle(30 * 60);
    expect(r.stopped).toBe(1);
    expect(control).toContain("stop:everdict-old-1");
    expect(control).not.toContain("stop:everdict-shared-postgres");
    expect(control).not.toContain("stop:everdict-young-1");
    expect(control).not.toContain("stop:nginx-old");
  });

  it("stopWorkload with a namespace resolves the pod's ROOT controller and deletes IT (ReplicaSet → Deployment)", async () => {
    const { api, control } = mockApi({
      resources: {
        "pod/web/nginx-7bf8c-x2q": {
          metadata: { ownerReferences: [{ kind: "ReplicaSet", name: "nginx-7bf8c" }] },
        },
        "replicaset/web/nginx-7bf8c": {
          metadata: { ownerReferences: [{ kind: "Deployment", name: "nginx" }] },
        },
      },
    });
    const backend = new K8sBackend({ image: "i", api });
    await backend.stopWorkload("nginx-7bf8c-x2q", "web");
    expect(control).toEqual(["delete:deployment/web/nginx"]); // the controller, not the (respawning) pod
  });

  it("stopWorkload with a namespace falls back to a job of that name when the name isn't a pod", async () => {
    const { api, control } = mockApi(); // no resources → pod lookup comes back absent
    const backend = new K8sBackend({ image: "i", api });
    await backend.stopWorkload("everdict-c1-abc", "everdict-acme");
    expect(control).toEqual(["delete:job/everdict-acme/everdict-c1-abc"]);
  });

  it("workload control refuses cluster-infra namespaces loudly (kube-system is not a silent no-op)", async () => {
    const backend = new K8sBackend({ image: "i", api: mockApi().api });
    await expect(backend.stopWorkload("kube-proxy-abc", "kube-system")).rejects.toBeInstanceOf(BadRequestError);
    await expect(backend.resizeWorkload("coredns-abc", { cpu: 100 }, "kube-system")).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("resizeWorkload patches the owning Deployment's single container (requests set, low limits raised)", async () => {
    const { api, control } = mockApi({
      resources: {
        "pod/web/nginx-7bf8c-x2q": { metadata: { ownerReferences: [{ kind: "ReplicaSet", name: "nginx-7bf8c" }] } },
        "replicaset/web/nginx-7bf8c": { metadata: { ownerReferences: [{ kind: "Deployment", name: "nginx" }] } },
        "deployment/web/nginx": {
          spec: {
            template: {
              spec: {
                // cpu limit (200m) sits below the new request (500m) → raised with it; memory limit (4Gi) is high enough → untouched.
                containers: [
                  { name: "nginx", resources: { requests: { cpu: "100m" }, limits: { cpu: "200m", memory: "4Gi" } } },
                ],
              },
            },
          },
        },
      },
    });
    const backend = new K8sBackend({ image: "i", api });
    const r = await backend.resizeWorkload("nginx-7bf8c-x2q", { cpu: 500, memoryMb: 2048 }, "web");
    expect(r.detail).toContain("Deployment nginx");
    const patchCall = control.find((c) => c.startsWith("patch:deployment/web/nginx:"));
    expect(patchCall).toBeDefined();
    const patch = JSON.parse((patchCall ?? "").slice("patch:deployment/web/nginx:".length));
    expect(patch).toEqual({
      spec: {
        template: {
          spec: {
            containers: [
              { name: "nginx", resources: { requests: { cpu: "500m", memory: "2048Mi" }, limits: { cpu: "500m" } } },
            ],
          },
        },
      },
    });
  });

  it("resizeWorkload is loud on unsupported targets — never a silent no-op", async () => {
    const { api } = mockApi({
      resources: {
        "pod/web/bare-pod": { metadata: {} }, // no owner → a bare pod
        "pod/web/job-pod": { metadata: { ownerReferences: [{ kind: "Job", name: "batch-1" }] } },
        "pod/web/multi-pod": { metadata: { ownerReferences: [{ kind: "StatefulSet", name: "db" }] } },
        "statefulset/web/db": {
          spec: { template: { spec: { containers: [{ name: "a" }, { name: "b" }] } } }, // two containers → ambiguous
        },
      },
    });
    const backend = new K8sBackend({ image: "i", api });
    await expect(backend.resizeWorkload("gone-pod", { cpu: 100 }, "web")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(backend.resizeWorkload("bare-pod", { cpu: 100 }, "web")).rejects.toBeInstanceOf(BadRequestError);
    await expect(backend.resizeWorkload("job-pod", { cpu: 100 }, "web")).rejects.toBeInstanceOf(BadRequestError);
    await expect(backend.resizeWorkload("multi-pod", { cpu: 100 }, "web")).rejects.toBeInstanceOf(BadRequestError);
    await expect(backend.resizeWorkload("bare-pod", {}, "web")).rejects.toBeInstanceOf(BadRequestError); // no numbers
    await expect(backend.resizeWorkload("nginx-x", { cpu: 100 })).rejects.toBeInstanceOf(BadRequestError); // no namespace
  });

  it("setNodeSchedulable cordons (false) / uncordons (true) by node name", async () => {
    const { api, control } = mockApi();
    const backend = new K8sBackend({ image: "i", api });
    await backend.setNodeSchedulable("n1", false);
    await backend.setNodeSchedulable("n1", true);
    expect(control).toEqual(["cordon:n1", "uncordon:n1"]);
  });
});

describe("k8s quantity parsers (pure)", () => {
  it("k8sCpuToMillicores: cores, millicores, fractions", () => {
    expect(k8sCpuToMillicores("4")).toBe(4000);
    expect(k8sCpuToMillicores("3800m")).toBe(3800);
    expect(k8sCpuToMillicores("0.5")).toBe(500);
    expect(k8sCpuToMillicores(undefined)).toBeUndefined();
    expect(k8sCpuToMillicores("abc")).toBeUndefined();
  });
  it("k8sMemToMiB: binary + decimal + bytes suffixes → MiB", () => {
    expect(k8sMemToMiB("8Gi")).toBe(8192);
    expect(k8sMemToMiB("512Mi")).toBe(512);
    expect(k8sMemToMiB("1048576Ki")).toBe(1024);
    expect(k8sMemToMiB("1G")).toBe(954); // 1e9 bytes / 1048576 = 953.67 → 954
    expect(k8sMemToMiB("1048576")).toBe(1); // bytes → 1 MiB
    expect(k8sMemToMiB(undefined)).toBeUndefined();
    expect(k8sMemToMiB("nope")).toBeUndefined();
  });
  it("podResourceAsk sums container requests, with limits standing in where requests are absent", () => {
    // A typical external service: limits only — pre-fix this read as no allocation at all.
    expect(podResourceAsk([{ resources: { limits: { cpu: "500m", memory: "1Gi" } } }])).toEqual({
      cpu: 500,
      memoryMb: 1024,
    });
    // Requests win over limits when both are set; the fallback is per-resource (cpu from limits, memory from requests).
    expect(
      podResourceAsk([{ resources: { requests: { memory: "256Mi" }, limits: { cpu: "2", memory: "1Gi" } } }]),
    ).toEqual({ cpu: 2000, memoryMb: 256 });
    // Multi-container pods sum across containers; a pod with nothing declared stays absent (fields omitted).
    expect(
      podResourceAsk([
        { resources: { requests: { cpu: "100m", memory: "128Mi" } } },
        { resources: { limits: { cpu: "400m", memory: "384Mi" } } },
      ]),
    ).toEqual({ cpu: 500, memoryMb: 512 });
    expect(podResourceAsk([{}])).toEqual({});
    expect(podResourceAsk(undefined)).toEqual({});
  });
  it("usageByNode sums the workload rows' asks per node across ALL units (everdict + external)", () => {
    const rows = [
      { node: "n1", cpu: 500, memoryMb: 1024 }, // an everdict pod
      { node: "n1", cpu: 1250, memoryMb: 768 }, // a foreign platform's pod on the same node still counts
      { cpu: 1000 }, // a pod not yet scheduled onto a node → skipped (no node)
      { node: "n2" }, // no requests declared → the node stays absent (fields omitted)
    ];
    expect(usageByNode(rows)).toEqual({ n1: { cpuUsed: 1750, memoryMbUsed: 1792 }, n2: {} });
    expect(usageByNode([])).toEqual({});
  });
});
