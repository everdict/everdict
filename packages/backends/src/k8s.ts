import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_SENTINEL } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  CaseResultSchema,
  InternalError,
  OOM_KILLED,
  UpstreamError,
  assertHardenedIsolation,
  dockerAuthConfigJson,
  imageUsesRegistryHost,
  judgeEnv,
} from "@everdict/core";
import { abortableDelay } from "./abortable-delay.js";
import {
  type AdoptOutcome,
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type Observable,
  type ProbeResult,
  type Probeable,
  type Recoverable,
  dispatchAborted,
} from "./backend.js";
import type { SecretProvider } from "./secrets.js";
import type { TrustZonePolicy } from "./trust-zone.js";

// --- kubectl abstraction (mockable in tests; the K8s version of NomadHttp) ---
export interface K8sApi {
  ensureNamespace(ns: string): Promise<void>;
  applyJob(manifest: unknown, ns: string): Promise<void>; // kubectl -n ns apply -f -
  jobStatus(name: string, ns: string): Promise<{ succeeded: number; failed: number }>;
  podLogs(name: string, ns: string): Promise<string>; // stdout of job/<name>
  // One-shot exec into the job's pod (sh -c command) — non-interactive; live terminal / screen capture.
  exec(name: string, ns: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  deleteJob(name: string, ns: string): Promise<void>;
  // Force-stop by label across namespaces (kill(caseId) → everdict.dev/case=<slug>). Best-effort, no wait.
  deleteJobsByLabel(selector: string): Promise<void>;
  // Adoption lookup — jobs matching a label selector across namespaces (boot recovery finds a dead CP's jobs).
  jobsByLabel(
    selector: string,
  ): Promise<Array<{ name: string; namespace: string; creationTimestamp?: string }> | undefined>;
  // Termination reason of the job's (failed) pod — e.g. "OOMKilled". Best-effort: undefined when unavailable.
  podFailureReason(name: string, ns: string): Promise<string | undefined>;
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
        // Position-preserving separator — a failed-only job renders succeeded as EMPTY, and a whitespace split
        // then shifts failed into the succeeded slot (a Failed job read as Succeeded → the dispatcher went on to
        // parse the dead pod's logs and every K8s job failure surfaced as "sentinel not found"). Found live via an
        // OOM-killed case that classified as a log-parse error instead of OOM_KILLED.
        "jsonpath={.status.succeeded}/{.status.failed}",
      ]);
      if (res.code !== 0) return { succeeded: 0, failed: 0 };
      return parseJobStatusOutput(res.stdout);
    },
    async podLogs(name, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "logs", `job/${name}`, "--tail=-1"]);
      if (res.code !== 0)
        throw new UpstreamError("UPSTREAM_ERROR", { name }, `log fetch failed: ${res.stderr || res.stdout}`);
      return res.stdout;
    },
    async exec(name, ns, command) {
      // The job's pod (job/<name> selects it) — one-shot, non-interactive (no -it). sh -c carries the command verbatim.
      const res = await run(bin, [...ctx, "-n", ns, "exec", `job/${name}`, "--", "sh", "-c", command]);
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.code };
    },
    async podFailureReason(name, ns) {
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "get",
        "pods",
        "-l",
        `job-name=${name}`,
        "-o",
        'jsonpath={range .items[*]}{.status.containerStatuses[*].state.terminated.reason}{" "}{.status.containerStatuses[*].lastState.terminated.reason}{end}',
      ]);
      if (res.code !== 0) return undefined;
      const reason = res.stdout.trim().split(/\s+/).find(Boolean);
      return reason || undefined;
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
    async deleteJobsByLabel(selector) {
      await run(bin, [
        ...ctx,
        "delete",
        "jobs",
        "--all-namespaces",
        "-l",
        selector,
        "--ignore-not-found",
        "--cascade=background",
        "--wait=false",
      ]);
    },
    async jobsByLabel(selector) {
      const res = await run(bin, [...ctx, "get", "jobs", "-A", "-l", selector, "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
        }>;
        return items
          .filter((j) => j.metadata?.name && j.metadata.namespace)
          .map((j) => ({
            name: j.metadata?.name as string,
            namespace: j.metadata?.namespace as string,
            ...(j.metadata?.creationTimestamp ? { creationTimestamp: j.metadata.creationTimestamp } : {}),
          }));
      } catch {
        return undefined;
      }
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
  // Declared memory envelope (RuntimeSpec.memoryBudgetMb) — the Scheduler caps the sum of in-flight
  // harness-declared memory against it. Absent = slots-only admission.
  memoryBudgetMb?: number;
  // Declared CPU envelope (RuntimeSpec.cpuBudget) — same admission contract, resources.cpu units.
  cpuBudget?: number;
}

// Mapping from hardened isolation runtime (Nomad notation) → K8s RuntimeClass name.
const RUNTIME_CLASS: Record<string, string> = { runsc: "gvisor", kata: "kata", "kata-runtime": "kata" };

// DNS-1123 job name (lowercase/digits/hyphen, ≤63).
// "{succeeded}/{failed}" jsonpath output → counts. Either side may be EMPTY (K8s omits zero-valued status
// fields), so the separator keeps positions honest.
export function parseJobStatusOutput(stdout: string): { succeeded: number; failed: number } {
  const [su = "", fa = ""] = stdout.trim().split("/");
  return { succeeded: Number(su) || 0, failed: Number(fa) || 0 };
}

export function k8sJobName(job: AgentJob, suffix?: string): string {
  // With a suffix the slug budget shrinks so the full name stays within the DNS-1123 63-char cap.
  const slug = caseSlug(job.evalCase.id, suffix ? 43 : 50);
  return `everdict-${slug || "case"}${suffix ? `-${suffix}` : ""}`;
}

// Label-safe case identifier — the selector kill(caseId) deletes by (label values share DNS-1123-ish limits).
export function caseSlug(caseId: string, max = 50): string {
  return caseId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
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
    metadata: {
      name,
      namespace: ns,
      // The case label is the kill(caseId) selector — a superseded batch force-stops its live jobs by it.
      labels: { app: "everdict", "everdict.dev/tenant": tenant, "everdict.dev/case": caseSlug(job.evalCase.id) },
    },
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
              // Harness-declared resources → requests=limits (deterministic OOM instead of noisy-neighbor starvation;
              // the scheduler bin-packs by the real weight). Unset = cluster defaults.
              ...(job.harnessSpec?.kind === "command" && job.harnessSpec.resources
                ? {
                    resources: {
                      requests: {
                        ...(job.harnessSpec.resources.cpu !== undefined
                          ? { cpu: `${job.harnessSpec.resources.cpu}m` }
                          : {}),
                        ...(job.harnessSpec.resources.memoryMb !== undefined
                          ? { memory: `${job.harnessSpec.resources.memoryMb}Mi` }
                          : {}),
                      },
                      limits: {
                        ...(job.harnessSpec.resources.cpu !== undefined
                          ? { cpu: `${job.harnessSpec.resources.cpu}m` }
                          : {}),
                        ...(job.harnessSpec.resources.memoryMb !== undefined
                          ? { memory: `${job.harnessSpec.resources.memoryMb}Mi` }
                          : {}),
                      },
                    },
                  }
                : {}),
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
export class K8sBackend implements Backend, Recoverable, Observable, Probeable {
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
    return {
      total,
      used: used ?? 0,
      ...(this.opts.memoryBudgetMb !== undefined ? { memoryBudgetMb: this.opts.memoryBudgetMb } : {}),
      ...(this.opts.cpuBudget !== undefined ? { cpuBudget: this.opts.cpuBudget } : {}),
    };
  }

  // Adopt an already-dispatched case job (boot recovery): the control plane died after applying the Job — find
  // the NEWEST job carrying the case label, wait for it like a normal dispatch, and harvest the sentinel from
  // its pod logs. undefined on any miss (no job / failed / logs unreadable) — the caller re-dispatches.
  async adopt(caseId: string): Promise<AdoptOutcome> {
    try {
      return await this.withApi(async (api): Promise<AdoptOutcome> => {
        const jobs = await api.jobsByLabel(`everdict.dev/case=${caseSlug(caseId)}`);
        // jobsByLabel returns undefined when the label query itself failed — we can't tell if a job is live → unknown.
        if (jobs === undefined) return { status: "unknown" };
        const newest = jobs.sort((a, b) => (b.creationTimestamp ?? "").localeCompare(a.creationTimestamp ?? ""))[0];
        if (!newest) return { status: "absent" }; // query succeeded, no job → safe to re-dispatch
        await this.waitForJob(api, newest.name, newest.namespace);
        const result = parseResult(await api.podLogs(newest.name, newest.namespace));
        await api.deleteJob(newest.name, newest.namespace).catch(() => {}); // same cleanup as a normal dispatch
        return { status: "adopted", result };
      });
    } catch {
      // A job existed but harvesting threw (wait/logs/parse), or the api couldn't be built — ambiguous, not "absent".
      return { status: "unknown" };
    }
  }

  // One-shot exec inside the case's live pod (web terminal / live-screen capture): kubectl exec job/<name> -- sh -c <command>.
  // undefined = no live pod. Best-effort, never throws.
  async exec(
    caseId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
    try {
      return await this.withApi(async (api) => {
        const jobs = await api.jobsByLabel(`everdict.dev/case=${caseSlug(caseId)}`);
        const newest = (jobs ?? []).sort((a, b) =>
          (b.creationTimestamp ?? "").localeCompare(a.creationTimestamp ?? ""),
        )[0];
        if (!newest) return undefined;
        return await api.exec(newest.name, newest.namespace, command);
      });
    } catch {
      return undefined;
    }
  }

  // (Interactive execStream — observability ⑥ — is Nomad-only for now: K8s reaches the pod through kubectl with a
  // per-dispatch materialized kubeconfig, so a long-lived interactive stream needs the temp file kept open for the
  // stream's lifetime — a follow-up. One-shot exec above already works. The WS route degrades gracefully.)

  // Current stdout of the case's newest job pod — live-progress tail (a pending pod reads as undefined and the
  // caller polls again). Sentinel payload stripped. Best-effort, never throws.
  async logs(caseId: string): Promise<string | undefined> {
    try {
      return await this.withApi(async (api) => {
        const jobs = await api.jobsByLabel(`everdict.dev/case=${caseSlug(caseId)}`);
        const newest = (jobs ?? []).sort((a, b) =>
          (b.creationTimestamp ?? "").localeCompare(a.creationTimestamp ?? ""),
        )[0];
        if (!newest) return undefined;
        const text = await api.podLogs(newest.name, newest.namespace);
        const idx = text.lastIndexOf(RESULT_SENTINEL);
        return idx < 0 ? text : text.slice(0, idx);
      });
    } catch {
      return undefined;
    }
  }

  // Force-stop every live job of a case (superseded batch reclaim) — by the everdict.dev/case label. Best-effort.
  async kill(caseId: string): Promise<void> {
    try {
      await this.withApi((api) => api.deleteJobsByLabel(`everdict.dev/case=${caseSlug(caseId)}`));
    } catch {
      // best-effort
    }
  }

  // Connection test — check reachability + auth (context/token/kubeconfig) via the API server /version without a job.
  async probe(): Promise<ProbeResult> {
    try {
      const version = await this.withApi((api) => api.serverVersion());
      return { reachable: true, detail: `K8s server ${version}` };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // kubectl surfaces auth failures textually — classify heuristically so a caller can tell "bad credential"
      // from "cluster unreachable" (the two most common, differently-actionable causes).
      const reason = /unauthor|forbidden|401|403|credential|token/i.test(detail) ? "auth" : "unreachable";
      return { reachable: false, reason, detail };
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

  async dispatch(job: AgentJob, options?: DispatchOptions): Promise<CaseResult> {
    if (options?.signal?.aborted) throw dispatchAborted(job); // cancelled before we applied the Job
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
        await this.waitForJob(api, name, ns, options?.signal);
        return parseResult(await api.podLogs(name, ns));
      } finally {
        // On an aborted wait this finally is exactly the reclaim — the submitted Job is deleted, not left running.
        await api.deleteJob(name, ns);
      }
    });
  }

  private async waitForJob(api: K8sApi, name: string, ns: string, signal?: AbortSignal): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted)
        throw new InternalError("CANCELLED", { name, ns }, "dispatch aborted while waiting for the K8s Job.");
      const { succeeded, failed } = await api.jobStatus(name, ns);
      if (succeeded > 0) return;
      if (failed > 0) {
        // OOM-killed reads as fatal infra (raise the harness resources), never as an agent failure.
        const reason = await api.podFailureReason(name, ns).catch(() => undefined);
        if (reason === "OOMKilled")
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { name, ns, signal: OOM_KILLED },
            "task OOM-killed — raise the harness's resources.memoryMb (infra, not an agent failure)",
          );
        throw new UpstreamError("UPSTREAM_ERROR", { name, ns, ...(reason ? { reason } : {}) }, "K8s Job failed");
      }
      await abortableDelay(interval, signal);
    }
    throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "timed out waiting for K8s Job completion");
  }
}
