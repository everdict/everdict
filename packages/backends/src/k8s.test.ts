import { stat } from "node:fs/promises";
import { RESULT_SENTINEL } from "@everdict/agent";
import { type AgentJob, BadRequestError, type CaseResult, UpstreamError } from "@everdict/core";
import { describe, expect, it } from "vitest";
import {
  K8S_REGISTRY_AUTH_SECRET,
  type K8sApi,
  K8sBackend,
  buildK8sJob,
  k8sJobName,
  k8sRegistryAuthSecret,
  kubectlArgs,
  materializeKubeconfig,
} from "./k8s.js";
import { staticSecrets } from "./secrets.js";
import { perTenantTrustZones, staticTrustZones } from "./trust-zone.js";

const JOB: AgentJob = {
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
  opts: { logs?: string; failed?: boolean; active?: number; version?: string; unreachable?: boolean } = {},
) {
  const applied: JobManifest[] = [];
  const deleted: string[] = [];
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
    async deleteJob(name) {
      deleted.push(name);
    },
    async countActiveJobs() {
      return opts.active ?? 3;
    },
    async serverVersion() {
      if (opts.unreachable) throw new Error("dial tcp: connection refused");
      return opts.version ?? "v1.30.0";
    },
  };
  return { api, applied, deleted };
}

describe("buildK8sJob / k8sJobName", () => {
  it("puts the image, pull policy, job payload (EVERDICT_AGENT_JOB), and namespace", () => {
    const m = buildK8sJob(
      JOB,
      { image: "reg/everdict-agent:1" },
      "everdict-c1",
      "everdict-acme",
    ) as unknown as JobManifest;
    expect(m.metadata.namespace).toBe("everdict-acme");
    expect(m.spec.template.spec.containers[0]?.image).toBe("reg/everdict-agent:1");
    expect(m.spec.template.spec.containers[0]?.imagePullPolicy).toBe("IfNotPresent");
    expect(m.spec.template.spec.runtimeClassName).toBeUndefined();
    const decoded = JSON.parse(Buffer.from(envOf(m, "EVERDICT_AGENT_JOB") ?? "", "base64").toString("utf8"));
    expect(decoded.harness.id).toBe("aider");
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
    // On a host mismatch (the default agent image), not rendered.
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
