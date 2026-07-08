import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_SENTINEL } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  CaseResultSchema,
  UpstreamError,
  assertHardenedIsolation,
  dockerAuthConfigJson,
  imageUsesRegistryHost,
  judgeEnv,
} from "@everdict/core";
import type { Backend, BackendCapacity, ProbeResult } from "./backend.js";
import type { SecretProvider } from "./secrets.js";
import type { TrustZonePolicy } from "./trust-zone.js";

// --- kubectl abstraction (mockable in tests; the K8s version of NomadHttp) ---
export interface K8sApi {
  ensureNamespace(ns: string): Promise<void>;
  applyJob(manifest: unknown, ns: string): Promise<void>; // kubectl -n ns apply -f -
  jobStatus(name: string, ns: string): Promise<{ succeeded: number; failed: number }>;
  podLogs(name: string, ns: string): Promise<string>; // stdout of job/<name>
  deleteJob(name: string, ns: string): Promise<void>;
  countActiveJobs(): Promise<number | undefined>; // capacity probe (in-flight app=everdict jobs across all namespaces)
  serverVersion(): Promise<string>; // connection test — API server /version (gitVersion). Throws on reachability/auth failure.
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
function run(bin: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

// kubectl global auth args (the selector) — split out for testability. Precedence: kubeconfig (file path) > context > server/token.
export function kubectlArgs(opts: {
  context?: string;
  server?: string;
  token?: string;
  kubeconfig?: string;
}): string[] {
  return [
    ...(opts.kubeconfig ? ["--kubeconfig", opts.kubeconfig] : []),
    ...(opts.context ? ["--context", opts.context] : []),
    ...(opts.server ? ["--server", opts.server] : []),
    ...(opts.token ? ["--token", opts.token] : []),
  ];
}

// The real kubectl implementation, driven by a kind/kubeconfig context.
// External cluster: authenticate with a bearer token (server+token instead of context) or a full kubeconfig file (--kubeconfig).
export function kubectlApi(
  opts: { context?: string; bin?: string; server?: string; token?: string; kubeconfig?: string } = {},
): K8sApi {
  const bin = opts.bin ?? "kubectl";
  const ctx = kubectlArgs(opts);
  return {
    async ensureNamespace(ns) {
      const res = await run(
        bin,
        [...ctx, "apply", "-f", "-"],
        JSON.stringify({ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }),
      );
      if (res.code !== 0) throw new Error(`ensureNamespace ${ns}: ${res.stderr || res.stdout}`);
    },
    async applyJob(manifest, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "apply", "-f", "-"], JSON.stringify(manifest));
      if (res.code !== 0) throw new Error(`apply job: ${res.stderr || res.stdout}`);
    },
    async jobStatus(name, ns) {
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "get",
        "job",
        name,
        "-o",
        "jsonpath={.status.succeeded} {.status.failed}",
      ]);
      if (res.code !== 0) return { succeeded: 0, failed: 0 };
      const [su, fa] = res.stdout.trim().split(/\s+/);
      return { succeeded: Number(su) || 0, failed: Number(fa) || 0 };
    },
    async podLogs(name, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "logs", `job/${name}`, "--tail=-1"]);
      if (res.code !== 0)
        throw new UpstreamError("UPSTREAM_ERROR", { name }, `log fetch failed: ${res.stderr || res.stdout}`);
      return res.stdout;
    },
    async deleteJob(name, ns) {
      await run(bin, [
        ...ctx,
        "-n",
        ns,
        "delete",
        "job",
        name,
        "--ignore-not-found",
        "--cascade=background",
        "--wait=false",
      ]);
    },
    async countActiveJobs() {
      const res = await run(bin, [...ctx, "get", "jobs", "-A", "-l", "app=everdict", "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          status?: { succeeded?: number; failed?: number };
        }>;
        return items.filter((j) => !j.status?.succeeded && !j.status?.failed).length;
      } catch {
        return undefined;
      }
    },
    async serverVersion() {
      // get --raw=/version reaches the API server directly — non-zero exit (throw) on unreachable/auth failure.
      const res = await run(bin, [...ctx, "get", "--raw=/version"]);
      if (res.code !== 0)
        throw new UpstreamError("UPSTREAM_ERROR", undefined, (res.stderr || res.stdout).trim().slice(0, 300));
      try {
        const v = JSON.parse(res.stdout) as { gitVersion?: string };
        return v.gitVersion ?? res.stdout.trim().slice(0, 200);
      } catch {
        return res.stdout.trim().slice(0, 200);
      }
    },
  };
}

export interface K8sBackendOptions {
  image: string; // runner-agent image
  api?: K8sApi;
  context?: string; // kubeconfig context (e.g. kind-everdict)
  server?: string; // external API server URL (when authenticating with a bearer token instead of context)
  apiToken?: string; // K8s API bearer token (kubectl --token) — control-plane↔K8s API auth. Unrelated to the alloc env.
  // Full kubeconfig YAML (value). If set, per dispatch write it to a temp file (0600), authenticate via --kubeconfig, and remove afterward.
  // Takes precedence over context/server/apiToken. Being a cluster credential, it never enters the job (agent) env.
  kubeconfig?: string;
  secretEnv?: Record<string, string>; // auth to inject into the job (default when secrets is absent)
  secrets?: SecretProvider; // per-tenant secret scoping
  namespace?: string; // default namespace (when there's no tenant zone)
  runtimeClass?: string; // explicit runtimeClassName (gVisor=gvisor etc.). trustZones takes precedence.
  trustZones?: TrustZonePolicy; // per-tenant isolation — enforces namespace + runtimeClassName
  imagePullPolicy?: string; // default IfNotPresent (kind-loaded image)
  hostNetwork?: boolean; // the pod shares the node network — to reach host services (e.g. dev LiteLLM). ⚠️ weakens isolation: dev only.
  ttlSecondsAfterFinished?: number; // auto-cleanup of the job (default 300)
  pollIntervalMs?: number;
  maxPolls?: number;
  maxConcurrent?: number | (() => number);
}

// Mapping from hardened isolation runtime (Nomad notation) → K8s RuntimeClass name.
const RUNTIME_CLASS: Record<string, string> = { runsc: "gvisor", kata: "kata", "kata-runtime": "kata" };

// DNS-1123 job name (lowercase/digits/hyphen, ≤63).
export function k8sJobName(job: AgentJob, suffix?: string): string {
  // With a suffix the slug budget shrinks so the full name stays within the DNS-1123 63-char cap.
  const slug = job.evalCase.id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, suffix ? 43 : 50);
  return `everdict-${slug || "case"}${suffix ? `-${suffix}` : ""}`;
}

function dispatchSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

// The Secret name imagePullSecrets references — one per namespace, apply idempotently upserts it (kept independent of job deletion).
export const K8S_REGISTRY_AUTH_SECRET = "everdict-registry-auth";

// Workspace-registry credentials (transient job.registryAuth) → a dockerconfigjson Secret. When case.image is
// that registry host, dispatch applies it together with the Job as a List.
export function k8sRegistryAuthSecret(
  auth: NonNullable<AgentJob["registryAuth"]>,
  ns: string,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: K8S_REGISTRY_AUTH_SECRET, namespace: ns, labels: { app: "everdict" } },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": Buffer.from(dockerAuthConfigJson(auth)).toString("base64") },
  };
}

// AgentJob → K8s batch Job. The payload is the EVERDICT_AGENT_JOB(base64) env. Isolation is runtimeClassName.
export function buildK8sJob(
  job: AgentJob,
  opts: K8sBackendOptions,
  name: string,
  ns: string,
  runtimeClassName?: string,
): Record<string, unknown> {
  const env: Record<string, string> = {
    EVERDICT_AGENT_JOB: Buffer.from(JSON.stringify(job)).toString("base64"),
    ...judgeEnv(job.judge), // per-run judge model config (keys via secretEnv). The inline judge grader judges with this model.
    ...opts.secretEnv,
  };
  // Prefer the per-case image (e.g. the official SWE-bench prebuilt = deps+repo bundled), otherwise the default agent image.
  const image = job.evalCase.image ?? opts.image;
  // For a workspace-registry image, imagePullSecrets (dispatch applies the Secret above together) — only when the host matches.
  const pullAuth = Boolean(job.registryAuth && imageUsesRegistryHost(image, job.registryAuth.host));
  const tenant = job.tenant ?? "default";
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: ns, labels: { app: "everdict", "everdict.dev/tenant": tenant } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? 300,
      template: {
        metadata: { labels: { app: "everdict", "everdict.dev/tenant": tenant } },
        spec: {
          restartPolicy: "Never",
          ...(runtimeClassName ? { runtimeClassName } : {}),
          ...(opts.hostNetwork ? { hostNetwork: true } : {}),
          ...(pullAuth ? { imagePullSecrets: [{ name: K8S_REGISTRY_AUTH_SECRET }] } : {}),
          containers: [
            {
              name: "agent",
              image,
              imagePullPolicy: opts.imagePullPolicy ?? "IfNotPresent",
              env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
            },
          ],
        },
      },
    },
  };
}

function parseResult(stdout: string): CaseResult {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) throw new UpstreamError("UPSTREAM_ERROR", undefined, "could not find the agent result (sentinel).");
  const line = stdout.slice(idx + RESULT_SENTINEL.length).split("\n")[0] ?? "";
  return CaseResultSchema.parse(JSON.parse(line));
}

// Write the kubeconfig (YAML value) to a temp file and return a path to use with kubectl --kubeconfig. Being a decrypted cluster
// credential, write it with mode 0600, and once dispatch finishes, remove the file+directory via cleanup() (don't leave it on disk for long).
export async function materializeKubeconfig(yaml: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "everdict-kcfg-"));
  const path = join(dir, "kubeconfig");
  await writeFile(path, yaml, { mode: 0o600 });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Model B: launch the runner-agent as a K8s Job, poll for completion, then parse the CaseResult from the sentinel in the pod log.
// Isolation is namespace (per-tenant) + runtimeClassName (gVisor/kata). The K8s counterpart of NomadBackend.
export class K8sBackend implements Backend {
  readonly id = "k8s";
  // A long-lived api from an injected api (test) or non-kubeconfig auth (context/server/token).
  // With kubeconfig auth, build a fresh api from a temp kubeconfig per dispatch so the credential isn't left on disk for long (withApi).
  private readonly staticApi?: K8sApi;

  constructor(private readonly opts: K8sBackendOptions) {
    if (opts.api) this.staticApi = opts.api;
    else if (!opts.kubeconfig)
      this.staticApi = kubectlApi({
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.server ? { server: opts.server } : {}),
        ...(opts.apiToken ? { token: opts.apiToken } : {}),
      });
  }

  // With kubeconfig auth, write it to a temp file (0600), run fn with kubectl pointed at that path, and remove it in finally.
  // Otherwise use the long-lived staticApi. The cluster credential is neither exposed to untrusted code nor left on disk for long.
  private async withApi<T>(fn: (api: K8sApi) => Promise<T>): Promise<T> {
    if (this.staticApi) return fn(this.staticApi);
    const yaml = this.opts.kubeconfig;
    if (!yaml)
      throw new UpstreamError("UPSTREAM_ERROR", undefined, "no K8s backend auth (context/server/token/kubeconfig).");
    const { path, cleanup } = await materializeKubeconfig(yaml);
    try {
      return await fn(kubectlApi({ kubeconfig: path }));
    } finally {
      await cleanup();
    }
  }

  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    const total = (typeof mc === "function" ? mc() : mc) ?? 20;
    const used = await this.withApi((api) => api.countActiveJobs());
    return { total, used: used ?? 0 };
  }

  // Connection test — check reachability + auth (context/token/kubeconfig) via the API server /version without a job.
  async probe(): Promise<ProbeResult> {
    try {
      const version = await this.withApi((api) => api.serverVersion());
      return { reachable: true, detail: `K8s server ${version}` };
    } catch (e) {
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // Apply/enforce the tenant zone/secrets per job: untrusted requires strong isolation, a dedicated namespace, and inject only that tenant's keys.
  private async resolve(
    job: AgentJob,
  ): Promise<{ ns: string; runtimeClassName?: string; secretEnv?: Record<string, string> }> {
    const tenant = job.tenant ?? "default";
    const zone = this.opts.trustZones?.resolve(tenant);
    const secretEnv = this.opts.secrets ? await this.opts.secrets.secretsFor(tenant) : this.opts.secretEnv;
    if (!zone) return { ns: this.opts.namespace ?? "default", runtimeClassName: this.opts.runtimeClass, secretEnv };
    assertHardenedIsolation(zone);
    // Map only hardened runtimes to a RuntimeClass (runsc→gvisor/kata). runc/none (trusted dev) uses the cluster default runtime.
    const runtimeClassName = this.opts.runtimeClass ?? RUNTIME_CLASS[zone.isolationRuntime];
    return { ns: zone.namespace ?? this.opts.namespace ?? "default", runtimeClassName, secretEnv };
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const { ns, runtimeClassName, secretEnv } = await this.resolve(job);
    // Unique per dispatch — two concurrent batches over the same dataset would otherwise collide on the same Job
    // name (409 AlreadyExists → dispatch error). The capacity probe matches the label, not the name.
    const name = k8sJobName(job, dispatchSuffix());
    // With kubeconfig auth, the temp kubeconfig lives only for the one job (removed after completion/failure). cleanup after deleteJob.
    return this.withApi(async (api) => {
      await api.ensureNamespace(ns);
      const manifest = buildK8sJob(job, { ...this.opts, secretEnv }, name, ns, runtimeClassName);
      // For a workspace-registry image, apply the dockerconfigjson Secret together with the Job (List) — fixed name, idempotent upsert.
      const auth = job.registryAuth;
      const image = job.evalCase.image ?? this.opts.image;
      const payload =
        auth && imageUsesRegistryHost(image, auth.host)
          ? { apiVersion: "v1", kind: "List", items: [k8sRegistryAuthSecret(auth, ns), manifest] }
          : manifest;
      await api.applyJob(payload, ns);
      try {
        await this.waitForJob(api, name, ns);
        return parseResult(await api.podLogs(name, ns));
      } finally {
        await api.deleteJob(name, ns);
      }
    });
  }

  private async waitForJob(api: K8sApi, name: string, ns: string): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    for (let i = 0; i < maxPolls; i++) {
      const { succeeded, failed } = await api.jobStatus(name, ns);
      if (succeeded > 0) return;
      if (failed > 0) throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "K8s Job failed");
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "timed out waiting for K8s Job completion");
  }
}
