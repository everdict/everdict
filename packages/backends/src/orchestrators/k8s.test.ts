import { stat } from "node:fs/promises";
import type { ManagedDispatchAuthority } from "@everdict/application-control";
import { RESULT_SENTINEL } from "@everdict/contracts";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  type RuntimeWorkRef,
  UpstreamError,
} from "@everdict/contracts";
import { perTenantTrustZones, staticTrustZones } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { staticSecrets } from "../policy/secrets.js";
import {
  K8S_REGISTRY_AUTH_SECRET,
  type K8sApi,
  K8sBackend,
  buildK8sJob,
  caseLabelValue,
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

// The dispatch AUTHORITY, as one capability (arch-review 58 W2). These cases exercise the reservation half,
// so the activation half answers `activate` — a supplier that could hand over half the protocol is exactly
// the shape this merge removed, and a fake that still could would be modelling the old contract.
const authorityOf = (reserve: ManagedDispatchAuthority["reserve"]): ManagedDispatchAuthority => ({
  reserve,
  activate: async () => ({ kind: "activate" }),
});

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
    // Case-scoped placement reads (inspectCase) — the job's pods + one pod's namespace events.
    jobPods?: Array<{ name: string; phase?: string; node?: string; reason?: string; restarts?: number }>;
    podEvents?: Array<{ reason?: string; message: string; at?: string }>;
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
    podTop?: { cpuMillicores?: number; memoryMb?: number }; // metrics-API usage the sampleCase read returns
  } = {},
) {
  const applied: JobManifest[] = [];
  const deleted: string[] = [];
  const control: string[] = [];
  let polls = 0;
  const api: K8sApi = {
    async ensureNamespace() {},
    // The lane ties a network policy to its Job when the case declares an offline world (arch-review 58 W5);
    // these cases declare none, so the patch is never reached.
    async patchNetworkPolicy() {},
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
    async podTop() {
      return opts.podTop;
    },
    async podsForJob() {
      return opts.jobPods;
    },
    async objectEvents() {
      return opts.podEvents;
    },
    async deleteJob(name) {
      deleted.push(name);
      return { status: "stopped" as const };
    },
    async deleteJobsByLabel(selector) {
      deleted.push(`label:${selector}`);
      return { status: "stopped" as const };
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
  it("adoptWork distinguishes absent (this object is gone) from unknown (the cluster could not be asked)", async () => {
    // The run-label query succeeded and this exact job is not among the answers → definitively absent, and
    // re-dispatching is safe. Addressed by the handle, so "gone" is a statement about ONE object rather than
    // about every job that happens to carry the case's name (arch-review 53, legacy removal).
    const none = new K8sBackend({ image: "i", api: mockApi().api, pollIntervalMs: 1 });
    expect(
      (await none.adoptWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-ghost-aaaa" })).status,
    ).toBe("absent");

    // The query itself failed (jobsByLabel → undefined) → whether the object is live is UNESTABLISHED, and
    // re-dispatching on that may double-spend. Never "absent".
    const brokenApi = { ...mockApi().api, jobsByLabel: async () => undefined };
    const broken = new K8sBackend({ image: "i", api: brokenApi, pollIntervalMs: 1 });
    expect(
      (await broken.adoptWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" })).status,
    ).toBe("unknown");

    // The object exists and the harvest threw → unknown, never "absent": the job is real, and what it
    // produced is what we failed to read.
    const failing = mockApi({
      failed: true,
      labeledJobs: [
        { selector: `everdict.dev/run=${caseLabelValue("evd-run-1")}`, name: "everdict-c1-aaaa", namespace: "ns" },
      ],
    });
    const backend = new K8sBackend({ image: "i", api: failing.api, pollIntervalMs: 1 });
    expect(
      (await backend.adoptWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" })).status,
    ).toBe("unknown");
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

  it("carries the runtime-side node placement binding (nodeSelector, tolerations, GPU request) when the runtime declares it", () => {
    const m = buildK8sJob(
      JOB,
      {
        image: "img",
        nodeSelector: { "nvidia.com/gpu.present": "true" },
        tolerations: [{ key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" }],
        gpu: 2,
      },
      "n",
      "ns",
    ) as unknown as {
      spec: {
        template: {
          spec: {
            nodeSelector?: Record<string, string>;
            tolerations?: Array<Record<string, string>>;
            containers: Array<{ resources?: Record<string, Record<string, string>> }>;
          };
        };
      };
    };
    expect(m.spec.template.spec.nodeSelector).toEqual({ "nvidia.com/gpu.present": "true" });
    expect(m.spec.template.spec.tolerations).toEqual([
      { key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" },
    ]);
    // A GPU-only job (no command-harness cpu/mem) still emits a resources block, requests=limits for the device.
    expect(m.spec.template.spec.containers[0]?.resources).toEqual({
      requests: { "nvidia.com/gpu": "2" },
      limits: { "nvidia.com/gpu": "2" },
    });
  });

  it("a command harness's resources.gpu reserves nvidia.com/gpu and wins over the runtime binding default", () => {
    const withGpu = {
      ...JOB,
      harnessSpec: {
        kind: "command" as const,
        id: "cuda",
        version: "1",
        setup: [],
        command: "run",
        env: {},
        params: {},
        trace: { kind: "none" as const },
        resources: { gpu: 4 },
      },
    };
    const m = buildK8sJob(withGpu, { image: "img", gpu: 1 }, "n", "ns") as unknown as {
      spec: { template: { spec: { containers: Array<{ resources?: Record<string, Record<string, string>> }> } } };
    };
    // harness-declared 4 wins over the runtime binding's blanket 1
    expect(m.spec.template.spec.containers[0]?.resources).toEqual({
      requests: { "nvidia.com/gpu": "4" },
      limits: { "nvidia.com/gpu": "4" },
    });
  });

  it("omits node placement + GPU when the runtime declares none (no-regression)", () => {
    const off = buildK8sJob(JOB, { image: "img" }, "n", "ns") as unknown as {
      spec: {
        template: {
          spec: { nodeSelector?: unknown; tolerations?: unknown; containers: Array<{ resources?: unknown }> };
        };
      };
    };
    expect(off.spec.template.spec.nodeSelector).toBeUndefined();
    expect(off.spec.template.spec.tolerations).toBeUndefined();
    expect(off.spec.template.spec.containers[0]?.resources).toBeUndefined();
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

  // ── THE HANDLE THE DISPATCH HANDS BACK (arch-review 52, Wave 2) ───────────────────────────────────
  it("reports the exact Job it is ABOUT to apply — name, namespace, run and tenant — before it creates it", async () => {
    const { api, applied } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1, trustZones: perTenantTrustZones() });
    const works: RuntimeWorkRef[] = [];

    await backend.dispatch(
      { ...JOB, tenant: "acme", runId: "evd-run-r1", attemptId: "evd-run-r1#g1" },
      {
        authority: authorityOf(async (w: RuntimeWorkRef) => {
          works.push(w);
          return { attemptId: w.attemptId ?? `${w.runId}#g1`, work: w, persistedAt: "2026-08-18T00:00:00.000Z" };
        }),
      },
    );

    // The handle names the object the cluster is about to be asked for — the same name the manifest carries,
    // in the namespace the zone put it in. Everything a teardown needs after this process is gone, held
    // BEFORE the object exists (arch-review 53, Wave A).
    expect(works).toHaveLength(1);
    expect(works[0]).toEqual({
      tenant: "acme",
      runId: "evd-run-r1",
      attemptId: "evd-run-r1#g1",
      externalJobId: applied[0]?.metadata.name,
      namespace: "everdict-acme",
    });
    // …and the Job carries the RUN, which is what makes the handle's stop scoped to one execution of the case.
    expect(applied[0]?.metadata.labels["everdict.dev/run"]).toBe(caseLabelValue("evd-run-r1"));
  });

  it("a job with no control-plane run id reports no handle — a handle that cannot name its run is the ambiguity again", async () => {
    const { api } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    const works: unknown[] = [];
    await backend.dispatch(JOB, {
      authority: authorityOf(async (w: RuntimeWorkRef) => {
        works.push(w);
        return { attemptId: w.attemptId ?? `${w.runId}#g1`, work: w, persistedAt: "2026-08-18T00:00:00.000Z" };
      }),
    }); // JOB has no runId
    expect(works).toEqual([]);
  });

  it("a rejecting onReserved consumer FAILS the dispatch, and no Job is applied", async () => {
    // The inversion Wave A is (arch-review 53): under the old post-apply hook a handle that could not be
    // persisted still produced compute, so an unaddressable Job was a successful dispatch. A caller that
    // cannot record where the work will be must not get the work.
    const { api, applied } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    await expect(
      backend.dispatch(
        { ...JOB, runId: "evd-run-r1" },
        {
          authority: authorityOf(() => {
            throw new Error("ledger down");
          }),
        },
      ),
    ).rejects.toThrow(/ledger down/);
    expect(applied, "the cluster was asked for a Job whose handle nobody could record").toHaveLength(0);
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

  it("dispatch seals the infra-plane record onto the result's trace (submitted → placed → pod events)", async () => {
    const { api } = mockApi({
      jobPods: [{ name: "everdict-c1-x-pod", phase: "Succeeded", node: "n3" }],
      podEvents: [{ reason: "Pulled", message: "Successfully pulled image", at: new Date().toISOString() }],
    });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    const result = await backend.dispatch(JOB);
    const infra = result.trace.filter((e) => e.kind === "infra");
    // 이벤트는 실제 타임스탬프(t) 순으로 정렬돼 실린다 — 구성만 단언(순서는 소스 타임스탬프에 따름).
    expect(infra.map((e) => (e.kind === "infra" ? e.event : undefined)).sort()).toEqual([
      "Pulled",
      "placed",
      "submitted",
    ]);
    expect(infra.find((e) => e.kind === "infra" && e.event === "placed")).toMatchObject({
      scope: "placement",
      unit: "everdict-c1-x-pod",
      node: "n3",
    });
  });

  it("a failed K8s job's throw carries the failure evidence in extra (pod/node/events + log tail)", async () => {
    // Regression: dispatch's finally deletes the Job right after the throw — the pod identity, its events, and
    // the pod log tail must be captured at throw time or they are unreachable exactly when someone asks "why".
    const { api } = mockApi({
      failed: true,
      failureReason: "Error",
      jobPods: [{ name: "everdict-c1-x-pod", phase: "Failed", node: "n2" }],
      podEvents: [{ reason: "BackOff", message: "Back-off restarting failed container" }],
      logs: "boom stacktrace line",
    });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    const err = await backend.dispatch(JOB).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const extra = err.extra as { placement?: { unit?: string; node?: string; events?: string[] }; logTail?: string };
    expect(extra.placement).toMatchObject({ unit: "everdict-c1-x-pod", node: "n2" });
    expect(extra.placement?.events).toEqual(["BackOff: Back-off restarting failed container"]);
    expect(extra.logTail).toBe("boom stacktrace line");
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
    const out = await backend.execInWork(
      { tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" },
      "ls /work",
    );
    expect(out).toEqual({ stdout: "ran: ls /work", stderr: "", exitCode: 0 });
  });

  it("returns undefined when the named container is not there to exec into", async () => {
    // Addressed by the handle, so "not there" is the CLUSTER refusing this exact object rather than a label
    // query coming back empty (arch-review 53, legacy removal — the case-id form asked "any job of this
    // case?", which is a different question and could answer about another run's container).
    const base = mockApi({ labeledJobs: [] }).api;
    const api = {
      ...base,
      exec: async () => {
        throw new Error('Error from server (NotFound): jobs.batch "everdict-gone-aaaa" not found');
      },
    };
    const backend = new K8sBackend({ image: "img", api });
    expect(
      await backend.execInWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-gone-aaaa" }, "ls"),
    ).toBeUndefined();
  });
});

describe("K8sBackend.inspectWork (the exact object's placement view)", () => {
  // The handle names the object under test — the fixture's own job, in its own namespace. The case-id form
  // this replaces took neither, which is exactly how it could describe another run's job.
  const WORK = {
    tenant: "acme",
    runId: "evd-run-1",
    externalJobId: "everdict-c1-x",
    namespace: "everdict-t1",
  } as const;

  const caseJob = [
    {
      selector: "everdict.dev/case=c1",
      name: "everdict-c1-x",
      namespace: "everdict-t1",
      creationTimestamp: "2026-01-02",
    },
  ];

  it("an object the cluster cannot be asked about → undefined", async () => {
    // The exact read differs from the case-id one it replaces (arch-review 53, legacy removal): asked about
    // ONE named object, "no pods yet" is `queued` (below), not absence. Undefined is reserved for a cluster
    // that could not answer at all — which is what a caller must not mistake for "nothing is running".
    const base = mockApi({ labeledJobs: [] }).api;
    const api = {
      ...base,
      podsForJob: async () => {
        throw new Error("connection refused");
      },
    };
    const backend = new K8sBackend({ image: "img", api });
    expect(await backend.inspectWork(WORK)).toBeUndefined();
  });

  it("a Pending pod with a FailedScheduling event → phase 'blocked' carrying the scheduler's own verdict", async () => {
    const { api } = mockApi({
      labeledJobs: caseJob,
      jobPods: [{ name: "everdict-c1-x-abc", phase: "Pending" }],
      podEvents: [
        {
          reason: "FailedScheduling",
          message: "0/3 nodes are available: 3 Insufficient memory.",
          at: "2026-01-02T00:00:01Z",
        },
      ],
    });
    const placement = await new K8sBackend({ image: "img", api }).inspectWork(WORK);
    expect(placement?.phase).toBe("blocked");
    expect(placement?.blockedReason).toContain("Insufficient memory");
    expect(placement?.namespace).toBe("everdict-t1");
  });

  it("a Running pod → phase 'running' with the node and the event feed", async () => {
    const { api } = mockApi({
      labeledJobs: caseJob,
      jobPods: [{ name: "everdict-c1-x-abc", phase: "Running", node: "worker-3" }],
      podEvents: [
        { reason: "Pulled", message: "Successfully pulled image", at: "2026-01-02T00:00:02Z" },
        { reason: "Started", message: "Started container agent", at: "2026-01-02T00:00:03Z" },
      ],
    });
    const placement = await new K8sBackend({ image: "img", api }).inspectWork(WORK);
    expect(placement?.phase).toBe("running");
    expect(placement?.unit).toBe("everdict-c1-x-abc");
    expect(placement?.node).toBe("worker-3");
    expect(placement?.events.map((e) => e.type)).toEqual(["Pulled", "Started"]);
  });

  it("a Failed pod with the OOMKilled reason → phase 'dead' with oom=true", async () => {
    const { api } = mockApi({
      labeledJobs: caseJob,
      jobPods: [{ name: "everdict-c1-x-abc", phase: "Failed", node: "worker-1", reason: "OOMKilled", restarts: 2 }],
      podEvents: [],
    });
    const placement = await new K8sBackend({ image: "img", api }).inspectWork(WORK);
    expect(placement?.phase).toBe("dead");
    expect(placement?.oom).toBe(true);
    expect(placement?.restarts).toBe(2);
  });

  it("a job with no pod yet → phase 'queued'", async () => {
    const { api } = mockApi({ labeledJobs: caseJob, jobPods: [] });
    const placement = await new K8sBackend({ image: "img", api }).inspectWork(WORK);
    expect(placement?.phase).toBe("queued");
    expect(placement?.job).toBe("everdict-c1-x");
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

describe("K8sBackend.sampleCase (replay runtime plane producer)", () => {
  it("reads the case pod's metrics-API usage, mapping millicores to percent-of-one-core", async () => {
    const { api } = mockApi({
      labeledJobs: [{ selector: "everdict.dev/case=c1", name: "everdict-c1-x", namespace: "ns" }],
      podTop: { cpuMillicores: 250, memoryMb: 64 },
    });
    const backend = new K8sBackend({ image: "i", api });
    expect(await backend.sampleWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" })).toEqual(
      { cpuPct: 25, memBytes: 64 * 1024 * 1024 },
    );
  });

  it("reads as no sample when there is no job or the metrics API is absent — never throws", async () => {
    const noJob = new K8sBackend({ image: "i", api: mockApi().api });
    expect(
      await noJob.sampleWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" }),
    ).toBeUndefined();

    const noMetrics = new K8sBackend({
      image: "i",
      api: mockApi({ labeledJobs: [{ selector: "everdict.dev/case=c1", name: "everdict-c1-x", namespace: "ns" }] }).api,
    });
    expect(
      await noMetrics.sampleWork({ tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" }),
    ).toBeUndefined();
  });
});
