import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOB_PAYLOAD_DIR,
  JOB_PAYLOAD_FILE_ENV,
  JOB_PAYLOAD_FS_GROUP,
  JOB_PAYLOAD_VOLUME,
  type Score,
  type VerifierInvocation,
  type VerifierJob,
  adoptedResultFrom,
  caseJobPayload,
  evalContainerSecretEnv,
  extractLiveEvents,
  isDefaultNetwork,
  jobPayloadWriteCommand,
  parseResult,
  parseVerifierResult,
  refuseUnenforceableNetwork,
  stripSentinel,
  verifierJobPayload,
} from "@everdict/contracts";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  InternalError,
  type KillOutcome,
  NotFoundError,
  OOM_KILLED,
  type RegistryAuth,
  type RuntimeWorkRef,
  type TraceEvent,
  UpstreamError,
  type WorkPresence,
  judgeEnv,
  worstKillOutcome,
} from "@everdict/contracts";
import type {
  CasePlacement,
  InspectNode,
  InspectRuntimeResult,
  InspectStore,
  InspectWorkload,
} from "@everdict/contracts/wire";
import {
  UNTRUSTED_POD_IDENTITY,
  assertHardenedIsolation,
  contentDigest,
  dockerAuthConfigJson,
  laneImageProvenance,
  pickRegistryAuth,
  registryAuthSecretName,
  registryAuthsOf,
} from "@everdict/domain";
import type { TrustZonePolicy } from "@everdict/domain";
import {
  type AdoptOutcome,
  type Backend,
  type BackendCapacity,
  type CaseRuntimeSample,
  type DispatchOptions,
  type Inspectable,
  type LogStream,
  type ManagedWorkControl,
  type ProbeResult,
  type Probeable,
  type Reclaimable,
  type VerifierDispatchHooks,
  type WorkAddressable,
  dispatchAborted,
  requireActivation,
  requireReservation,
} from "../backend.js";
import type { SecretProvider } from "../policy/secrets.js";
import { abortableDelay } from "./abortable-delay.js";
import {
  FAILURE_EVENT_CAP,
  FAILURE_LOG_TAIL_CAP,
  NODE_DETAIL_CAP,
  SHARED_STORE_PREFIX,
  WORKLOAD_CAP,
  classifyWorkloadRole,
} from "./inspect-common.js";
import { UNIT_LABEL, k8sNetworkPolicyFor, ownerReferencePatch } from "./k8s-network-policy.js";
import { mergePlacedImage, withWorldProof } from "./placement-image.js";
import { verifierCaseJob } from "./verifier-placement.js";

// --- kubectl abstraction (mockable in tests; the K8s version of NomadHttp) ---
export interface K8sApi {
  ensureNamespace(ns: string): Promise<void>;
  applyJob(manifest: unknown, ns: string): Promise<void>; // kubectl -n ns apply -f -
  jobStatus(name: string, ns: string): Promise<{ succeeded: number; failed: number }>;
  podLogs(name: string, ns: string): Promise<string>; // stdout of job/<name>
  // One-shot exec into the job's pod (sh -c command) — non-interactive; live terminal / screen capture.
  exec(name: string, ns: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  // ── A DELETE REPORTS WHAT IT DID (arch-review 52, Wave 3) ───────────────────────────────────────
  // Both used to return `Promise<void>` over a `kubectl` call whose exit code was discarded, so an API
  // server that refused the delete was indistinguishable from one that performed it — and the teardown
  // above them then certified freed compute on the strength of "the process exited". `--ignore-not-found`
  // exits 0 for "nothing matched" too, which is why the answer is read off stdout: kubectl names what it
  // deleted, and an empty listing with a zero exit is genuinely `absent`.
  deleteJob(name: string, ns: string): Promise<KillOutcome>;
  // Give a NetworkPolicy the Job as its owner, so the cluster's garbage collector removes it whenever the
  // Job goes — including the `ttlSecondsAfterFinished` path, where nothing of ours runs again. Reads the
  // Job's uid first, because an owner reference is not a name (arch-review 58 W5).
  patchNetworkPolicy(policy: string, ns: string, ownerJob: string): Promise<void>;
  // Force-stop by label across namespaces (kill(caseId) → everdict.dev/case=<slug>). No wait.
  deleteJobsByLabel(selector: string): Promise<KillOutcome>;
  // Adoption lookup — jobs matching a label selector across namespaces (boot recovery finds a dead CP's jobs).
  jobsByLabel(
    selector: string,
  ): Promise<Array<{ name: string; namespace: string; creationTimestamp?: string }> | undefined>;
  // Termination reason of the job's (failed) pod — e.g. "OOMKilled". Best-effort: undefined when unavailable.
  podFailureReason(name: string, ns: string): Promise<string | undefined>;
  // The job's pods with their live placement status (phase/node/restarts + the waiting|terminated reason, plus
  // the resource ask [millicores/MiB] and start time) — the case-scoped placement read (CaseInspectable).
  // undefined when the query itself fails (best-effort).
  podsForJob(
    name: string,
    ns: string,
  ): Promise<
    | Array<{
        name: string;
        phase?: string;
        node?: string;
        reason?: string;
        restarts?: number;
        cpu?: number;
        memoryMb?: number;
        startedAt?: string;
      }>
    | undefined
  >;
  // Namespace events attached to one object (a pod) — FailedScheduling / image-pull failures / kills, the WHY
  // feed behind a stuck placement. undefined when the query itself fails (best-effort).
  objectEvents(name: string, ns: string): Promise<Array<{ reason?: string; message: string; at?: string }> | undefined>;
  // The job pod's live resource usage from the metrics API (`kubectl top pod`) — the replay runtime plane's
  // producer read (CaseSampleable). undefined when metrics-server is absent / the pod is gone (best-effort).
  podTop(name: string, ns: string): Promise<{ cpuMillicores?: number; memoryMb?: number } | undefined>;
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
        gpuTotal?: number;
        gpuProduct?: string;
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

// Read a `kubectl delete --ignore-not-found` result honestly (arch-review 52, Wave 3).
//
// The exit code alone cannot answer this: `--ignore-not-found` exits 0 whether it deleted three Jobs or
// found none, and that is precisely the distinction a cancellation needs — "the work is gone because we
// stopped it" and "there was nothing there" are both convergence, but a non-zero exit is neither. kubectl
// prints one `<kind>/<name> deleted` line per object it removed, so an empty stdout with a clean exit is
// the `absent` case and anything else on a clean exit is `stopped`.
function deleteOutcome(what: string, res: RunResult): KillOutcome {
  if (res.code !== 0)
    return { status: "failed", reason: `kubectl delete ${what}: exit ${res.code} ${res.stderr.trim()}`.trim() };
  return res.stdout.includes("deleted") ? { status: "stopped" } : { status: "absent" };
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
    async podTop(name, ns) {
      // The metrics API's live usage for the job's pod ("<pod> <cpu>m <mem>Mi"). code!=0 covers both "no
      // metrics-server" and "pod gone" — either way there is no sample, never an error.
      const res = await run(bin, [...ctx, "-n", ns, "top", "pod", "-l", `job-name=${name}`, "--no-headers"]);
      if (res.code !== 0) return undefined;
      const line = res.stdout.split("\n").find((l) => l.trim() !== "");
      if (!line) return undefined;
      const [, cpuRaw, memRaw] = line.trim().split(/\s+/);
      const cpu = cpuRaw?.match(/^(\d+)m$/)?.[1];
      const mem = memRaw?.match(/^(\d+)Mi$/)?.[1];
      if (cpu === undefined && mem === undefined) return undefined;
      return {
        ...(cpu !== undefined ? { cpuMillicores: Number(cpu) } : {}),
        ...(mem !== undefined ? { memoryMb: Number(mem) } : {}),
      };
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
        // and it's what the TIMEOUT path needs to explain a job that never progressed. Exit codes ride along so a
        // bare 137 (SIGKILL — the OOM killer's signature, reported by some nodes WITHOUT the OOMKilled reason)
        // still classifies as an OOM instead of the generic "Job failed".
        'jsonpath={range .items[*]}{.status.containerStatuses[*].state.terminated.reason}{" "}{.status.containerStatuses[*].lastState.terminated.reason}{" "}{.status.containerStatuses[*].state.waiting.reason}{" "}{.status.containerStatuses[*].state.terminated.exitCode}{" "}{.status.containerStatuses[*].lastState.terminated.exitCode}{end}',
      ]);
      if (res.code !== 0) return undefined;
      const tokens = res.stdout.trim().split(/\s+/).filter(Boolean);
      if (tokens.includes("OOMKilled") || tokens.includes("137")) return "OOMKilled";
      const reason = tokens.find((t) => !/^\d+$/.test(t)); // named reasons win over bare non-137 exit codes
      return reason || undefined;
    },
    async podsForJob(name, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "get", "pods", "-l", `job-name=${name}`, "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string };
          spec?: {
            nodeName?: string;
            containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }>;
          };
          status?: {
            phase?: string;
            startTime?: string;
            containerStatuses?: Array<{
              restartCount?: number;
              state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number } };
              lastState?: { terminated?: { reason?: string; exitCode?: number } };
            }>;
          };
        }>;
        return items
          .filter((p) => p.metadata?.name)
          .map((p) => {
            const cs = p.status?.containerStatuses?.[0];
            const terminated = cs?.state?.terminated ?? cs?.lastState?.terminated;
            // A bare exit 137 is the OOM killer's signature — some nodes report it without the OOMKilled reason.
            const reason =
              terminated?.reason ??
              (terminated?.exitCode === 137 ? "OOMKilled" : undefined) ??
              cs?.state?.waiting?.reason;
            const requests = p.spec?.containers?.[0]?.resources?.requests;
            const cpu = k8sCpuToMillicores(requests?.cpu);
            const memoryMb = k8sMemToMiB(requests?.memory);
            return {
              name: p.metadata?.name as string,
              ...(p.status?.phase ? { phase: p.status.phase } : {}),
              ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
              ...(reason ? { reason } : {}),
              ...(cs?.restartCount !== undefined ? { restarts: cs.restartCount } : {}),
              ...(cpu !== undefined ? { cpu } : {}),
              ...(memoryMb !== undefined ? { memoryMb } : {}),
              ...(p.status?.startTime ? { startedAt: p.status.startTime } : {}),
            };
          });
      } catch {
        return undefined;
      }
    },
    async objectEvents(name, ns) {
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "get",
        "events",
        "--field-selector",
        `involvedObject.name=${name}`,
        "-o",
        "json",
      ]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          reason?: string;
          message?: string;
          lastTimestamp?: string | null;
          eventTime?: string | null;
        }>;
        return items
          .filter((e) => (e.message ?? "").trim() !== "")
          .map((e) => ({
            ...(e.reason ? { reason: e.reason } : {}),
            message: (e.message ?? "").trim(),
            ...(e.lastTimestamp || e.eventTime ? { at: (e.lastTimestamp || e.eventTime) as string } : {}),
          }));
      } catch {
        return undefined;
      }
    },
    async patchNetworkPolicy(policy, ns, ownerJob) {
      const read = await run(bin, [...ctx, "-n", ns, "get", "job", ownerJob, "-o", "jsonpath={.metadata.uid}"]);
      const uid = read.stdout.trim();
      // No uid, no owner — and no silent half-measure: a reference to nothing would be accepted and would
      // collect nothing, so an unpatched policy (visible, inert, selecting pods that are gone) is the honest
      // outcome of a read that did not answer.
      if (read.code !== 0 || uid === "") return;
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "patch",
        "networkpolicy",
        policy,
        "--type",
        "merge",
        "-p",
        JSON.stringify(ownerReferencePatch(ownerJob, uid)),
      ]);
      if (res.code !== 0) throw new Error(`patch networkpolicy ${policy}: ${res.stderr || res.stdout}`);
    },
    async deleteJob(name, ns) {
      return deleteOutcome(
        `job ${name}`,
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
        ]),
      );
    },
    async deleteJobsByLabel(selector) {
      return deleteOutcome(
        `jobs -l ${selector}`,
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
        ]),
      );
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
          metadata?: { name?: string; labels?: Record<string, string> };
          spec?: { unschedulable?: boolean };
          status?: {
            conditions?: Array<{ type?: string; status?: string }>;
            allocatable?: { cpu?: string; memory?: string; "ephemeral-storage"?: string; "nvidia.com/gpu"?: string };
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
          // GPU composition — allocatable "nvidia.com/gpu" is a plain integer string; the model is a node label.
          const gpuRaw = Number(n.status?.allocatable?.["nvidia.com/gpu"]);
          const gpuTotal = Number.isFinite(gpuRaw) && gpuRaw > 0 ? gpuRaw : undefined;
          const gpuProduct = n.metadata?.labels?.["nvidia.com/gpu.product"];
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
            ...(gpuTotal !== undefined ? { gpuTotal } : {}),
            ...(gpuProduct ? { gpuProduct } : {}),
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
            containers?: Array<{
              resources?: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
            }>;
          };
          status?: { phase?: string };
        }>;
        return items
          .filter((p) => p.status?.phase === "Running" || p.status?.phase === "Pending")
          .map((p) => {
            // The pod's resource ask (requests, limits standing in where absent) — hover detail + node usage bar.
            const { cpu, memoryMb } = podResourceAsk(p.spec?.containers);
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
              ...(cpu !== undefined ? { cpu } : {}),
              ...(memoryMb !== undefined ? { memoryMb } : {}),
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
  image: string; // job-runner image
  api?: K8sApi;
  context?: string; // kubeconfig context (e.g. kind-everdict)
  server?: string; // external API server URL (when authenticating with a bearer token instead of context)
  apiToken?: string; // K8s API bearer token (kubectl --token) — control-plane↔K8s API auth. Unrelated to the alloc env.
  // Full kubeconfig YAML (value). If set, per dispatch write it to a temp file (0600), authenticate via --kubeconfig, and remove afterward.
  // Takes precedence over context/server/apiToken. Being a cluster credential, it never enters the job (agent) env.
  kubeconfig?: string;
  secretEnv?: Record<string, string>; // auth to inject into the job (default when secrets is absent)
  // ── DOES THIS CLUSTER ACTUALLY ENFORCE NetworkPolicy? (arch-review 58, W5 follow-through) ──────
  //
  // A deny-all egress NetworkPolicy is the one network declaration a manifest can express, and applying one
  // to a cluster with no policy controller installed changes NOTHING — the object is accepted and silently
  // inert. So this is an OPERATOR'S statement, not a capability we infer: with it set, a case declaring
  // `network.mode: "none"` is placed behind the policy and the lane may claim the axis; without it, the case
  // is refused exactly as before. Claiming an axis on the strength of an accepted manifest would be the
  // failure this contract exists to prevent, one level up.
  enforcesNetwork?: boolean;
  secrets?: SecretProvider; // per-tenant secret scoping
  namespace?: string; // default namespace (when there's no tenant zone)
  runtimeClass?: string; // explicit runtimeClassName (gVisor=gvisor etc.). trustZones takes precedence.
  // Runtime-side placement binding (from RuntimeSpec, operator-owned) — pin jobs to a node pool + reserve GPUs.
  // The harness stays infra-agnostic; the cluster's own scheduler places onto the matching node.
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{ key: string; operator?: string; value?: string; effect?: string }>;
  gpu?: number; // reserve N GPUs per job (→ nvidia.com/gpu requests+limits)
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

// A pod's resource ask (cpu millicores + memory MiB) summed across its containers. K8s semantics: a container
// with no request defaults it to its limit, so limits stand in where requests are absent — external services
// commonly declare limits only, and without the fallback they'd read as having no allocation at all (blank
// hover detail + an unprefilled resize form). Pure, for unit testing.
export function podResourceAsk(
  containers:
    | Array<{
        resources?: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
      }>
    | undefined,
): { cpu?: number; memoryMb?: number } {
  let cpu = 0;
  let memoryMb = 0;
  for (const c of containers ?? []) {
    cpu += k8sCpuToMillicores(c.resources?.requests?.cpu) ?? k8sCpuToMillicores(c.resources?.limits?.cpu) ?? 0;
    memoryMb += k8sMemToMiB(c.resources?.requests?.memory) ?? k8sMemToMiB(c.resources?.limits?.memory) ?? 0;
  }
  return { ...(cpu > 0 ? { cpu } : {}), ...(memoryMb > 0 ? { memoryMb } : {}) };
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

export function k8sJobName(job: CaseJob, suffix?: string): string {
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

// ── LABEL VALUES MUST BE INJECTIVE, BECAUSE SELECTORS ARE DESTRUCTIVE (arch-review 52, Wave 2) ───────
//
// `caseSlug` is LOSSY twice over: it replaces every character outside [a-z0-9-] and it truncates. So
// `case-<46 a's>-alpha` and `case-<46 a's>-omega` — one long prefix, the discriminator at the end, the shape a
// generated benchmark's ids actually have — used to carry ONE `everdict.dev/case` value. That value is what
// kill deletes by and what adopt harvests by, so two distinct cases were one addressable unit: one case's
// cancellation stopped the other's job, and one case's adopt attributed the other's result.
//
// The fix is a discriminator, added ONLY when the slug lost information. An id that survives slugging
// unchanged already distinguishes itself, and leaving those values byte-identical keeps every job dispatched
// under the previous spelling addressable by the same selector.
const LABEL_VALUE_MAX = 63; // K8s label values: ≤63 chars, alphanumeric at both ends, [-_.] inside
// ── A DESTRUCTIVE SELECTOR DOES NOT SPEND A PROBABLY-UNIQUE NAME (arch-review 59 P2) ────────────────
//
// 32 chars of hex = 128 bits. This was 8 — 32 bits — under a comment calling it "collision-free at any batch
// size we place", which is not a property 32 bits has: it is a birthday bound, and the sibling sweep SELECTS
// ON THIS LABEL TO KILL. A collision puts another run's jobs inside a stop's blast radius. The exact
// `RuntimeWorkRef.externalJobId` is the primary coordinate, which is why this was never a P0 and is exactly
// why it was easy to leave: the weaker identifier is only reached on the paths nobody exercises.
//
// Still a legal label value (≤63 chars, alphanumeric at both ends), which is what made it short to begin with.
const LABEL_DIGEST_LEN = 32;

function labelValue(raw: string): string {
  const lossless = caseSlug(raw, LABEL_VALUE_MAX);
  if (lossless === raw) return lossless;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, LABEL_DIGEST_LEN);
  const head = caseSlug(raw, LABEL_VALUE_MAX - LABEL_DIGEST_LEN - 1);
  return head === "" ? digest : `${head}-${digest}`;
}

// What `everdict.dev/case` carries. Injective over case ids (see labelValue).
export function caseLabelValue(caseId: string): string {
  return labelValue(caseId);
}

// What `everdict.dev/run` carries — the coordinate that makes a stop addressable at all. A case id names a
// GROUP of executions (a re-evaluation, a shadow and a scheduled batch can all run case `c1` right now); the
// run is the one of them a cancellation was issued for.
export function runLabelValue(runId: string): string {
  return labelValue(runId);
}

// The selector a `killWork` sweeps by: every Job this RUN placed in this TENANT, and nothing else. Tenant is
// in it because a cross-tenant stop is the same defect as a cross-tenant read; the run is in it because the
// case is not an execution.
export function runWorkSelector(work: { tenant: string; runId: string }): string {
  return `app=everdict,everdict.dev/tenant=${work.tenant},everdict.dev/run=${runLabelValue(work.runId)}`;
}

function dispatchSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

// ── …AND NEITHER DOES A CREDENTIAL (arch-review 59 P1-security) ─────────────────────────────────────
//
// This used to be ONE name per namespace, so two dispatches in a tenant's namespace carrying different
// registry grants overwrote each other's Secret. The pod that pulled after the other's update pulled with the
// other's credential: the image fails, or it succeeds under an account that was never granted it, and the
// recipient isolation a short-lived grant exists to provide is gone. Verifier fan-out doubles the dispatch
// rate against one namespace, which makes that ordinary rather than rare.
//
// CONTENT-ADDRESSED: the same grant is the same Secret, so an idempotent apply stays idempotent and a
// concurrent dispatch with the same credential is not a race at all; a different grant is a different object.
// The digest is over the docker config the Secret carries, which IS what makes two grants different.
// Image credentials (transient job.registryAuths) → a dockerconfigjson Secret. When a credential covers case.image,
// dispatch applies it together with the Job as a List. Takes one or many — one docker config can hold several hosts.
export function k8sRegistryAuthSecret(auth: RegistryAuth | RegistryAuth[], ns: string): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: registryAuthSecretName(auth), namespace: ns, labels: { app: "everdict" } },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": Buffer.from(dockerAuthConfigJson(auth)).toString("base64") },
  };
}

// The variable the INIT container is exec'd with. Never on the agent's container — that is the point.
const PAYLOAD_ENV = "EVERDICT_JOB_PAYLOAD";

// CaseJob → K8s batch Job. The payload is the EVERDICT_CASE_JOB(base64) env. Isolation is runtimeClassName.
export function buildK8sJob(
  job: CaseJob,
  opts: K8sBackendOptions,
  name: string,
  ns: string,
  runtimeClassName?: string,
  // THE JUDGING HALF (arch-review 56, Wave K). When present this unit runs the verifier instead of the agent:
  // the same image, the same result contract, a different payload name — and the case job's own payload is
  // NOT set, which is what makes "the agent's container never held the plan" a property of the spec rather
  // than of somebody's discipline.
  verifierPayload?: string,
): Record<string, unknown> {
  // Enforce-or-refuse, decided while this is still pure — see `refuseUnenforceableNetwork` for why the
  // in-container check was the right decision at the wrong moment.
  // ── A COMBINATION THAT MAKES THE POLICY INERT IS A REFUSAL, NOT A DEGRADE (arch-review 59) ──────
  //
  // NetworkPolicy behaviour for a hostNetwork pod is undefined in Kubernetes, and the common implementations
  // simply do not match such a pod against a selector. So `enforcesNetwork` + `hostNetwork` is a lane that
  // applies a policy, attests the axis, and constrains nothing — the false attestation this whole change
  // exists to remove, arriving by configuration instead of by code.
  if (opts.enforcesNetwork && opts.hostNetwork && !isDefaultNetwork(job.evalCase.network))
    throw new BadRequestError(
      "BAD_REQUEST",
      { lane: "k8s" },
      "this runtime enables hostNetwork, where a NetworkPolicy does not apply, so a declared network world cannot be enforced here however the policy is written — run the case on a runtime without hostNetwork, or submit it without a network declaration.",
    );
  refuseUnenforceableNetwork(job.evalCase.network, "k8s", opts.enforcesNetwork ? { enforces: ["none"] } : undefined);
  // ── THE PAYLOAD, AND WHERE IT DOES NOT GO (arch-review 59 follow-through) ──────────────────────────
  //
  // Serialized here — THE ONE SERIALIZER (arch-review 56, Wave B) refuses a case whose grading depends on
  // material this lane would hand to the agent — and then handed to the INIT container rather than to the
  // agent's. See `JOB_PAYLOAD_FILE_ENV`: an env var is readable out of `/proc/<pid>/environ` for the life of the
  // process that was exec'd with it, and the agent under test is a child of exactly that process.
  const payload =
    verifierPayload !== undefined
      ? { kind: "verifier" as const, value: verifierPayload }
      : {
          kind: "case" as const,
          value: caseJobPayload(
            // …and the NETWORK axis, when this lane is the one that constrained it. `k8sNetworkPolicyFor`
            // answers a manifest exactly for the modes this lane renders, so "a policy was built" is the same
            // question as "may we attest it" — one answer, two uses (arch-review 59 P1-high).
            withWorldProof(
              job,
              "k8s",
              job.evalCase.resources,
              opts.enforcesNetwork && k8sNetworkPolicyFor("probe", job.evalCase.network)
                ? job.evalCase.network
                : undefined,
            ),
          ),
        };
  // WHERE the runner will find it — a path, which is what the agent's environment is allowed to carry.
  const payloadPath = `${JOB_PAYLOAD_DIR}/${payload.kind}`;
  const env: Record<string, string> = {
    [JOB_PAYLOAD_FILE_ENV[payload.kind]]: payloadPath,
    ...judgeEnv(job.judge), // per-run judge model config. The inline judge grader judges with this model.
    // The workspace tier, FILTERED to the model-auth vocabulary — see `evalContainerSecretEnv` for what
    // the whole tier used to hand the agent under test. One function for both lanes, because a tenant's
    // exposure must not depend on which orchestrator placed the job.
    ...evalContainerSecretEnv(opts.secretEnv),
    // Judge provider key resolved per-job at dispatch (workspace tier → submitter personal fallback) — AFTER
    // secretEnv so the job-level credential wins over the backend's baked workspace tier.
    // ── THE JUDGE'S KEY IS NOT IN THE AGENT'S ENVIRONMENT (arch-review 59 P0-security) ─────────
    //
    // A judgeAuthEnv(job.judge, job.judgeAuth) spread used to be injected here. The job-runner process then held the
    // tenant's provider credential in `process.env`, and `LocalDriver` execs the agent under test with
    // `{ ...process.env, ...opts.env }` — so `env | grep ANTHROPIC_API_KEY` read it, with no bypass. Moving
    // the key to the grading half in TypeScript (arch-review 58) changed nothing here: a narrower consumer is
    // not a narrower PROCESS.
    //
    // It is also redundant. The runner builds the judge env from `job.judgeAuth`, a field on the payload it
    // already decodes, and hands it to `runCase` as `graderEnv`. Nothing reads it out of the environment.
    //
    // It shared a NAME with the harness's own key, too — so injecting it did not merely add a credential, it
    // overwrote the one the agent legitimately needs with one meant for somebody else.
  };
  // Prefer the per-case image (e.g. the official SWE-bench prebuilt = deps+repo bundled), otherwise the default job-runner image.
  const image = job.evalCase.image ?? opts.image;
  // imagePullSecrets (dispatch applies the Secret above together) — only when a credential covers this image's host.
  // The GRANT itself, not a boolean: the Secret's name is derived from it, and the dispatch applies the
  // Secret from the same value — one name from one function, so a pod can never reference an object nobody
  // applied (arch-review 59 P1-security).
  const pullAuth = pickRegistryAuth(registryAuthsOf(job), image);
  const tenant = job.tenant ?? "default";
  // Harness-declared cpu/mem (command kind) + runtime-declared GPU → requests=limits (deterministic OOM; the
  // scheduler bin-packs by real weight, and an nvidia.com/gpu request lands the pod on a GPU node). Unset = defaults.
  //
  // ── THE CASE'S OWN DECLARATION IS ENFORCED HERE, OR NOWHERE (arch-review 57 P1-high) ──────────────
  //
  // Only `harnessSpec.resources` was read, so a box declared by the CASE reached no manifest — while the
  // in-container `LocalDriver` refused that same declaration, correctly, since a host process cannot enforce
  // one. A case declaring cpu/memory therefore could not run on this lane at all, and the container-task
  // corpora declare one routinely. The case wins where it speaks: it is the more specific statement about
  // this particular unit of work, and the harness spec is the default for everything it runs.
  const cres = job.evalCase.resources;
  const hres = {
    ...(job.harnessSpec?.kind === "command" ? job.harnessSpec.resources : undefined),
    ...(cres?.cpu !== undefined ? { cpu: cres.cpu } : {}),
    ...(cres?.memoryMb !== undefined ? { memoryMb: cres.memoryMb } : {}),
    ...(cres?.gpu !== undefined ? { gpu: cres.gpu } : {}),
  };
  // Harness-declared GPUs win over the runtime binding's blanket default (same "harness resources win" rule as cpu/mem).
  const gpuCount = hres?.gpu ?? opts.gpu;
  const resourceReqs: Record<string, string> = {};
  if (hres?.cpu !== undefined) resourceReqs.cpu = `${hres.cpu}m`;
  if (hres?.memoryMb !== undefined) resourceReqs.memory = `${hres.memoryMb}Mi`;
  if (gpuCount !== undefined) resourceReqs["nvidia.com/gpu"] = String(gpuCount);
  const resources =
    Object.keys(resourceReqs).length > 0 ? { requests: { ...resourceReqs }, limits: { ...resourceReqs } } : undefined;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: ns,
      // The identity a control call selects on. THREE coordinates, not one: the case says what ran (injective
      // now — see caseLabelValue), the tenant says whose trust zone it is, and the RUN says which of the
      // several concurrent executions of that case this Job is (arch-review 52, Wave 2). A stop scoped to
      // (tenant, run) reaches exactly the work its run placed; the case label alone reached every run's.
      // The run label is omitted for a job with no control-plane run id — nothing addresses those by run.
      labels: {
        app: "everdict",
        "everdict.dev/tenant": tenant,
        "everdict.dev/case": caseLabelValue(job.evalCase.id),
        ...(job.runId ? { "everdict.dev/run": runLabelValue(job.runId) } : {}),
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? 300,
      template: {
        // …and the PER-UNIT label. `app: everdict` is what a namespace-wide selector would match, so a
        // NetworkPolicy written against it would cut off every other job in the namespace rather than this
        // one's world (arch-review 58 W5).
        metadata: { labels: { app: "everdict", "everdict.dev/tenant": tenant, [UNIT_LABEL]: name } },
        spec: {
          restartPolicy: "Never",
          // No cluster identity for the agent under test — see `UNTRUSTED_POD_IDENTITY`. K8s mounts the
          // default ServiceAccount token unless a spec says otherwise, and this one did not.
          ...UNTRUSTED_POD_IDENTITY,
          // …and the group that makes the payload readable ACROSS the two images (arch-review 60 P1). K8s
          // chowns the payload volume to this GID and adds it as a supplementary group to every container in
          // the pod, so the recipient reads by group whatever UID its image declares — see
          // `jobPayloadWriteCommand` for why 0600-owned-by-the-writer could not work here.
          securityContext: { fsGroup: JOB_PAYLOAD_FS_GROUP },
          ...(runtimeClassName ? { runtimeClassName } : {}),
          ...(opts.nodeSelector ? { nodeSelector: opts.nodeSelector } : {}),
          ...(opts.tolerations ? { tolerations: opts.tolerations } : {}),
          ...(opts.hostNetwork ? { hostNetwork: true } : {}),
          // The Secret THIS dispatch applies, by the grant it carries — the two are one name from one
          // function, so a pod can never reference an object nobody applied.
          ...(pullAuth ? { imagePullSecrets: [{ name: registryAuthSecretName(pullAuth) }] } : {}),
          // A tmpfs the payload lives on for as long as it takes the runner to read and unlink it. `Memory`
          // rather than the default disk-backed emptyDir: an unlink on tmpfs IS the erasure, while a file on
          // a node's disk leaves its blocks until something else overwrites them.
          volumes: [{ name: JOB_PAYLOAD_VOLUME, emptyDir: { medium: "Memory" } }],
          // The step that holds the payload in an environment. It has TERMINATED before the agent's container
          // starts, so the process whose `/proc/<pid>/environ` carries it no longer exists — which is the
          // whole repair, and the reason this is an initContainer rather than a line in the entrypoint.
          //
          // It runs the RUNNER image (ours, always present) even when the agent's container runs the tenant's
          // own: nothing here may depend on a shell existing in an image somebody else built.
          initContainers: [
            {
              name: "payload",
              image: opts.image,
              imagePullPolicy: opts.imagePullPolicy ?? "IfNotPresent",
              command: jobPayloadWriteCommand(payloadPath, PAYLOAD_ENV),
              env: [{ name: PAYLOAD_ENV, value: payload.value }],
              volumeMounts: [{ name: JOB_PAYLOAD_VOLUME, mountPath: JOB_PAYLOAD_DIR }],
            },
          ],
          containers: [
            {
              name: "agent",
              image,
              imagePullPolicy: opts.imagePullPolicy ?? "IfNotPresent",
              env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
              volumeMounts: [{ name: JOB_PAYLOAD_VOLUME, mountPath: JOB_PAYLOAD_DIR }],
              ...(resources ? { resources } : {}),
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

// The placement projection for ONE named Job. Shared by the exact read and its legacy twin so the two cannot
// describe the same object differently — the only thing that differs between them is which object.
async function placementOf(api: K8sApi, name: string, namespace: string): Promise<CasePlacement | undefined> {
  const base = { job: name, namespace };
  const pods = (await api.podsForJob(name, namespace)) ?? [];
  // backoffLimit 0 ⇒ normally one pod; prefer a live one over a leftover terminal sibling.
  const pod = pods.find((p) => p.phase === "Running" || p.phase === "Pending") ?? pods.at(-1);
  if (!pod) return { ...base, phase: "queued", events: [] };
  const events = (await api.objectEvents(pod.name, namespace)) ?? [];
  const scheduling = events.filter((e) => e.reason === "FailedScheduling").at(-1);
  const phase =
    pod.phase === "Running"
      ? ("running" as const)
      : pod.phase === "Succeeded" || pod.phase === "Failed"
        ? ("dead" as const)
        : scheduling
          ? ("blocked" as const)
          : ("starting" as const);
  const started = pod.startedAt ? Date.parse(pod.startedAt) : Number.NaN;
  const age = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : undefined;
  return {
    ...base,
    phase,
    unit: pod.name,
    ...(pod.node ? { node: pod.node } : {}),
    ...(phase === "blocked" && scheduling ? { blockedReason: scheduling.message } : {}),
    ...(pod.restarts !== undefined && pod.restarts > 0 ? { restarts: pod.restarts } : {}),
    ...(pod.reason === "OOMKilled" ? { oom: true } : {}),
    ...(pod.cpu !== undefined ? { cpu: pod.cpu } : {}),
    ...(pod.memoryMb !== undefined ? { memoryMb: pod.memoryMb } : {}),
    ...(age !== undefined ? { ageSeconds: age } : {}),
    events: events.slice(-20).map((e) => ({
      ...(e.reason ? { type: e.reason } : {}),
      message: e.message,
      ...(e.at ? { at: e.at } : {}),
    })),
  };
}

export class K8sBackend implements Backend, WorkAddressable, ManagedWorkControl, Probeable, Inspectable, Reclaimable {
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

  // (Interactive execStream — observability ⑥ — is Nomad-only for now: K8s reaches the pod through kubectl with a
  // per-dispatch materialized kubeconfig, so a long-lived interactive stream needs the temp file kept open for the
  // stream's lifetime — a follow-up. One-shot exec above already works. The WS route degrades gracefully.)

  // ── THE EXACT-WORK CONTROL SURFACE (ManagedWorkControl — arch-review 53, Wave B) ──────────────────
  //
  // Each of these is the twin of a case-id read above, resolving the object by the handle's own name instead
  // of by "newest job carrying this case label". They share the projections (`placementOf`, `parseResult`,
  // `extractLiveEvents`) with their legacy twins so the two cannot describe the same job differently — what
  // differs is only WHICH job, which is the entire defect.
  async adoptWork(work: RuntimeWorkRef): Promise<AdoptOutcome> {
    const ns = work.namespace ?? this.opts.namespace ?? "default";
    try {
      return await this.withApi(async (api): Promise<AdoptOutcome> => {
        // Does the object the handle names exist? A cluster that cannot answer THROWS, and the catch below
        // turns that into `unknown` — re-dispatching on an unestablished liveness may double-spend, which is
        // what `unknown` exists to prevent. A 404 for this exact name is `absent`, and safe to re-dispatch.
        const jobs = await api.jobsByLabel(`everdict.dev/run=${caseLabelValue(work.runId)}`);
        if (jobs === undefined) return { status: "unknown" };
        if (!jobs.some((j) => j.name === work.externalJobId)) return { status: "absent" };
        await this.waitForJob(api, work.externalJobId, ns);
        // The ONE reader, which chooses the protocol from the handle — a verifier prints a different
        // document, and adopting it with the case parser is what made a run defer forever (arch-review 59 P1).
        const result = adoptedResultFrom(await api.podLogs(work.externalJobId, ns), work);
        await api.deleteJob(work.externalJobId, ns).catch(() => {});
        return { status: "adopted", adopted: result };
      });
    } catch {
      return { status: "unknown" };
    }
  }

  async logsForWork(work: RuntimeWorkRef, _stream?: LogStream): Promise<string | undefined> {
    try {
      const text = await this.rawWorkLogs(work);
      return text === undefined ? undefined : stripSentinel(text);
    } catch {
      return undefined;
    }
  }

  async eventsForWork(work: RuntimeWorkRef): Promise<TraceEvent[] | undefined> {
    try {
      const text = await this.rawWorkLogs(work);
      return text === undefined ? undefined : extractLiveEvents(text);
    } catch {
      return undefined;
    }
  }

  async execInWork(
    work: RuntimeWorkRef,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
    try {
      return await this.withApi(async (api) =>
        api.exec(work.externalJobId, work.namespace ?? this.opts.namespace ?? "default", command),
      );
    } catch {
      return undefined;
    }
  }

  async inspectWork(work: RuntimeWorkRef): Promise<CasePlacement | undefined> {
    try {
      return await this.withApi(async (api) =>
        placementOf(api, work.externalJobId, work.namespace ?? this.opts.namespace ?? "default"),
      );
    } catch {
      return undefined;
    }
  }

  async sampleWork(work: RuntimeWorkRef): Promise<CaseRuntimeSample | undefined> {
    try {
      return await this.withApi(async (api) => {
        const top = await api.podTop(work.externalJobId, work.namespace ?? this.opts.namespace ?? "default");
        if (!top || (top.cpuMillicores === undefined && top.memoryMb === undefined)) return undefined;
        return {
          ...(top.cpuMillicores !== undefined ? { cpuPct: top.cpuMillicores / 10 } : {}),
          ...(top.memoryMb !== undefined ? { memBytes: top.memoryMb * 1024 * 1024 } : {}),
        };
      });
    } catch {
      return undefined;
    }
  }

  private async rawWorkLogs(work: RuntimeWorkRef): Promise<string | undefined> {
    return await this.withApi(async (api) =>
      api.podLogs(work.externalJobId, work.namespace ?? this.opts.namespace ?? "default"),
    );
  }

  // Stop the work a HANDLE names, and nothing else (WorkAddressable — arch-review 52, Wave 2).
  //
  // Two deletions, both inside the same blast radius — this run's own compute in its own tenant:
  //   ① the exact Job the handle names, in the namespace it was placed in. This is the whole point of the
  //      handle: one dispatch, one object, addressed by the orchestrator's own name for it.
  //   ② a sweep of `(tenant, run)`-labelled Jobs, because ONE RUN CAN HAVE MORE THAN ONE. A re-dispatch after
  //      a retryable throw applies a new Job under a fresh random name, and only the newest handle was
  //      stamped on the ledger; a crash between apply and stamp leaves a Job with no handle at all. Neither
  //      is reachable by ①, and both are unambiguously this run's.
  // What is NOT here is the thing that made the old kill dangerous: no case-only selector, so a concurrent
  // run of the same case — and, since the case label became injective, a different case that truncated to the
  // same value — is not this cancellation's business. Best-effort/idempotent, never throws.
  // ── THE JUDGING HALF, AS ITS OWN UNIT (arch-review 56, Wave K) ─────────────────────────────────
  //
  // The same image and the same result contract as a case, dispatched a second time with the verifier payload
  // instead of the case one. It carries no reservation and no attempt row: a verifier unit is not one of the
  // case's execution attempts, it is how the case's verdict is reached, and giving it an attempt would put a
  // second physical execution on the ledger for a case that ran once.
  //
  // The scores come back through `parseResult` — the same sentinel the case entry prints — so a verifier that
  // died mid-run surfaces as a parse failure here rather than as a silent absence.
  async dispatchVerifier(job: VerifierJob, hooks?: VerifierDispatchHooks): Promise<VerifierInvocation> {
    // ── PLACED BY THE SAME RULES AS THE AGENT (arch-review 57 P0-verifier) ──────────────────────────
    //
    // This read `this.opts.namespace ?? "default"` and the backend's blanket `secretEnv`, so the half of the
    // case that produces the VERDICT could run outside the tenant's trust zone while running the task's own
    // untrusted image. `resolve` is what applies the zone, its namespace, the hardened runtimeClass and the
    // tenant's own secrets — the defect was never that `resolve` is wrong, it is that nobody asked it.
    const spec = verifierCaseJob(job);
    const { ns, runtimeClassName, secretEnv } = await this.resolve(spec);
    const name = `everdict-verify-${job.caseId
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase()
      .slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;

    // BEFORE the Job exists (arch-review 57 P0-verifier). The name is already decided, so the ledger can
    // record where this work will be — which is what lets a cancellation find the verifier at all.
    // Built ONCE and used by both seams: a reservation authorizes one external object, so the id the
    // activation re-presents has to be the id that was reserved. Two literals here is how those drift.
    const work = { tenant: job.tenant, runId: job.runId, externalJobId: name, namespace: ns };
    await hooks?.authority.reserve(work);
    return await this.withApi(async (api) => {
      // …AND RE-PRESENTED, immediately before the Job exists. This step was missing here while the shared
      // dispatch had it: `dispatchVerifier` is the same protocol with a different payload, and writing it out
      // longhand meant this copy silently did not receive the transition arch-review 58 added (arch-review 59
      // P0-verifier). Without it a cancellation could kill the ledger's work, probe it ABSENT because no
      // object existed yet, settle every child, COMPLETE — and the paused verifier then created the Job.
      await requireActivation(verifierCaseJob(job), work, hooks?.authority);
      await api.ensureNamespace(ns);
      const manifest = buildK8sJob(
        spec,
        { ...this.opts, secretEnv },
        name,
        ns,
        runtimeClassName,
        verifierJobPayload(job),
      );
      // THE SAME EGRESS DENIAL THE AGENT GOT, in the same order (arch-review 59 P1-high). `network` now
      // travels on the job, so the manifest above has already been refused if this lane cannot enforce what
      // the case declared; what was still missing is the policy itself. Applied BEFORE the Job, because the
      // reverse order leaves precisely the window the declaration exists to close — and here that window is
      // the container holding the hidden tests and computing the reward.
      const netPolicy = k8sNetworkPolicyFor(name, job.network);
      if (netPolicy) await api.applyJob(netPolicy, ns);
      await api.applyJob(manifest, ns);
      // …and the ownerRef, so the cluster's GC reclaims the policy with the Job. Best-effort for the reason
      // the agent lane gives: a failed patch leaks an inert policy, a failed ORDER would have leaked a
      // verifier that graded with the network open.
      if (netPolicy) await api.patchNetworkPolicy(`${name}-egress`, ns, name).catch(() => undefined);
      try {
        await this.waitForJob(api, name, ns);
        // The INVOCATION, not bare numbers (arch-review 57 P1). Everything below is known right here and
        // was previously discarded: which procedure ran (the plan's own digest, carried on the job), what it
        // read (the workspace snapshot's), where it ran, and in which world. A verdict that cannot say those
        // is a number a replay has to take on faith.
        // READ BACK, not copied from the request (arch-review 59 P1). The envelope names the unit it judged;
        // `parseVerifierResult` refuses one that names a different unit, and the invocation is then built
        // from the container's own account rather than from what this lane asked for. The two are equal on
        // the happy path — which is exactly why stamping the request read as correct for as long as it did.
        const envelope = parseVerifierResult(await api.podLogs(name, ns), {
          runId: job.runId,
          caseId: job.caseId,
          planDigest: job.plan.digest,
          workspaceDigest: contentDigest(job.workspace),
        });
        return {
          planDigest: envelope.planDigest,
          workspaceDigest: envelope.workspaceDigest,
          work: { tenant: job.tenant, runId: job.runId, externalJobId: name, namespace: ns },
          imageProvenance:
            job.image !== undefined ? laneImageProvenance(job.image, "the Kubernetes API") : { kind: "none" },
          scores: envelope.scores,
        };
      } finally {
        await api.deleteJob(name, ns);
      }
    });
  }

  // ── DOES THIS WORK STILL EXIST? (arch-review 56, Wave G) ────────────────────────────────────────
  //
  // `deleteJob` above passes `--wait=false`, so `stopped` means the API server RECORDED the delete — the pod
  // is still running through its grace period, its finalizers and any in-flight image pull. A cancellation
  // that converged there certified a batch's compute freed while it was still burning.
  //
  // Answered from the same label selector the delete used, so the probe and the stop address exactly the same
  // objects. Deliberately not `inspectWork`: that returns a display PHASE, and it reports `queued` for a Job
  // whose pods do not exist yet — indistinguishable from a Job that is gone.
  async probeWork(work: RuntimeWorkRef): Promise<WorkPresence> {
    try {
      return await this.withApi(async (api): Promise<WorkPresence> => {
        const jobs = await api.jobsByLabel(runWorkSelector(work));
        // A listing that FAILED is not an empty cluster (L2) — the teardown stays owed.
        if (jobs === undefined)
          return { kind: "unknown", reason: `list jobs for ${work.externalJobId}: the cluster did not answer` };
        return jobs.length === 0 ? { kind: "absent" } : { kind: "live" };
      });
    } catch (err) {
      return {
        kind: "unknown",
        reason: `list jobs for ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async killWork(work: RuntimeWorkRef): Promise<KillOutcome> {
    try {
      return await this.withApi(async (api): Promise<KillOutcome> => {
        const outcomes: KillOutcome[] = [];
        if (work.namespace !== undefined)
          outcomes.push(
            await api.deleteJob(work.externalJobId, work.namespace).catch(
              (err: unknown): KillOutcome => ({
                status: "failed",
                reason: `delete job ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
              }),
            ),
          );
        outcomes.push(await api.deleteJobsByLabel(runWorkSelector(work)));
        // Both arms address THIS run's own compute, so the run's stop has converged only if both did — the
        // exact Job the handle names AND the label sweep that catches the re-dispatched siblings it cannot.
        return worstKillOutcome(outcomes);
      });
    } catch (err) {
      // The api itself could not be built (kubeconfig materialization, auth) — nothing was even attempted.
      return {
        status: "failed",
        reason: `k8s killWork ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
      };
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
    job: CaseJob,
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

  // ── NAME THE WORK WITHOUT CREATING IT (arch-review 53, Wave A) ─────────────────────────────────────
  //
  // Pure: it computes the Job name and resolves the namespace, and touches no cluster. That it CAN be pure is
  // the fact the whole protocol rests on — a K8s Job's name is ours to choose, so the control plane can make
  // the name durable before asking the cluster for anything, and a crash mid-dispatch then leaves an intent
  // that names exactly one object rather than a case id that names a group.
  async reserve(job: CaseJob): Promise<RuntimeWorkRef> {
    const { ns } = await this.resolve(job);
    // Unique per dispatch — two concurrent batches over the same dataset would otherwise collide on the same
    // Job name (409 AlreadyExists → dispatch error). The capacity probe matches the label, not the name.
    const name = k8sJobName(job, dispatchSuffix());
    return {
      tenant: job.tenant ?? "default",
      runId: job.runId ?? "",
      externalJobId: name,
      namespace: ns,
      ...(job.attemptId !== undefined ? { attemptId: job.attemptId } : {}),
    };
  }

  async dispatch(job: CaseJob, options?: DispatchOptions): Promise<CaseResult> {
    if (options?.signal?.aborted) throw dispatchAborted(job); // cancelled before we applied the Job
    const { ns, runtimeClassName, secretEnv } = await this.resolve(job);
    // The name is decided here, from the resolution this dispatch already has — `reserve()` is the same
    // computation exposed for a caller that wants the coordinate without the dispatch.
    const name = k8sJobName(job, dispatchSuffix());
    const work: RuntimeWorkRef = {
      tenant: job.tenant ?? "default",
      runId: job.runId ?? "",
      externalJobId: name,
      namespace: ns,
      ...(job.attemptId !== undefined ? { attemptId: job.attemptId } : {}),
    };
    // THE INTENT IS DURABLE BEFORE THE OBJECT EXISTS (arch-review 53, Wave A) — AND WE HOLD THE PROOF
    // (arch-review 54, Phase 1). Awaited, and its rejection takes the dispatch down BEFORE `applyJob`: a
    // caller that cannot record where this work will be must not get the work. The old ordering reported the
    // handle after the apply, so a control plane that died in between left a running Job addressable only by
    // its case id, which is other runs' jobs too.
    //
    // Ordering alone left the second half open. The hook could RESOLVE having written nothing (no ledger, no
    // attempt id, an UPDATE matching no row) and this line could not tell that apart from a durable
    // reservation. So a job that names a run requires the store's answer, and a missing hook is refused here
    // rather than treated as "this deployment does not track placements".
    // BEFORE the reservation, not after (arch-review 58 W5). The spec builder refuses this too, but by
    // then a reservation has been spent and an activation burned on a case that will never place — a
    // refusal that arrives after an effect is the shape this whole series keeps finding. It is a pure,
    // total decision, so it belongs at the first moment it can be made.
    refuseUnenforceableNetwork(
      job.evalCase.network,
      "k8s",
      this.opts.enforcesNetwork ? { enforces: ["none"] } : undefined,
    );
    if (job.runId !== undefined) await requireReservation(job, work, options?.authority);
    // …and the reservation is re-presented HERE, immediately before the Job exists (arch-review 57 P0). A
    // proof with no lifetime let a paused driver create work after a cancellation had verified there was
    // none; this is the transition that makes such a driver fail instead.
    await requireActivation(job, work, options?.authority);
    // …and ONLY NOW is this run "started" (arch-review 54, Phase 1). The flip used to fire before both the
    // reservation and the apply, so a reservation failure left a record marked `running` with no Job anywhere.
    // With kubeconfig auth, the temp kubeconfig lives only for the one job (removed after completion/failure). cleanup after deleteJob.
    return this.withApi(async (api) => {
      await api.ensureNamespace(ns);
      const manifest = buildK8sJob(job, { ...this.opts, secretEnv }, name, ns, runtimeClassName);
      // For a workspace-registry image, apply the dockerconfigjson Secret together with the Job (List) — fixed name, idempotent upsert.
      const image = job.evalCase.image ?? this.opts.image;
      const auth = pickRegistryAuth(registryAuthsOf(job), image);
      const payload = auth
        ? { apiVersion: "v1", kind: "List", items: [k8sRegistryAuthSecret(auth, ns), manifest] }
        : manifest;
      // ── THE WORLD BEFORE THE POD (arch-review 58, W5 follow-through) ────────────────────────
      //
      // Applied FIRST, so there is never an instant where a pod is running and its egress is not yet denied.
      // The reverse order would leave exactly the window the declaration exists to close, and it would be
      // invisible: the case would run, mostly offline, and score as if it had been.
      //
      // Only when the operator has SAID this cluster enforces NetworkPolicy — see `enforcesNetwork`. Without
      // that, `refuseUnenforceableNetwork` above has already turned the case away, so this is unreachable
      // rather than skipped.
      const netPolicy = k8sNetworkPolicyFor(name, job.evalCase.network);
      if (netPolicy) await api.applyJob(netPolicy, ns);
      const t0 = Date.now();
      await api.applyJob(payload, ns);
      // ── STARTED MEANS THE OBJECT EXISTS (arch-review 60 P0) ──────────────────────────────────────
      //
      // This fired before `ensureNamespace`, so the run flipped to `running` and the attempt was stamped
      // `executing` while nothing had been created. The cancellation reads state to decide what may still be
      // born, and `executing` is in neither of its guards — probe absent, certificate zero, and the paused
      // submitter then created the Job. Rule `protocol`: a lifecycle stamp names an observed fact.
      //
      // After the apply, so the ledger's `executing` is a statement about an object a teardown can address,
      // and the states that can still cause a birth are exactly the ones `mayStillCreateWork` names.
      options?.onStarted?.();
      // …and now the policy learns whose dependent it is. `ttlSecondsAfterFinished` deletes the Job on the
      // ordinary path and knows nothing about a policy beside it, so the cluster's own garbage collector is
      // what cleans up — which needs the uid the Job only has once it exists. Best-effort: a failed patch
      // leaks an inert policy selecting pods that are gone, where a failed ORDER would have leaked a case
      // that ran with the network open.
      if (netPolicy) await api.patchNetworkPolicy(`${name}-egress`, ns, name).catch(() => undefined);
      try {
        await this.waitForJob(api, name, ns, options?.signal);
        const result = parseResult(await api.podLogs(name, ns));
        // The infra-plane record of this dispatch (pod identity/node + the namespace events with their REAL
        // timestamps) — appended to the trace so the sealed trajectory keeps the orchestrator's account after
        // the Job is deleted in the finally below. Best-effort: a read miss just leaves the record shorter.
        result.trace = [...result.trace, ...(await this.infraEvents(api, name, ns, t0))];
        // The image THIS lane placed, added to what the in-container driver could see — which is nothing,
        // since it pulled nothing (arch-review 57 P1-high). See `mergePlacedImage`.
        //
        // From the REFERENCE, not yet from the pod: `status.containerStatuses[].imageID` carries the digest
        // the kubelet actually pulled, which is an observation rather than an inference and strictly better
        // for a mutable tag. Reading it is a separate API round trip on a path that is already deleting the
        // Job, so it is left for the wave that gives this lane a PlacementReceipt; until then an unpinned tag
        // is honestly `unresolved{lane_cannot_report}` rather than dishonestly `none`.
        return mergePlacedImage(result, job, "the Kubernetes API");
      } finally {
        // On an aborted wait this finally is exactly the reclaim — the submitted Job is deleted, not left running.
        await api.deleteJob(name, ns);
      }
    });
  }

  // Pod identity + namespace events → infra trace events (scope "placement"). Captured BEFORE the finally
  // deletes the Job — the last moment the pod and its events are reachable.
  private async infraEvents(api: K8sApi, name: string, ns: string, t0: number): Promise<TraceEvent[]> {
    try {
      const pods = (await api.podsForJob(name, ns)) ?? [];
      const pod = pods.at(-1);
      const out: TraceEvent[] = [
        {
          t: 0,
          kind: "infra",
          scope: "placement",
          event: "submitted",
          message: `k8s job ${name} (namespace ${ns})`,
          at: new Date(t0).toISOString(),
        },
      ];
      if (!pod) return out;
      const placedMs = Date.now();
      out.push({
        t: Math.max(0, placedMs - t0),
        kind: "infra",
        scope: "placement",
        event: "placed",
        message: `pod ${pod.name}${pod.node ? ` on ${pod.node}` : ""}`,
        unit: pod.name,
        ...(pod.node ? { node: pod.node } : {}),
        at: new Date(placedMs).toISOString(),
      });
      const events = (await api.objectEvents(pod.name, ns).catch(() => undefined)) ?? [];
      for (const e of events.slice(-20)) {
        const atMs = e.at ? Date.parse(e.at) : Number.NaN;
        const epochMs = Number.isFinite(atMs) ? atMs : Date.now();
        out.push({
          t: Math.max(0, epochMs - t0),
          kind: "infra",
          scope: "placement",
          ...(e.reason ? { event: e.reason } : {}),
          message: e.message,
          unit: pod.name,
          ...(pod.node ? { node: pod.node } : {}),
          at: new Date(epochMs).toISOString(),
        });
      }
      return out.sort((a, b) => a.t - b.t);
    } catch {
      return []; // best-effort — the infra record must never fail a run
    }
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
        // Failure evidence, captured NOW — the Job (and its pod log) is deleted in dispatch's finally right
        // after this throw. classifyFailure lifts extra.placement/logTail onto the CaseFailure.
        const evidence = await this.failureEvidence(api, name, ns, reason);
        if (reason === "OOMKilled")
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { name, ns, signal: OOM_KILLED, ...evidence },
            "task OOM-killed — raise the harness's resources.memoryMb (infra, not an agent failure)",
          );
        // Carry the pod's termination reason so the CaseResult explains itself (e.g. Error, ContainerCannotRun).
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { name, ns, ...(reason ? { reason } : {}), ...evidence },
          `K8s Job failed${reason ? ` — pod: ${reason}` : ""}`,
        );
      }
      await abortableDelay(interval, signal);
    }
    // A job that never progressed usually has a waiting pod (ImagePullBackOff, …) — name the cause, best-effort.
    const stuck = await api.podFailureReason(name, ns).catch(() => undefined);
    const evidence = await this.failureEvidence(api, name, ns, stuck);
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { name, ns, ...(stuck ? { reason: stuck } : {}), ...evidence },
      `timed out waiting for K8s Job completion${stuck ? ` — pod: ${stuck}` : ""}`,
    );
  }

  // Failure evidence at the last reachable moment (dispatch's finally deletes the Job right after the throw):
  // the pod's identity/node + its scheduling/kubelet events + the pod log tail (sentinel-stripped, tail-capped).
  // Best-effort and TOTAL — an unreadable sub-read simply contributes nothing.
  private async failureEvidence(
    api: K8sApi,
    name: string,
    ns: string,
    reason: string | undefined,
  ): Promise<{ placement?: { unit?: string; node?: string; events?: string[] }; logTail?: string }> {
    const pods = await api.podsForJob(name, ns).catch(() => undefined);
    const pod = pods?.at(-1);
    const eventLines = pod
      ? ((await api.objectEvents(pod.name, ns).catch(() => undefined)) ?? [])
          .map((e) => `${e.reason ? `${e.reason}: ` : ""}${e.message}`.trim())
          .filter((line) => line !== "")
          .slice(-FAILURE_EVENT_CAP)
      : [];
    const events = eventLines.length > 0 ? eventLines : reason ? [reason] : [];
    const placement = {
      ...(pod?.name ? { unit: pod.name } : {}),
      ...(pod?.node ? { node: pod.node } : {}),
      ...(events.length > 0 ? { events } : {}),
    };
    const logText = await api
      .podLogs(name, ns)
      .then((t) => stripSentinel(t).trim())
      .catch(() => "");
    return {
      ...(Object.keys(placement).length > 0 ? { placement } : {}),
      ...(logText !== "" ? { logTail: logText.slice(-FAILURE_LOG_TAIL_CAP) } : {}),
    };
  }
}
