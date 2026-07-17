import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResult, stripSentinel } from "@everdict/contracts";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  InternalError,
  NotFoundError,
  OOM_KILLED,
  UpstreamError,
  judgeAuthEnv,
  judgeEnv,
} from "@everdict/contracts";
import type { InspectNode, InspectRuntimeResult, InspectStore, InspectWorkload } from "@everdict/contracts/wire";
import { assertHardenedIsolation, dockerAuthConfigJson, imageUsesRegistryHost } from "@everdict/domain";
import type { TrustZonePolicy } from "@everdict/domain";
import {
  type AdoptOutcome,
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type Inspectable,
  type LogStream,
  type Observable,
  type ProbeResult,
  type Probeable,
  type Reclaimable,
  type Recoverable,
  dispatchAborted,
} from "../backend.js";
import type { SecretProvider } from "../policy/secrets.js";
import { abortableDelay } from "./abortable-delay.js";
import { NODE_DETAIL_CAP, SHARED_STORE_PREFIX, WORKLOAD_CAP, classifyWorkloadRole } from "./inspect-common.js";

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
  // --- Read-only inspection (runtime detail screen). Each returns undefined when the query itself fails (best-effort). ---
  inspectNodes(): Promise<
    | Array<{
        name: string;
        ready: boolean;
        status: string;
        schedulable?: boolean;
        cpuTotal?: number;
        memoryMbTotal?: number;
        // Host identity (status.nodeInfo + addresses + allocatable ephemeral-storage) — all best-effort per field.
        os?: string;
        arch?: string;
        kernel?: string;
        containerRuntime?: string;
        agentVersion?: string;
        address?: string;
        diskMbTotal?: number;
      }>
    | undefined
  >; // cluster composition + allocatable resources + node identity
  // The node's real filesystem stats via the kubelet stats summary (get --raw .../proxy/stats/summary) — capacity
  // and used bytes of the node fs. undefined when the summary is unavailable (RBAC / managed clusters may deny it).
  nodeFsStats(node: string): Promise<{ capacityBytes?: number; usedBytes?: number } | undefined>;
  inspectWorkload(): Promise<
    | Array<{
        name: string;
        namespace?: string;
        status: string;
        node?: string;
        creationTimestamp?: string;
        cpu?: number;
        memoryMb?: number;
        everdict: boolean; // carries the app=everdict label (an everdict-placed unit) vs an external pod
        ownerKind?: string; // owning controller kind for display (ReplicaSet already read as Deployment); "Pod" = bare
      }>
    | undefined
  >; // ALL running/pending pods across namespaces (everdict units and external services), with their resource requests
  inspectStores(namespace: string): Promise<Array<{ name: string; port?: number }> | undefined>; // pool shared-store Services in the pool namespace
  // --- Destructive control (runtimes:control). Best-effort/idempotent — acting on a gone target is a no-op. ---
  stopWorkloadJob(name: string): Promise<void>; // find the everdict job named `name` across namespaces and delete it
  purgeCompletedJobs(): Promise<number>; // delete completed (succeeded/failed) app=everdict jobs; returns the count
  setNodeSchedulable(node: string, schedulable: boolean): Promise<void>; // kubectl cordon (false) / uncordon (true)
  // --- Generic namespaced reads/mutations (external-unit control: owner-chain resolve, terminate, resize). ---
  getResourceJson(kind: string, name: string, ns: string): Promise<Record<string, unknown> | undefined>; // undefined = absent/unreadable
  deleteResource(kind: string, name: string, ns: string): Promise<void>; // --ignore-not-found, no wait
  patchResource(kind: string, name: string, ns: string, patch: unknown): Promise<{ ok: boolean; message?: string }>; // strategic merge
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
        // waiting.reason last — a pod that never starts (ImagePullBackOff/ErrImagePull) has no terminated state,
        // and it's what the TIMEOUT path needs to explain a job that never progressed.
        'jsonpath={range .items[*]}{.status.containerStatuses[*].state.terminated.reason}{" "}{.status.containerStatuses[*].lastState.terminated.reason}{" "}{.status.containerStatuses[*].state.waiting.reason}{end}',
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
    async inspectNodes() {
      const res = await run(bin, [...ctx, "get", "nodes", "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string };
          spec?: { unschedulable?: boolean };
          status?: {
            conditions?: Array<{ type?: string; status?: string }>;
            allocatable?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
            nodeInfo?: {
              osImage?: string;
              architecture?: string;
              kernelVersion?: string;
              containerRuntimeVersion?: string;
              kubeletVersion?: string;
            };
            addresses?: Array<{ type?: string; address?: string }>;
          };
        }>;
        return items.map((n) => {
          const ready = (n.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
          const cpuTotal = k8sCpuToMillicores(n.status?.allocatable?.cpu);
          const memoryMbTotal = k8sMemToMiB(n.status?.allocatable?.memory);
          const info = n.status?.nodeInfo;
          // Allocatable ephemeral-storage as the disk-total fallback; nodeFsStats (kubelet summary) refines it.
          const diskMbTotal = k8sMemToMiB(n.status?.allocatable?.["ephemeral-storage"]);
          const address = (n.status?.addresses ?? []).find((a) => a.type === "InternalIP")?.address;
          return {
            name: n.metadata?.name ?? "node",
            ready,
            status: ready ? "Ready" : "NotReady",
            schedulable: !n.spec?.unschedulable,
            ...(cpuTotal !== undefined ? { cpuTotal } : {}),
            ...(memoryMbTotal !== undefined ? { memoryMbTotal } : {}),
            ...(info?.osImage ? { os: info.osImage } : {}),
            ...(info?.architecture ? { arch: info.architecture } : {}),
            ...(info?.kernelVersion ? { kernel: info.kernelVersion } : {}),
            ...(info?.containerRuntimeVersion ? { containerRuntime: info.containerRuntimeVersion } : {}),
            ...(info?.kubeletVersion ? { agentVersion: info.kubeletVersion } : {}),
            ...(address ? { address } : {}),
            ...(diskMbTotal !== undefined ? { diskMbTotal } : {}),
          };
        });
      } catch {
        return undefined;
      }
    },
    async nodeFsStats(node) {
      // The kubelet stats summary through the API-server node proxy — the node's REAL fs capacity/usage. Managed
      // clusters / tight RBAC may deny the proxy subresource; that simply reads as undefined (best-effort).
      const res = await run(bin, [...ctx, "get", "--raw", `/api/v1/nodes/${node}/proxy/stats/summary`]);
      if (res.code !== 0) return undefined;
      try {
        const s = JSON.parse(res.stdout) as { node?: { fs?: { capacityBytes?: number; usedBytes?: number } } };
        const fs = s.node?.fs;
        if (!fs) return undefined;
        return {
          ...(typeof fs.capacityBytes === "number" ? { capacityBytes: fs.capacityBytes } : {}),
          ...(typeof fs.usedBytes === "number" ? { usedBytes: fs.usedBytes } : {}),
        };
      } catch {
        return undefined;
      }
    },
    async inspectWorkload() {
      // ALL running/pending pods across namespaces — everdict units (label app=everdict, from the buildK8sJob
      // template) AND external services co-resident on the cluster. One listing feeds the workload view AND the
      // per-node committed-load gauge (summed by the backend), so no second all-pods call is needed.
      const res = await run(bin, [...ctx, "get", "pods", "-A", "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: {
            name?: string;
            namespace?: string;
            labels?: Record<string, string>;
            creationTimestamp?: string;
            ownerReferences?: Array<{ kind?: string }>;
          };
          spec?: {
            nodeName?: string;
            containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }>;
          };
          status?: { phase?: string };
        }>;
        return items
          .filter((p) => p.status?.phase === "Running" || p.status?.phase === "Pending")
          .map((p) => {
            // Sum the pod's container requests (millicores + MiB) — its resource ask, for the per-node usage bar.
            let cpu = 0;
            let memoryMb = 0;
            for (const c of p.spec?.containers ?? []) {
              cpu += k8sCpuToMillicores(c.resources?.requests?.cpu) ?? 0;
              memoryMb += k8sMemToMiB(c.resources?.requests?.memory) ?? 0;
            }
            const everdict = p.metadata?.labels?.app === "everdict";
            // Display kind: a ReplicaSet-owned pod is a Deployment in practice (control resolves the real chain).
            const rawOwner = (p.metadata?.ownerReferences ?? []).find((o) => o.kind)?.kind;
            const ownerKind = rawOwner === "ReplicaSet" ? "Deployment" : (rawOwner ?? "Pod");
            return {
              // Everdict unit: the job-name label reads more meaningfully than the pod's random suffix. External
              // unit: the POD name — it is what namespace-scoped control (owner resolve) targets.
              name: (everdict ? p.metadata?.labels?.["job-name"] : undefined) ?? p.metadata?.name ?? "everdict-pod",
              status: p.status?.phase ?? "Unknown",
              everdict,
              ownerKind,
              ...(p.metadata?.namespace ? { namespace: p.metadata.namespace } : {}),
              ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
              ...(p.metadata?.creationTimestamp ? { creationTimestamp: p.metadata.creationTimestamp } : {}),
              ...(cpu > 0 ? { cpu } : {}),
              ...(memoryMb > 0 ? { memoryMb } : {}),
            };
          });
      } catch {
        return undefined;
      }
    },
    async inspectStores(namespace) {
      const res = await run(bin, [...ctx, "get", "svc", "-n", namespace, "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string };
          spec?: { ports?: Array<{ port?: number }> };
        }>;
        return items
          .filter((s) => (s.metadata?.name ?? "").startsWith("everdict-shared-"))
          .map((s) => {
            const port = s.spec?.ports?.[0]?.port;
            return { name: s.metadata?.name ?? "everdict-shared", ...(port !== undefined ? { port } : {}) };
          });
      } catch {
        return undefined;
      }
    },
    async stopWorkloadJob(name) {
      // Resolve the job's namespace by name (across namespaces), then delete it. A missing job is a silent no-op.
      const res = await run(bin, [...ctx, "get", "jobs", "-A", "-o", "json"]);
      if (res.code !== 0) return;
      let ns: string | undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string; namespace?: string };
        }>;
        ns = items.find((j) => j.metadata?.name === name)?.metadata?.namespace;
      } catch {
        return;
      }
      if (!ns) return;
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
    async purgeCompletedJobs() {
      const res = await run(bin, [...ctx, "get", "jobs", "-A", "-l", "app=everdict", "-o", "json"]);
      if (res.code !== 0) return 0;
      let completed: Array<{ name: string; namespace: string }> = [];
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string; namespace?: string };
          status?: { succeeded?: number; failed?: number };
        }>;
        completed = items
          .filter((j) => (j.status?.succeeded ?? 0) > 0 || (j.status?.failed ?? 0) > 0)
          .filter((j) => j.metadata?.name && j.metadata.namespace)
          .map((j) => ({ name: j.metadata?.name as string, namespace: j.metadata?.namespace as string }));
      } catch {
        return 0;
      }
      let purged = 0;
      for (const j of completed) {
        const del = await run(bin, [
          ...ctx,
          "-n",
          j.namespace,
          "delete",
          "job",
          j.name,
          "--ignore-not-found",
          "--cascade=background",
          "--wait=false",
        ]);
        if (del.code === 0) purged++;
      }
      return purged;
    },
    async setNodeSchedulable(node, schedulable) {
      // cordon = mark unschedulable (no new pods land); uncordon reverses it. Neither evicts running pods (reversible).
      await run(bin, [...ctx, schedulable ? "uncordon" : "cordon", node]);
    },
    async getResourceJson(kind, name, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "get", kind, name, "-o", "json"]);
      if (res.code !== 0) return undefined; // absent or unreadable — the caller decides how loud to be
      try {
        return JSON.parse(res.stdout) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    },
    async deleteResource(kind, name, ns) {
      await run(bin, [...ctx, "-n", ns, "delete", kind, name, "--ignore-not-found", "--wait=false"]);
    },
    async patchResource(kind, name, ns, patch) {
      // Strategic merge — containers merge by name, so a single-container resources patch touches nothing else.
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "patch",
        kind,
        name,
        "--type=strategic",
        "-p",
        JSON.stringify(patch),
      ]);
      return res.code === 0 ? { ok: true } : { ok: false, message: (res.stderr || res.stdout).trim().slice(0, 300) };
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

// Default namespace the pool-tier shared stores live in (topology store-binding DEFAULT_POOL_NS) — where inspect looks for them.
export const DEFAULT_POOL_NAMESPACE = "everdict-shared";

// Age in whole seconds from a pod's RFC3339 creationTimestamp. undefined when absent/unparseable/negative.
export function k8sAgeSeconds(creationTimestamp: string | undefined, nowMs: number): number | undefined {
  if (!creationTimestamp) return undefined;
  const created = Date.parse(creationTimestamp);
  if (Number.isNaN(created)) return undefined;
  const seconds = Math.round((nowMs - created) / 1000);
  return seconds >= 0 ? seconds : undefined;
}

// K8s CPU quantity → millicores ("4"→4000, "3800m"→3800, "0.5"→500). undefined when absent/unparseable.
export function k8sCpuToMillicores(q: string | undefined): number | undefined {
  if (!q) return undefined;
  const s = q.trim();
  if (s.endsWith("m")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}

// K8s memory quantity → MiB ("8Gi"→8192, "512Mi"→512, "8000000Ki"→7812, "1G"→953, bytes→/1048576). undefined when unparseable.
export function k8sMemToMiB(q: string | undefined): number | undefined {
  if (!q) return undefined;
  const m = q.trim().match(/^([0-9.]+)([A-Za-z]*)$/);
  if (!m) return undefined;
  const val = Number(m[1]);
  if (!Number.isFinite(val)) return undefined;
  const unit = m[2] ?? "";
  const MiB = 1024 * 1024;
  const factor: Record<string, number> = {
    "": 1 / MiB, // bytes
    Ki: 1024 / MiB,
    Mi: 1,
    Gi: 1024,
    Ti: 1024 * 1024,
    K: 1000 / MiB,
    M: 1e6 / MiB,
    G: 1e9 / MiB,
    T: 1e12 / MiB,
  };
  const f = factor[unit];
  return f !== undefined ? Math.round(val * f) : undefined;
}

// Sum the committed load (cpu millicores / memory MiB ask) per node over the inspected workload rows — every
// namespace/platform, not just everdict, so the usage gauge reflects true node commitment (the rows are already
// running/pending only). A node with zero requests is omitted (so the fields stay absent). Pure, for unit testing.
export function usageByNode(
  rows: Array<{ node?: string; cpu?: number; memoryMb?: number }>,
): Record<string, { cpuUsed?: number; memoryMbUsed?: number }> {
  const acc: Record<string, { cpu: number; mem: number }> = {};
  for (const r of rows) {
    if (!r.node) continue;
    let a = acc[r.node];
    if (!a) {
      a = { cpu: 0, mem: 0 };
      acc[r.node] = a;
    }
    a.cpu += r.cpu ?? 0;
    a.mem += r.memoryMb ?? 0;
  }
  const out: Record<string, { cpuUsed?: number; memoryMbUsed?: number }> = {};
  for (const [node, v] of Object.entries(acc))
    out[node] = { ...(v.cpu > 0 ? { cpuUsed: v.cpu } : {}), ...(v.mem > 0 ? { memoryMbUsed: v.mem } : {}) };
  return out;
}

// Cluster-infra namespaces are protected from workload control — deleting kube-system's DaemonSets (CNI,
// kube-proxy, …) would take the cluster down, admin gate or not. A loud refusal, never a silent no-op.
const PROTECTED_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease"]);
export function assertMutableNamespace(ns: string): void {
  if (PROTECTED_NAMESPACES.has(ns))
    throw new BadRequestError(
      "BAD_REQUEST",
      { namespace: ns },
      `namespace '${ns}' is cluster infrastructure — workload control is refused.`,
    );
}

// A pod's ROOT controller — what terminate/resize must target (deleting a Deployment's pod just respawns it).
// ReplicaSet resolves one more hop to its Deployment; a pod with no owner is its own target ("Pod").
// undefined = the pod itself is absent/unreadable.
export async function resolveWorkloadOwner(
  api: Pick<K8sApi, "getResourceJson">,
  pod: string,
  ns: string,
): Promise<{ kind: string; name: string } | undefined> {
  type Owned = { metadata?: { ownerReferences?: Array<{ kind?: string; name?: string }> } };
  const obj = (await api.getResourceJson("pod", pod, ns)) as Owned | undefined;
  if (!obj) return undefined;
  const ref = (obj.metadata?.ownerReferences ?? []).find((r) => r.kind && r.name);
  if (!ref?.kind || !ref.name) return { kind: "Pod", name: pod };
  if (ref.kind === "ReplicaSet") {
    const rs = (await api.getResourceJson("replicaset", ref.name, ns)) as Owned | undefined;
    const rsRef = (rs?.metadata?.ownerReferences ?? []).find((r) => r.kind === "Deployment" && r.name);
    if (rsRef?.name) return { kind: "Deployment", name: rsRef.name };
    return { kind: "ReplicaSet", name: ref.name };
  }
  return { kind: ref.kind, name: ref.name };
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
    ...judgeEnv(job.judge), // per-run judge model config. The inline judge grader judges with this model.
    ...opts.secretEnv,
    // Judge provider key resolved per-job at dispatch (workspace tier → submitter personal fallback) — AFTER
    // secretEnv so the job-level credential wins over the backend's baked workspace tier.
    ...judgeAuthEnv(job.judge, job.judgeAuth),
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

// Write the kubeconfig (YAML value) to a temp file and return a path to use with kubectl --kubeconfig. Being a decrypted cluster
// credential, write it with mode 0600, and once dispatch finishes, remove the file+directory via cleanup() (don't leave it on disk for long).
export async function materializeKubeconfig(yaml: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "everdict-kcfg-"));
  const path = join(dir, "kubeconfig");
  await writeFile(path, yaml, { mode: 0o600 });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Launch the runner-agent as a K8s Job, poll for completion, then parse the CaseResult from the sentinel in the pod log.
// Isolation is namespace (per-tenant) + runtimeClassName (gVisor/kata). The K8s counterpart of NomadBackend.
export class K8sBackend implements Backend, Recoverable, Observable, Probeable, Inspectable, Reclaimable {
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

  // Current output of the case's newest job pod — live-progress tail (a pending pod reads as undefined and the
  // caller polls again). Sentinel payload stripped. Best-effort, never throws. The stream parameter is accepted
  // but ignored: a K8s pod log interleaves stdout and stderr in one stream (kubelet doesn't separate them), so
  // both selections read the same combined text.
  async logs(caseId: string, _stream?: LogStream): Promise<string | undefined> {
    try {
      return await this.withApi(async (api) => {
        const jobs = await api.jobsByLabel(`everdict.dev/case=${caseSlug(caseId)}`);
        const newest = (jobs ?? []).sort((a, b) =>
          (b.creationTimestamp ?? "").localeCompare(a.creationTimestamp ?? ""),
        )[0];
        if (!newest) return undefined;
        const text = await api.podLogs(newest.name, newest.namespace);
        return stripSentinel(text);
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

  // Live cluster view (read-only): reachability + version via the API server, then nodes, capacity, the live
  // everdict workload, and the pool shared-store Services. Each sub-read best-effort — a failure degrades to a
  // warning, never a throw. No job, no mutation. (A kubeconfig-auth cluster materializes the temp file once for all reads.)
  async inspect(): Promise<InspectRuntimeResult> {
    const warnings: string[] = [];
    try {
      return await this.withApi(async (api): Promise<InspectRuntimeResult> => {
        // Reachability + version (same call as probe) — a failure here is the whole-cluster verdict.
        let version: string;
        try {
          version = await api.serverVersion();
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          const reason = /unauthor|forbidden|401|403|credential|token/i.test(detail) ? "auth" : "unreachable";
          return { kind: "k8s", reachable: false, reason, detail, warnings };
        }
        const cluster = {
          version,
          ...(this.opts.namespace ? { namespace: this.opts.namespace } : {}),
        };

        // ALL running/pending pods across namespaces (everdict units + external services) — the ONE listing that
        // feeds both the workload view and the per-node committed-load gauges.
        const rawWorkload = await api.inspectWorkload();

        // Nodes (best-effort): allocatable totals + identity from the node list, real committed load summed from
        // the pod listing, and fs capacity/usage via the kubelet stats summary (per-node calls, capped).
        let nodes: InspectRuntimeResult["nodes"];
        const rawNodes = await api.inspectNodes();
        if (rawNodes) {
          const usage = rawWorkload ? usageByNode(rawWorkload) : undefined;
          if (!usage) warnings.push("node usage unavailable");
          const MiB = 1024 * 1024;
          const items: InspectNode[] = [];
          for (const [i, n] of rawNodes.entries()) {
            const merged: InspectNode = { ...n, ...(usage?.[n.name] ?? {}) };
            if (i < NODE_DETAIL_CAP) {
              const fs = await api.nodeFsStats(n.name);
              // The summary's real fs capacity beats the allocatable ephemeral-storage fallback from the node list.
              if (fs?.capacityBytes !== undefined && fs.capacityBytes > 0)
                merged.diskMbTotal = Math.round(fs.capacityBytes / MiB);
              if (fs?.usedBytes !== undefined && fs.usedBytes >= 0) merged.diskMbUsed = Math.round(fs.usedBytes / MiB);
            }
            items.push(merged);
          }
          nodes = { total: items.length, ready: items.filter((n) => n.ready).length, items };
        } else warnings.push("node listing failed");

        // Capacity (the same live count the scheduler gates on).
        let capacity: InspectRuntimeResult["capacity"];
        try {
          const c = await this.capacity();
          capacity = { total: c.total, used: c.used, free: Math.max(0, c.total - c.used) };
        } catch {
          warnings.push("capacity probe failed");
        }

        // Live workload rows — everdict units by their app label (name = job-name), external pods as "other"
        // (name = pod name, which is what namespace-scoped control targets).
        let workload: InspectWorkload[] | undefined;
        if (rawWorkload) {
          const now = Date.now();
          const rows: InspectWorkload[] = rawWorkload.map((p) => {
            const age = k8sAgeSeconds(p.creationTimestamp, now);
            // The app=everdict label is the k8s-native signal; a shared-store pod (deployed without it) still
            // classifies by the everdict-shared- naming convention.
            const role = p.everdict
              ? classifyWorkloadRole(p.name)
              : p.name.startsWith(SHARED_STORE_PREFIX)
                ? ("store" as const)
                : ("other" as const);
            return {
              id: p.namespace ? `${p.namespace}/${p.name}` : p.name,
              name: p.name,
              status: p.status,
              role,
              ...(age !== undefined ? { ageSeconds: age } : {}),
              ...(p.node ? { node: p.node } : {}),
              ...(p.namespace ? { namespace: p.namespace } : {}),
              ...(p.ownerKind ? { ownerKind: p.ownerKind } : {}),
              ...(p.cpu !== undefined ? { cpu: p.cpu } : {}),
              ...(p.memoryMb !== undefined ? { memoryMb: p.memoryMb } : {}),
            };
          });
          // Under the cap, everdict units win over external ones (stable sort keeps each group's own order).
          rows.sort((a, b) => Number(a.role === "other") - Number(b.role === "other"));
          if (rows.length > WORKLOAD_CAP)
            warnings.push(`workload truncated to ${WORKLOAD_CAP} of ${rows.length} units`);
          workload = rows.slice(0, WORKLOAD_CAP);
        } else warnings.push("workload listing failed");

        // Pool shared stores — a Service per store in the pool namespace, address = its stable Service DNS.
        let stores: InspectStore[] | undefined;
        const poolNs = this.opts.namespace ?? DEFAULT_POOL_NAMESPACE;
        const rawStores = await api.inspectStores(poolNs);
        if (rawStores)
          stores = rawStores.map((s) => ({
            name: s.name,
            status: "ready",
            ...(s.port !== undefined ? { address: `${s.name}.${poolNs}.svc.cluster.local:${s.port}` } : {}),
          }));
        else warnings.push("shared-store listing failed");

        return {
          kind: "k8s",
          reachable: true,
          detail: `K8s server ${version}`,
          cluster,
          ...(nodes ? { nodes } : {}),
          ...(capacity ? { capacity } : {}),
          ...(workload ? { workload } : {}),
          ...(stores ? { stores } : {}),
          warnings,
        };
      });
    } catch (e) {
      // withApi failed to even build the client (e.g. missing kubeconfig) — a config error, surfaced as unreachable.
      return {
        kind: "k8s",
        reachable: false,
        reason: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
        warnings,
      };
    }
  }

  // --- Reclaimable (destructive live-cluster control; runtimes:control-gated at the control plane) ---

  // Force-stop one unit by its InspectWorkload.name. Without a namespace: the legacy everdict-Job lookup across
  // namespaces. With one (external units carry it): resolve the pod's ROOT controller and delete IT — deleting a
  // Deployment's pod would just respawn (a restart, not a terminate); a name that isn't a pod falls back to a job
  // of that name in the namespace (an everdict unit addressed with its namespace). Best-effort/idempotent — but a
  // protected cluster-infra namespace (kube-system, …) is refused loudly, never silently skipped.
  async stopWorkload(name: string, namespace?: string): Promise<void> {
    if (namespace) assertMutableNamespace(namespace);
    try {
      await this.withApi(async (api) => {
        if (!namespace) return api.stopWorkloadJob(name);
        const owner = await resolveWorkloadOwner(api, name, namespace);
        if (!owner) return api.deleteResource("job", name, namespace);
        return api.deleteResource(owner.kind.toLowerCase(), owner.name, namespace);
      });
    } catch {
      // best-effort — the caller re-inspects
    }
  }

  // Delete every running/pending everdict EVAL pod's job older than the threshold (shared stores excluded, and
  // EXTERNAL pods — now present in the listing — are never swept). Returns the count.
  async reclaimIdle(olderThanSeconds: number): Promise<{ stopped: number }> {
    try {
      return await this.withApi(async (api) => {
        const pods = await api.inspectWorkload();
        if (!pods) return { stopped: 0 };
        const now = Date.now();
        const names = new Set<string>();
        for (const p of pods) {
          if (!p.everdict) continue; // an idle sweep must never touch external services
          if (classifyWorkloadRole(p.name) === "store") continue; // never reclaim a shared store
          const age = k8sAgeSeconds(p.creationTimestamp, now);
          if (age !== undefined && age >= olderThanSeconds) names.add(p.name);
        }
        for (const name of names) await api.stopWorkloadJob(name);
        return { stopped: names.size };
      });
    } catch {
      return { stopped: 0 };
    }
  }

  // Change an external unit's resource ask (cpu millicores / memory MiB) by patching its ROOT controller's pod
  // template (a rolling replace). Deliberately loud (see Reclaimable): unsupported targets — an everdict Job (its
  // pod template is immutable), a bare pod (no in-place resize), a multi-container pod (ambiguous) — are a clear
  // 4xx, never a silent no-op. Limits sitting below the new request are raised with it (K8s rejects request>limit).
  async resizeWorkload(
    name: string,
    resources: { cpu?: number; memoryMb?: number },
    namespace?: string,
  ): Promise<{ detail: string }> {
    if (resources.cpu === undefined && resources.memoryMb === undefined)
      throw new BadRequestError("BAD_REQUEST", { name }, "resize needs cpu and/or memoryMb.");
    if (!namespace)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name },
        "K8s resize targets an external unit — pass the unit's namespace (everdict eval Jobs are sized by the harness spec).",
      );
    assertMutableNamespace(namespace);
    return await this.withApi(async (api) => {
      const owner = await resolveWorkloadOwner(api, name, namespace);
      if (!owner) throw new NotFoundError("NOT_FOUND", { name, namespace }, "workload pod not found.");
      if (owner.kind === "Pod")
        throw new BadRequestError(
          "BAD_REQUEST",
          { name },
          "a bare pod cannot be resized in place — recreate it with new resources.",
        );
      if (owner.kind === "Job")
        throw new BadRequestError(
          "BAD_REQUEST",
          { name },
          "a K8s Job's pod template is immutable — resize is not supported.",
        );
      const kind = owner.kind.toLowerCase();
      const obj = await api.getResourceJson(kind, owner.name, namespace);
      if (!obj)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { kind: owner.kind, name: owner.name },
          "controller read failed for resize",
        );
      type Container = {
        name?: string;
        resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
      };
      const containers =
        (obj as { spec?: { template?: { spec?: { containers?: Container[] } } } }).spec?.template?.spec?.containers ??
        [];
      const container = containers[0];
      if (containers.length !== 1 || container?.name === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { name, containers: containers.length },
          "only single-container workloads can be resized (ambiguous target otherwise).",
        );
      const requests: Record<string, string> = {};
      const limits: Record<string, string> = {};
      if (resources.cpu !== undefined) {
        requests.cpu = `${resources.cpu}m`;
        const limit = k8sCpuToMillicores(container.resources?.limits?.cpu);
        if (limit !== undefined && limit < resources.cpu) limits.cpu = `${resources.cpu}m`;
      }
      if (resources.memoryMb !== undefined) {
        requests.memory = `${resources.memoryMb}Mi`;
        const limit = k8sMemToMiB(container.resources?.limits?.memory);
        if (limit !== undefined && limit < resources.memoryMb) limits.memory = `${resources.memoryMb}Mi`;
      }
      const patch = {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: container.name,
                  resources: { requests, ...(Object.keys(limits).length > 0 ? { limits } : {}) },
                },
              ],
            },
          },
        },
      };
      const result = await api.patchResource(kind, owner.name, namespace, patch);
      if (!result.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { kind: owner.kind, name: owner.name },
          `resize patch failed${result.message ? `: ${result.message}` : ""}`,
        );
      const parts = [
        ...(resources.cpu !== undefined ? [`cpu ${resources.cpu}m`] : []),
        ...(resources.memoryMb !== undefined ? [`memory ${resources.memoryMb}Mi`] : []),
      ];
      return { detail: `${owner.kind} ${owner.name} resized to ${parts.join(", ")} (rolling update)` };
    });
  }

  // GC completed (succeeded/failed) everdict jobs — reclaims what ttlSecondsAfterFinished hasn't swept yet.
  async purgeTerminal(): Promise<{ purged: number }> {
    try {
      return { purged: await this.withApi((api) => api.purgeCompletedJobs()) };
    } catch {
      return { purged: 0 };
    }
  }

  // Cordon (schedulable=false) / uncordon (true) a node — no new pods land there; running pods are not evicted (reversible).
  async setNodeSchedulable(node: string, schedulable: boolean): Promise<void> {
    try {
      await this.withApi((api) => api.setNodeSchedulable(node, schedulable));
    } catch {
      // best-effort
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
        // Carry the pod's termination reason so the CaseResult explains itself (e.g. Error, ContainerCannotRun).
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { name, ns, ...(reason ? { reason } : {}) },
          `K8s Job failed${reason ? ` — pod: ${reason}` : ""}`,
        );
      }
      await abortableDelay(interval, signal);
    }
    // A job that never progressed usually has a waiting pod (ImagePullBackOff, …) — name the cause, best-effort.
    const stuck = await api.podFailureReason(name, ns).catch(() => undefined);
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { name, ns, ...(stuck ? { reason: stuck } : {}) },
      `timed out waiting for K8s Job completion${stuck ? ` — pod: ${stuck}` : ""}`,
    );
  }
}
