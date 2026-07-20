import { spawn } from "node:child_process";
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
import { assertHardenedIsolation, imageUsesRegistryHost } from "@everdict/domain";
import type { TrustZonePolicy } from "@everdict/domain";
import {
  type AdoptOutcome,
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ExecStreamHandle,
  type Inspectable,
  type LogStream,
  type Observable,
  type ProbeResult,
  type Probeable,
  type Reclaimable,
  type Recoverable,
  type Shellable,
  dispatchAborted,
} from "../backend.js";
import type { SecretProvider } from "../policy/secrets.js";
import { abortableDelay } from "./abortable-delay.js";
import { EVERDICT_PREFIX, NODE_DETAIL_CAP, WORKLOAD_CAP, classifyWorkloadRole } from "./inspect-common.js";

// --- Nomad HTTP abstraction (mockable in tests) ---
export interface NomadHttp {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

// The Nomad HTTP client. If apiToken is present, attaches X-Nomad-Token (ACL auth) to every request.
export function fetchHttp(addr: string, apiToken?: string, fetchImpl?: typeof fetch): NomadHttp {
  const base = addr.replace(/\/$/, "");
  const f = fetchImpl ?? fetch;
  return {
    async request(method, path, body) {
      const headers: Record<string, string> = {};
      if (body) headers["content-type"] = "application/json";
      if (apiToken) headers["x-nomad-token"] = apiToken; // control-plane↔Nomad API auth
      const res = await f(`${base}${path}`, {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export interface NomadBackendOptions {
  addr: string; // Nomad HTTP endpoint, e.g. http://nomad.internal:4646
  image: string; // runner-agent image (in-house registry)
  apiToken?: string; // Nomad ACL token (X-Nomad-Token) — control-plane↔Nomad API auth. Unrelated to the alloc env.
  http?: NomadHttp;
  secretEnv?: Record<string, string>; // auth to inject into the alloc (e.g. CLAUDE_CODE_OAUTH_TOKEN). The default when secrets is absent.
  secrets?: SecretProvider; // per-tenant secret scoping — inject only that tenant's keys per job (no leakage).
  datacenters?: string[];
  runtime?: string; // docker isolation runtime (e.g. "runsc" = gVisor). trustZones takes precedence if present.
  namespace?: string; // default namespace (when there's no tenant zone)
  trustZones?: TrustZonePolicy; // per-tenant isolation policy — enforces runtime/namespace per job.
  cpuMhz?: number;
  memMb?: number;
  pollIntervalMs?: number;
  // Dead-job purge is OPT-IN: purging a job whose alloc a client still tracks nils the alloc's job reference and
  // panics the client's alloc watcher (observed live on a dev-mode agent, with immediate AND 60s-deferred purges).
  // Real deployments size client.gc_max_allocs for eval churn instead (the actionable 404 below names it); enable
  // purge only where the cluster is known to tolerate it.
  purgeDeadJobs?: boolean; // default false
  // Injectable exec runner (test seam) — default shells to the `nomad` CLI (WS exec is CLI-only in practice).
  // (bin, args, opts) → {code, stdout, stderr}. The default passes NOMAD_ADDR/NOMAD_TOKEN via env.
  execRunner?: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  purgeDelayMs?: number; // age before a dead job is purge-swept when enabled (default 60s; 0 = immediate for tests)
  maxPolls?: number;
  // Patience for a BLOCKED evaluation with no alloc (unplaceable resources) before failing the dispatch with
  // nomad's exhausted-dimension verdict (default 2 min). Short blocked spells (capacity freeing) are tolerated;
  // without this an unplaceable job silently grinds the full alloc-poll budget (~30 min).
  failOnBlockedEvalMs?: number;
  // This cluster's concurrent-job cap (for capacity-aware placement). If a function, dynamically reads the value the autoscaler changes.
  maxConcurrent?: number | (() => number);
  // Declared memory envelope (RuntimeSpec.memoryBudgetMb) — the Scheduler caps the sum of in-flight
  // harness-declared memory against it. Absent = slots-only admission.
  memoryBudgetMb?: number;
  // Declared CPU envelope (RuntimeSpec.cpuBudget) — same admission contract, resources.cpu units.
  cpuBudget?: number;
}

// --- Nomad job spec (only the needed parts typed) ---
interface NomadTask {
  Name: string;
  Driver: string;
  // auth = docker registry auth (the JSON API representation of the HCL auth block = an array) — when case.image is a workspace registry.
  Config: { image: string; runtime?: string; auth?: Array<{ username: string; password: string }> };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
}
export interface NomadJobSpec {
  Job: {
    ID: string;
    Type: string;
    Namespace?: string;
    Datacenters: string[];
    TaskGroups: Array<{
      Name: string;
      Count: number;
      RestartPolicy: { Attempts: number; Mode: string };
      Tasks: NomadTask[];
    }>;
  };
}

export function nomadJobId(job: AgentJob, suffix?: string): string {
  return `everdict-${job.evalCase.id}${suffix ? `-${suffix}` : ""}`;
}

// One task event as the alloc API reports it (Type = short phase, DisplayMessage = the human cause).
export interface NomadTaskEvent {
  Type?: string;
  DisplayMessage?: string;
  Details?: Record<string, string>;
}

export function eventsIndicateOom(events: NomadTaskEvent[]): boolean {
  // Details.oom_killed carries "true"/"false" — the docker driver may report the kill ONLY there
  // (Type "Terminated", message "Exit Code: 137"), so a text match on "oom" alone misses it.
  return events.some(
    (e) =>
      e.Details?.oom_killed === "true" || `${e.Type ?? ""} ${e.DisplayMessage ?? ""}`.toLowerCase().includes("oom"),
  );
}

// The human cause of an alloc failure, from its task events — so "alloc failed" carries WHY (an image pull
// denial reads as an image problem, not a mushy infra shrug). Prefer the FIRST event that looks like a failure —
// the root cause precedes its policy consequences ("Not Restarting", "Killing"); fall back to the last event
// with any message. Truncated — this lands inside an error message.
export function summarizeAllocFailure(events: NomadTaskEvent[]): string | undefined {
  const described = events.filter((e) => (e.DisplayMessage ?? "").trim().length > 0);
  const failureLike = described.filter((e) =>
    /fail|error|denied|not restart|kill|exceed|timeout/i.test(`${e.Type ?? ""} ${e.DisplayMessage ?? ""}`),
  );
  const cause = failureLike[0] ?? described.at(-1);
  if (!cause) return undefined;
  const text = `${cause.Type ? `${cause.Type}: ` : ""}${cause.DisplayMessage ?? ""}`.trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// --- Runtime inspection (read-only cluster view) parse helpers — pure, so they unit-test without a live Nomad. ---

// A Nomad node list stub — only the fields inspect reads (all optional; the list endpoint omits full resources).
export interface NomadNodeStub {
  ID?: string;
  Name?: string;
  Status?: string; // "ready" | "down" | "initializing" | "disconnected"
  Datacenter?: string;
  Drivers?: Record<string, { Healthy?: boolean } | undefined>;
  SchedulingEligibility?: string; // "eligible" | "ineligible" (cordoned)
}

export function nomadNodeToInspect(n: NomadNodeStub): InspectNode {
  const status = n.Status ?? "unknown";
  const docker = n.Drivers?.docker;
  return {
    name: n.Name ?? "node",
    status,
    ready: status === "ready",
    ...(n.Datacenter ? { datacenter: n.Datacenter } : {}),
    ...(docker && typeof docker.Healthy === "boolean" ? { dockerHealthy: docker.Healthy } : {}),
    ...(n.SchedulingEligibility ? { schedulable: n.SchedulingEligibility === "eligible" } : {}),
  };
}

// /v1/node/:id → the node's total schedulable resources (CPU MHz, memory MiB) + host identity from the
// fingerprinted Attributes (OS, arch, kernel, docker version, Nomad client version, IP, local storage).
// Best-effort: an unparseable/absent body yields {}, and each absent attribute just stays off the node.
export function nomadNodeResources(
  text: string,
): Pick<
  InspectNode,
  | "cpuTotal"
  | "memoryMbTotal"
  | "os"
  | "arch"
  | "kernel"
  | "containerRuntime"
  | "agentVersion"
  | "address"
  | "diskMbTotal"
  | "diskMbUsed"
> {
  try {
    const d = JSON.parse(text) as {
      NodeResources?: { Cpu?: { CpuShares?: number }; Memory?: { MemoryMB?: number } };
      Attributes?: Record<string, string | undefined>;
    };
    const cpu = d.NodeResources?.Cpu?.CpuShares;
    const mem = d.NodeResources?.Memory?.MemoryMB;
    const attr = d.Attributes ?? {};
    const os = [attr["os.name"], attr["os.version"]].filter(Boolean).join(" ");
    const kernel = [attr["kernel.name"], attr["kernel.version"]].filter(Boolean).join(" ");
    const dockerVersion = attr["driver.docker.version"];
    // unique.storage.* are byte counts fingerprinted as strings; used = total − free (only when both parse sanely).
    const bytesTotal = Number(attr["unique.storage.bytestotal"]);
    const bytesFree = Number(attr["unique.storage.bytesfree"]);
    const MiB = 1024 * 1024;
    const diskMbTotal = Number.isFinite(bytesTotal) && bytesTotal > 0 ? Math.round(bytesTotal / MiB) : undefined;
    const diskMbUsed =
      diskMbTotal !== undefined && Number.isFinite(bytesFree) && bytesFree >= 0 && bytesTotal >= bytesFree
        ? Math.round((bytesTotal - bytesFree) / MiB)
        : undefined;
    return {
      ...(typeof cpu === "number" ? { cpuTotal: cpu } : {}),
      ...(typeof mem === "number" ? { memoryMbTotal: mem } : {}),
      ...(os ? { os } : {}),
      ...(attr["cpu.arch"] ? { arch: attr["cpu.arch"] } : {}),
      ...(kernel ? { kernel } : {}),
      ...(dockerVersion ? { containerRuntime: `docker ${dockerVersion}` } : {}),
      ...(attr["nomad.version"] ? { agentVersion: attr["nomad.version"] } : {}),
      ...(attr["unique.network.ip-address"] ? { address: attr["unique.network.ip-address"] } : {}),
      ...(diskMbTotal !== undefined ? { diskMbTotal } : {}),
      ...(diskMbUsed !== undefined ? { diskMbUsed } : {}),
    };
  } catch {
    return {};
  }
}

// A Nomad alloc list stub — inspect reads these to list the live workload (everdict units + external jobs).
export interface NomadAllocStub {
  ID?: string;
  JobID?: string;
  Name?: string;
  Namespace?: string;
  JobType?: string; // "service" | "batch" | "system" — surfaced as the unit's ownerKind
  ClientStatus?: string; // "running" | "pending" | "complete" | "failed" | ...
  NodeName?: string;
  CreateTime?: number; // int64 NANOSECONDS since epoch
  // Summed across the alloc's tasks (CPU MHz + memory MiB) — the alloc's resource ask, for the per-node usage bar.
  AllocatedResources?: { Tasks?: Record<string, { Cpu?: { CpuShares?: number }; Memory?: { MemoryMB?: number } }> };
}

// Sum an alloc's per-task CPU (MHz) + memory (MiB). undefined when the list stub omits AllocatedResources.
export function nomadAllocResources(a: NomadAllocStub): { cpu?: number; memoryMb?: number } {
  const tasks = a.AllocatedResources?.Tasks;
  if (!tasks) return {};
  let cpu = 0;
  let memoryMb = 0;
  for (const t of Object.values(tasks)) {
    cpu += t.Cpu?.CpuShares ?? 0;
    memoryMb += t.Memory?.MemoryMB ?? 0;
  }
  return { ...(cpu > 0 ? { cpu } : {}), ...(memoryMb > 0 ? { memoryMb } : {}) };
}

// /v1/node/:id/allocations → the node's committed resources across EVERY alloc on it (all jobs/namespaces, not just
// everdict): the sum of running/pending AllocatedResources. This is the true node load — a node packed with other
// platforms' jobs reads busy even with no everdict units on it. Best-effort: an unparseable body yields {}.
export function nomadNodeAllocated(text: string): { cpuUsed?: number; memoryMbUsed?: number } {
  try {
    const allocs = JSON.parse(text) as NomadAllocStub[];
    let cpu = 0;
    let memoryMb = 0;
    for (const a of allocs) {
      if (a.ClientStatus !== "running" && a.ClientStatus !== "pending") continue;
      const r = nomadAllocResources(a);
      cpu += r.cpu ?? 0;
      memoryMb += r.memoryMb ?? 0;
    }
    return { ...(cpu > 0 ? { cpuUsed: cpu } : {}), ...(memoryMb > 0 ? { memoryMbUsed: memoryMb } : {}) };
  } catch {
    return {};
  }
}

// Alloc age in whole seconds. CreateTime is nanoseconds; nowMs is Date.now(). undefined when unknown/nonsensical.
export function nomadAllocAgeSeconds(createTimeNs: number | undefined, nowMs: number): number | undefined {
  if (createTimeNs === undefined || createTimeNs <= 0) return undefined;
  const seconds = Math.round(nowMs / 1000 - createTimeNs / 1e9);
  return seconds >= 0 ? seconds : undefined;
}

// /v1/agent/self → the cluster identity fields (name/version). Best-effort: an unparseable body yields {} (it did reach).
export function parseNomadSelf(text: string): { name?: string; version?: string } {
  let self: {
    member?: { Name?: string };
    config?: { Version?: { Version?: string } | string };
    stats?: { nomad?: { version?: string } };
  } = {};
  try {
    self = JSON.parse(text);
  } catch {
    return {};
  }
  const name = self.member?.Name;
  const version =
    self.stats?.nomad?.version ?? (typeof self.config?.Version === "object" ? self.config.Version?.Version : undefined);
  return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
}

// Per-dispatch uniqueness — two concurrent batches over the same dataset (or a retry of a finished one) would
// otherwise submit the SAME job id: Nomad treats that as a job update, and waitForAlloc's allocs[0] can then read
// the PREVIOUS dead alloc's logs as this case's result. A fresh id per dispatch removes both hazards; the
// capacity probe matches on the `everdict-` prefix, so it still counts these.
function dispatchSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

// AgentJob → Nomad batch job spec. The job payload is carried in the EVERDICT_AGENT_JOB(base64) env.
export function buildNomadJob(job: AgentJob, opts: NomadBackendOptions, jobId?: string): NomadJobSpec {
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
  // For a workspace-registry image, docker auth (transient job credentials) — only when the host matches.
  const registryAuth = job.registryAuth;
  const auth =
    registryAuth && imageUsesRegistryHost(image, registryAuth.host)
      ? [{ username: registryAuth.username ?? "everdict", password: registryAuth.password }]
      : undefined;
  return {
    Job: {
      ID: jobId ?? nomadJobId(job),
      Type: "batch",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: [
        {
          Name: "eval",
          Count: 1,
          RestartPolicy: { Attempts: 0, Mode: "fail" },
          Tasks: [
            {
              Name: "agent",
              Driver: "docker",
              Config: {
                image,
                ...(opts.runtime ? { runtime: opts.runtime } : {}),
                ...(auth ? { auth } : {}),
              },
              Env: env,
              // Harness-declared resources win (heavier harnesses get real bin-packing; starvation reads as infra).
              Resources: {
                CPU:
                  (job.harnessSpec?.kind === "command" ? job.harnessSpec.resources?.cpu : undefined) ??
                  opts.cpuMhz ??
                  1000,
                MemoryMB:
                  (job.harnessSpec?.kind === "command" ? job.harnessSpec.resources?.memoryMb : undefined) ??
                  opts.memMb ??
                  1024,
              },
            },
          ],
        },
      ],
    },
  };
}

// Default exec runner — spawn a local CLI (nomad) with addr/token in env.
function spawnRunner(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// The child-process surface streamHandleFor needs — a structural subset of Node's spawned ChildProcess (stdio:"pipe"),
// so the handle-building logic is testable with a fake instead of a real `nomad` spawn.
export interface StreamChild {
  readonly stdin: { write(chunk: string): void; on(event: "error", listener: (err: Error) => void): void };
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal: "SIGKILL"): void;
}

// Wrap a spawned interactive shell process into an ExecStreamHandle. Pure (no spawn) so it's unit-testable.
export function streamHandleFor(child: StreamChild): ExecStreamHandle {
  // Eager error sinks: a spawn failure (e.g. `nomad` not on PATH) or a stdin EPIPE emits an async 'error' event —
  // with no listener that is an UNCAUGHT exception that crashes the control plane. Register no-ops up front so the
  // process is safe even when the consumer never calls onError; real onError callbacks fan out on top.
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  return {
    write: (data) => {
      try {
        child.stdin.write(data);
      } catch {
        // the shell already exited — dropping a keystroke on a dead shell is fine (best-effort terminal input)
      }
    },
    onData: (cb) => {
      child.stdout.on("data", (d) => cb(String(d)));
      child.stderr.on("data", (d) => cb(String(d)));
    },
    onError: (cb) => child.on("error", (err) => cb(err)),
    onExit: (cb) => child.on("close", (code) => cb(code)),
    close: () => child.kill("SIGKILL"),
  };
}

// Launch the runner-agent as a Nomad batch alloc, poll for completion, then
// parse the CaseResult from the sentinel in the stdout log.
export class NomadBackend implements Backend, Recoverable, Observable, Shellable, Probeable, Inspectable, Reclaimable {
  private readonly http: NomadHttp;

  constructor(private readonly opts: NomadBackendOptions) {
    this.http = opts.http ?? fetchHttp(opts.addr, opts.apiToken);
  }

  // Capacity: total=configured cap, used=count of in-flight everdict jobs observed in the cluster (live probe, all namespaces).
  // If the probe fails, leave used=0 and gate only via the scheduler's in-flight.
  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    const total = (typeof mc === "function" ? mc() : mc) ?? 20;
    try {
      const res = await this.http.request("GET", "/v1/jobs?prefix=everdict-&namespace=*");
      if (res.status < 300) {
        const jobs = JSON.parse(res.text) as Array<{ Status?: string }>;
        const used = jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
        return {
          total,
          used,
          ...(this.opts.memoryBudgetMb !== undefined ? { memoryBudgetMb: this.opts.memoryBudgetMb } : {}),
          ...(this.opts.cpuBudget !== undefined ? { cpuBudget: this.opts.cpuBudget } : {}),
        };
      }
    } catch {
      // probe failed → used 0
    }
    return {
      total,
      used: 0,
      ...(this.opts.memoryBudgetMb !== undefined ? { memoryBudgetMb: this.opts.memoryBudgetMb } : {}),
      ...(this.opts.cpuBudget !== undefined ? { cpuBudget: this.opts.cpuBudget } : {}),
    };
  }

  // Connection test — check reachability + ACL auth via /v1/agent/self without a job (an ACL cluster requires X-Nomad-Token).
  async probe(): Promise<ProbeResult> {
    try {
      const res = await this.http.request("GET", "/v1/agent/self");
      if (res.status < 300) {
        let name: string | undefined;
        try {
          name = (JSON.parse(res.text) as { member?: { Name?: string } }).member?.Name;
        } catch {
          // ignore a body-parse failure — it did reach.
        }
        return { reachable: true, detail: name ? `Nomad agent: ${name}` : "Nomad agent responded" };
      }
      if (res.status === 401 || res.status === 403)
        return {
          reachable: false,
          reason: "auth",
          detail: `auth failed (${res.status}) — check the ACL token (authSecret).`,
        };
      return { reachable: false, reason: "error", detail: `Nomad ${res.status}: ${res.text.slice(0, 200)}` };
    } catch (e) {
      return { reachable: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // Live cluster view (read-only): reachability + identity via /v1/agent/self, then nodes, capacity, and the live
  // everdict workload (+ shared stores) — each sub-read best-effort so a partial-cluster failure degrades to a
  // warning instead of a throw. No job, no mutation.
  async inspect(): Promise<InspectRuntimeResult> {
    const warnings: string[] = [];
    // Reachability + identity (same call as probe) — a failure here is the whole-cluster verdict.
    let cluster: { name?: string; version?: string; datacenters?: string[]; namespace?: string };
    try {
      const res = await this.http.request("GET", "/v1/agent/self");
      if (res.status === 401 || res.status === 403)
        return {
          kind: "nomad",
          reachable: false,
          reason: "auth",
          detail: `auth failed (${res.status}) — check the ACL token (authSecret).`,
          warnings,
        };
      if (res.status >= 300)
        return {
          kind: "nomad",
          reachable: false,
          reason: "error",
          detail: `Nomad ${res.status}: ${res.text.slice(0, 200)}`,
          warnings,
        };
      cluster = { ...parseNomadSelf(res.text), ...(this.opts.namespace ? { namespace: this.opts.namespace } : {}) };
    } catch (e) {
      return {
        kind: "nomad",
        reachable: false,
        reason: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
        warnings,
      };
    }

    // Nodes (best-effort) — also the source of the cluster's datacenter set.
    let nodes: InspectRuntimeResult["nodes"];
    try {
      const res = await this.http.request("GET", "/v1/nodes");
      if (res.status < 300) {
        const stubs = JSON.parse(res.text) as NomadNodeStub[];
        const items: InspectNode[] = [];
        for (const [i, stub] of stubs.entries()) {
          const node = nomadNodeToInspect(stub);
          // Per-node total + committed resources (for the usage bar) — two extra calls per node, capped so a big
          // cluster stays bounded. Totals from /v1/node/:id; the real load (all jobs) from the node's alloc list.
          if (stub.ID && i < NODE_DETAIL_CAP) {
            const nodeId = encodeURIComponent(stub.ID);
            try {
              const d = await this.http.request("GET", `/v1/node/${nodeId}`);
              if (d.status < 300) Object.assign(node, nomadNodeResources(d.text));
            } catch {
              // omit this node's totals
            }
            try {
              const a = await this.http.request("GET", `/v1/node/${nodeId}/allocations`);
              if (a.status < 300) Object.assign(node, nomadNodeAllocated(a.text));
            } catch {
              // omit this node's committed load
            }
          }
          items.push(node);
        }
        nodes = { total: items.length, ready: items.filter((n) => n.ready).length, items };
        const dcs = [...new Set(items.map((n) => n.datacenter).filter((d): d is string => Boolean(d)))];
        if (dcs.length > 0) cluster = { ...cluster, datacenters: dcs };
      } else warnings.push(`node listing failed (Nomad ${res.status})`);
    } catch {
      warnings.push("node listing failed");
    }

    // Capacity (the same live count the scheduler gates on).
    let capacity: InspectRuntimeResult["capacity"];
    try {
      const c = await this.capacity();
      capacity = { total: c.total, used: c.used, free: Math.max(0, c.total - c.used) };
    } catch {
      warnings.push("capacity probe failed");
    }

    // Live workload from the alloc list (running/pending only) — every unit on the cluster, everdict-placed AND
    // external (other platforms' jobs), so the node view shows what actually occupies each node + shared stores.
    // resources=true is required: without it the list stub omits AllocatedResources, so every unit's cpu/memoryMb
    // would read unknown (blank hover detail + an unprefilled resize form).
    let workload: InspectWorkload[] | undefined;
    let stores: InspectStore[] | undefined;
    try {
      const res = await this.http.request("GET", "/v1/allocations?namespace=*&resources=true");
      if (res.status < 300) {
        const now = Date.now();
        const rows: InspectWorkload[] = (JSON.parse(res.text) as NomadAllocStub[])
          .filter((a) => a.ClientStatus === "running" || a.ClientStatus === "pending")
          .map((a) => {
            const name = a.JobID ?? a.Name ?? "everdict-job";
            const age = nomadAllocAgeSeconds(a.CreateTime, now);
            return {
              id: a.ID ?? name,
              name,
              status: a.ClientStatus ?? "unknown",
              role: classifyWorkloadRole(name),
              ...(age !== undefined ? { ageSeconds: age } : {}),
              ...(a.NodeName ? { node: a.NodeName } : {}),
              ...(a.Namespace ? { namespace: a.Namespace } : {}),
              ...(a.JobType ? { ownerKind: a.JobType } : {}),
              ...nomadAllocResources(a),
            };
          });
        // Under the cap, everdict units win over external ones (stable sort keeps each group's own order).
        rows.sort((a, b) => Number(a.role === "other") - Number(b.role === "other"));
        if (rows.length > WORKLOAD_CAP) warnings.push(`workload truncated to ${WORKLOAD_CAP} of ${rows.length} units`);
        workload = rows.slice(0, WORKLOAD_CAP);
        // Shared stores = the store-role units (deduped by name). Nomad ports are dynamic, so address is left unknown.
        const byName = new Map<string, InspectStore>();
        for (const r of workload)
          if (r.role === "store" && !byName.has(r.name)) byName.set(r.name, { name: r.name, status: r.status });
        stores = [...byName.values()];
      } else warnings.push(`workload listing failed (Nomad ${res.status})`);
    } catch {
      warnings.push("workload listing failed");
    }

    return {
      kind: "nomad",
      reachable: true,
      detail: cluster.name ? `Nomad agent: ${cluster.name}` : "Nomad reachable",
      ...(Object.keys(cluster).length > 0 ? { cluster } : {}),
      ...(nodes ? { nodes } : {}),
      ...(capacity ? { capacity } : {}),
      ...(workload ? { workload } : {}),
      ...(stores ? { stores } : {}),
      warnings,
    };
  }

  // Apply/enforce the tenant zone/secrets per job: untrusted requires strong isolation, a dedicated namespace, and inject only that tenant's keys.
  private async effectiveOpts(job: AgentJob): Promise<NomadBackendOptions> {
    const tenant = job.tenant ?? "default";
    const zone = this.opts.trustZones?.resolve(tenant);
    if (zone) assertHardenedIsolation(zone);
    // Secret scoping: if a provider exists, only that tenant's; otherwise the existing secretEnv.
    const secretEnv = this.opts.secrets ? await this.opts.secrets.secretsFor(tenant) : this.opts.secretEnv;
    if (!zone) return { ...this.opts, secretEnv };
    return {
      ...this.opts,
      secretEnv,
      runtime: zone.isolationRuntime,
      namespace: zone.namespace ?? this.opts.namespace,
    };
  }

  async dispatch(job: AgentJob, options?: DispatchOptions): Promise<CaseResult> {
    if (options?.signal?.aborted) throw dispatchAborted(job); // cancelled before we even submitted
    options?.onStarted?.(); // past the Scheduler's wait queue — we're submitting the alloc now → flip the run to running
    const opts = await this.effectiveOpts(job);
    const ns = opts.namespace;
    const jobId = nomadJobId(job, dispatchSuffix()); // unique per dispatch (concurrent same-case batches + no stale-alloc reads)
    const submit = await this.http.request("POST", "/v1/jobs", buildNomadJob(job, opts, jobId));
    if (submit.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "Nomad job submission failed");
    }
    try {
      const allocId = await this.waitForAlloc(jobId, ns, options?.signal);
      const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
      );
      if (logs.status >= 300)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: logs.status, alloc: allocId },
          // 404 here almost always means the CLIENT already garbage-collected the terminal alloc dir — that happens
          // under batch churn once the node exceeds gc_max_allocs (default 50). The purge below keeps steady-state
          // dead jobs near zero; if a burst still outruns collection, raise client.gc_max_allocs on the Nomad client.
          logs.status === 404
            ? "alloc log fetch failed (alloc dir already GC'd — raise the Nomad client's gc_max_allocs for eval churn)"
            : "alloc log fetch failed",
        );
      return parseResult(logs.text);
    } catch (err) {
      // If the wait was aborted, reclaim the submitted job so it doesn't keep running (best-effort, never masks err).
      if (options?.signal?.aborted) {
        const delq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
        await this.http.request("DELETE", `/v1/job/${jobId}${delq}`).catch(() => {});
      }
      throw err;
    } finally {
      // Purge dead jobs after capturing results (parity with K8sBackend's deleteJob-in-finally). Without it, every
      // batch case leaves a dead job+alloc behind; past gc_max_allocs the client instantly GCs each newly terminal
      // alloc, and the NEXT case's log fetch loses the race → the whole batch reads as dispatch failures.
      // DEFERRED, not immediate: purging a job whose alloc just went terminal races the client's alloc watcher
      // (nil-deref panic on a dev-mode single-process agent, observed live). Each dispatch enqueues its own job and
      // sweeps only entries older than purgeDelayMs — steady state stays bounded, fresh allocs are left alone.
      if (this.opts.purgeDeadJobs === true) {
        this.purgeQueue.push({ jobId, ns, at: Date.now() });
        await this.sweepPurge();
      }
    }
  }

  // Adopt an already-dispatched case job (boot recovery): the control plane died after submitting
  // everdict-<caseId>-<suffix> — instead of re-dispatching (double compute), find the NEWEST such job, wait for
  // its alloc like a normal dispatch, and harvest the result from its logs. undefined on any miss (no job, logs
  // gone, no sentinel) — the caller re-dispatches as before. Best-effort by design.
  async adopt(caseId: string): Promise<AdoptOutcome> {
    const prefix = `everdict-${caseId}-`;
    // Step 1: list the case's jobs. If this fails, we CANNOT tell whether a job is live → "unknown", never "absent".
    let listText: string;
    try {
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return { status: "unknown" };
      listText = res.text;
    } catch {
      return { status: "unknown" };
    }
    let newest: { ID?: string; Namespace?: string; SubmitTime?: number } | undefined;
    try {
      const jobs = JSON.parse(listText) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
    } catch {
      return { status: "unknown" };
    }
    // Step 2: the listing succeeded and there is no job → definitively nothing to adopt (safe to re-dispatch).
    if (!newest?.ID) return { status: "absent" };
    // Step 3: a job exists — harvest it. Any failure from here is ambiguous (the job is real), so it's "unknown".
    try {
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const allocId = await this.waitForAlloc(newest.ID, ns);
      const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
      );
      if (logs.status >= 300) return { status: "unknown" };
      return { status: "adopted", result: parseResult(logs.text) };
    } catch {
      return { status: "unknown" };
    }
  }

  // One-shot exec inside the case's live alloc (web terminal / live-screen capture). Shells to `nomad alloc
  // exec -task agent <alloc> sh -c <command>` (WS exec is CLI-only), addr/token via env. undefined = no live alloc.
  async exec(
    caseId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
      const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(newest.ID)}/allocations${nsq}`);
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string; ClientStatus?: string }>).find(
        (a) => a.ClientStatus === "running",
      );
      if (!alloc) return undefined; // no RUNNING alloc — nothing to exec into
      const runner = this.opts.execRunner ?? ((bin, args, env) => spawnRunner(bin, args, env));
      const env: Record<string, string> = { NOMAD_ADDR: this.opts.addr };
      if (this.opts.apiToken) env.NOMAD_TOKEN = this.opts.apiToken;
      const args = [
        "alloc",
        "exec",
        "-task",
        "agent",
        ...(ns ? ["-namespace", ns] : []),
        alloc.ID,
        "sh",
        "-c",
        command,
      ];
      const r = await runner("nomad", args, env);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // Open an interactive shell inside the case's live alloc (observability ⑥) — `nomad alloc exec -i -task agent
  // <alloc> /bin/sh`. Returns a stream handle the WS terminal route pipes to. undefined = no running alloc.
  async execStream(caseId: string): Promise<ExecStreamHandle | undefined> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
      const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(newest.ID)}/allocations${nsq}`);
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string; ClientStatus?: string }>).find(
        (a) => a.ClientStatus === "running",
      );
      if (!alloc) return undefined;
      const env: Record<string, string> = { ...process.env, NOMAD_ADDR: this.opts.addr };
      if (this.opts.apiToken) env.NOMAD_TOKEN = this.opts.apiToken;
      const args = ["alloc", "exec", "-i", "-task", "agent", ...(ns ? ["-namespace", ns] : []), alloc.ID, "/bin/sh"];
      return streamHandleFor(spawn("nomad", args, { stdio: ["pipe", "pipe", "pipe"], env }));
    } catch {
      return undefined;
    }
  }

  // Current output of the case's newest job — live-progress tail (no waiting: a job with no alloc yet reads as
  // undefined and the caller polls again). Sentinel payload stripped (it's the machine result, not progress).
  // stream=stderr reads the alloc's stderr file — harnesses often log progress there while stdout carries only
  // the final result block (stripSentinel is a no-op on stderr, harmless).
  async logs(caseId: string, stream: LogStream = "stdout"): Promise<string | undefined> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return undefined;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; SubmitTime?: number }>;
      const newest = jobs
        .filter((j) => j.ID?.startsWith(prefix))
        .sort((a, b) => (b.SubmitTime ?? 0) - (a.SubmitTime ?? 0))[0];
      if (!newest?.ID) return undefined;
      const ns = newest.Namespace && newest.Namespace !== "default" ? newest.Namespace : undefined;
      const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
      const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(newest.ID)}/allocations${nsq}`);
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string }>)[0];
      if (!alloc) return undefined; // still queued — nothing to tail yet
      const nsq2 = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${alloc.ID}?task=agent&type=${stream}&plain=true${nsq2}`,
      );
      if (logs.status >= 300) return undefined;
      return stripSentinel(logs.text);
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // Force-stop every live job of a case (superseded batch reclaim) — deregister WITHOUT purge (the purge saga:
  // purging a job a client still tracks panics its alloc watcher). Best-effort, never throws.
  async kill(caseId: string): Promise<void> {
    try {
      const prefix = `everdict-${caseId}-`;
      const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(prefix)}&namespace=*`);
      if (res.status >= 300) return;
      const jobs = JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; Status?: string }>;
      for (const j of jobs) {
        if (!j.ID?.startsWith(prefix) || j.Status === "dead") continue;
        const nsq = j.Namespace && j.Namespace !== "default" ? `?namespace=${encodeURIComponent(j.Namespace)}` : "";
        await this.http.request("DELETE", `/v1/job/${encodeURIComponent(j.ID)}${nsq}`);
      }
    } catch {
      // best-effort
    }
  }

  // --- Reclaimable (destructive live-cluster control; runtimes:control-gated at the control plane) ---

  // Deregister one job by its exact id (the InspectWorkload.name) — everdict units and external jobs alike (the
  // operator's blunt terminate; a service job stays deregistered, it is not rescheduled). Resolves the job's
  // namespace first so a namespaced job is stopped correctly; when the caller passes the unit's namespace, only
  // that namespace's job matches (two namespaces may reuse one job id). Best-effort/idempotent — a job that is
  // already gone is a silent no-op.
  async stopWorkload(name: string, namespace?: string): Promise<void> {
    try {
      const job = await this.findJob(name, namespace);
      if (!job?.ID) return; // already gone
      const nsq = job.Namespace && job.Namespace !== "default" ? `?namespace=${encodeURIComponent(job.Namespace)}` : "";
      await this.http.request("DELETE", `/v1/job/${encodeURIComponent(job.ID)}${nsq}`);
    } catch {
      // best-effort — the caller re-inspects
    }
  }

  // Exact-id job lookup across namespaces (optionally pinned to one namespace). undefined = not found.
  private async findJob(name: string, namespace?: string): Promise<{ ID?: string; Namespace?: string } | undefined> {
    const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(name)}&namespace=*`);
    if (res.status >= 300) return undefined;
    return (JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string }>).find(
      (j) => j.ID === name && (!namespace || (j.Namespace ?? "default") === namespace),
    );
  }

  // Change a single-task job's resource ask (CPU MHz / memory MiB) by read-modify-resubmit — Nomad has no in-place
  // alloc resize, so the register replaces the alloc (a service job rolls, a batch task restarts). Multi-task jobs
  // are refused (which task would the numbers mean?) — a clear 400, never a silent no-op (see Reclaimable).
  async resizeWorkload(
    name: string,
    resources: { cpu?: number; memoryMb?: number },
    namespace?: string,
  ): Promise<{ detail: string }> {
    if (resources.cpu === undefined && resources.memoryMb === undefined)
      throw new BadRequestError("BAD_REQUEST", { name }, "resize needs cpu and/or memoryMb.");
    let stub: { ID?: string; Namespace?: string } | undefined;
    try {
      stub = await this.findJob(name, namespace);
    } catch (e) {
      throw new UpstreamError("UPSTREAM_ERROR", { name }, `job lookup failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!stub?.ID) throw new NotFoundError("NOT_FOUND", { name }, "workload not found on the cluster.");
    const ns = stub.Namespace && stub.Namespace !== "default" ? stub.Namespace : undefined;
    const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
    const jobRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(stub.ID)}${nsq}`);
    if (jobRes.status >= 300)
      throw new UpstreamError("UPSTREAM_ERROR", { status: jobRes.status }, "job read failed for resize");
    const job = JSON.parse(jobRes.text) as {
      TaskGroups?: Array<{ Tasks?: Array<{ Name?: string; Resources?: { CPU?: number; MemoryMB?: number } }> }>;
    };
    const tasks = (job.TaskGroups ?? []).flatMap((g) => g.Tasks ?? []);
    const task = tasks[0];
    if (tasks.length !== 1 || task === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name, tasks: tasks.length },
        "only single-task jobs can be resized (ambiguous target otherwise).",
      );
    task.Resources = {
      ...(task.Resources ?? {}),
      ...(resources.cpu !== undefined ? { CPU: resources.cpu } : {}),
      ...(resources.memoryMb !== undefined ? { MemoryMB: resources.memoryMb } : {}),
    };
    const submit = await this.http.request("POST", `/v1/job/${encodeURIComponent(stub.ID)}${nsq}`, { Job: job });
    if (submit.status >= 300)
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "job resize submission failed");
    const parts = [
      ...(resources.cpu !== undefined ? [`cpu ${resources.cpu} MHz`] : []),
      ...(resources.memoryMb !== undefined ? [`memory ${resources.memoryMb} MiB`] : []),
    ];
    return { detail: `job ${stub.ID} resized to ${parts.join(", ")} (alloc replaced)` };
  }

  // Stop every running/pending everdict EVAL unit older than the threshold (shared stores are excluded — they are
  // long-lived by design). Deregisters the distinct job ids. Returns how many jobs it stopped.
  async reclaimIdle(olderThanSeconds: number): Promise<{ stopped: number }> {
    try {
      const res = await this.http.request("GET", "/v1/allocations?namespace=*");
      if (res.status >= 300) return { stopped: 0 };
      const now = Date.now();
      const jobs = new Set<string>();
      for (const a of JSON.parse(res.text) as NomadAllocStub[]) {
        const name = a.JobID ?? a.Name ?? "";
        if (!name.startsWith(EVERDICT_PREFIX)) continue;
        if (classifyWorkloadRole(name) === "store") continue; // never reclaim a shared store
        if (a.ClientStatus !== "running" && a.ClientStatus !== "pending") continue;
        const age = nomadAllocAgeSeconds(a.CreateTime, now);
        if (age !== undefined && age >= olderThanSeconds) jobs.add(name);
      }
      for (const name of jobs) await this.stopWorkload(name);
      return { stopped: jobs.size };
    } catch {
      return { stopped: 0 };
    }
  }

  // GC dead everdict jobs (purge=true) — reclaims the dead-job records the client tracks. Only DEAD jobs are purged
  // (their allocs are terminal, so the alloc-watcher panic that gates the dispatch-path purge doesn't apply here).
  async purgeTerminal(): Promise<{ purged: number }> {
    try {
      const res = await this.http.request("GET", "/v1/jobs?prefix=everdict-&namespace=*");
      if (res.status >= 300) return { purged: 0 };
      const dead = (JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string; Status?: string }>).filter(
        (j) => j.ID?.startsWith(EVERDICT_PREFIX) && j.Status === "dead",
      );
      let purged = 0;
      for (const j of dead) {
        if (!j.ID) continue;
        const nsq =
          j.Namespace && j.Namespace !== "default"
            ? `?purge=true&namespace=${encodeURIComponent(j.Namespace)}`
            : "?purge=true";
        const r = await this.http.request("DELETE", `/v1/job/${encodeURIComponent(j.ID)}${nsq}`);
        if (r.status < 300) purged++;
      }
      return { purged };
    } catch {
      return { purged: 0 };
    }
  }

  // Cordon (ineligible) / uncordon (eligible) a node by name — takes it out of / back into scheduling for maintenance
  // WITHOUT evicting its running allocs (reversible). Resolves the node id from its name first.
  async setNodeSchedulable(node: string, schedulable: boolean): Promise<void> {
    try {
      const res = await this.http.request("GET", "/v1/nodes");
      if (res.status >= 300) return;
      const match = (JSON.parse(res.text) as Array<{ ID?: string; Name?: string }>).find((n) => n.Name === node);
      if (!match?.ID) return;
      await this.http.request("POST", `/v1/node/${encodeURIComponent(match.ID)}/eligibility`, {
        NodeID: match.ID,
        Eligibility: schedulable ? "eligible" : "ineligible",
      });
    } catch {
      // best-effort
    }
  }

  // The alloc's task events, flattened across tasks (one fetch feeds OOM detection AND the failure summary).
  private async allocTaskEvents(allocId: string): Promise<NomadTaskEvent[]> {
    try {
      const res = await this.http.request("GET", `/v1/allocation/${allocId}`);
      if (res.status >= 300) return [];
      const detail = JSON.parse(res.text) as {
        TaskStates?: Record<string, { Events?: NomadTaskEvent[] }>;
      };
      return Object.values(detail.TaskStates ?? {}).flatMap((st) => st.Events ?? []);
    } catch {
      /* detection is best-effort — fall through to the generic alloc-failed error */
      return [];
    }
  }

  private readonly purgeQueue: Array<{ jobId: string; ns: string | undefined; at: number }> = [];
  private async sweepPurge(): Promise<void> {
    const cutoff = Date.now() - (this.opts.purgeDelayMs ?? 60_000);
    while (this.purgeQueue.length > 0) {
      const head = this.purgeQueue[0];
      if (head === undefined || head.at > cutoff) break;
      this.purgeQueue.shift();
      const nsq = head.ns ? `?purge=true&namespace=${encodeURIComponent(head.ns)}` : "?purge=true";
      await this.http.request("DELETE", `/v1/job/${head.jobId}${nsq}`).catch(() => {});
    }
  }

  private async waitForAlloc(jobId: string, namespace?: string, signal?: AbortSignal): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    const blockedBudgetMs = this.opts.failOnBlockedEvalMs ?? 120_000;
    const nsq = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
    let blockedSinceMs: number | undefined;
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) throw new InternalError("CANCELLED", { jobId }, "dispatch aborted while waiting for alloc.");
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations${nsq}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as Array<{ ID: string; ClientStatus: string }>;
        const alloc = allocs[0];
        // No alloc yet: an UNPLACEABLE job (resources beyond every node) never produces one — the scheduler
        // parks a BLOCKED evaluation instead, and this loop would grind the full 30-minute budget on a job
        // that can never start. Surface the blocked verdict (with the exhausted dimensions) after a bounded
        // patience window; short blocked spells (capacity about to free) are tolerated, and the
        // failure is retryable-infra so a sharded batch spills the case to another runtime.
        if (!alloc) {
          const blocked = await this.blockedPlacement(jobId, nsq);
          if (blocked) {
            blockedSinceMs ??= Date.now();
            if (Date.now() - blockedSinceMs >= blockedBudgetMs) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { jobId, reason: "placement_blocked" },
                `placement blocked — ${blocked} (the job's resources exceed what any eligible node offers; ` +
                  "lower the harness resources or add capacity)",
              );
            }
          } else {
            blockedSinceMs = undefined; // eval progressed — reset the patience window
          }
        }
        if (alloc) {
          if (alloc.ClientStatus === "complete") return alloc.ID;
          if (alloc.ClientStatus === "failed" || alloc.ClientStatus === "lost") {
            const events = await this.allocTaskEvents(alloc.ID);
            // OOM-killed reads as fatal infra (raise the harness resources), never as an agent failure.
            if (eventsIndicateOom(events)) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { alloc: alloc.ID, signal: OOM_KILLED },
                "task OOM-killed — raise the harness's resources.memoryMb (infra, not an agent failure)",
              );
            }
            // Carry the task-event cause (image pull denial, driver failure, …) so the CaseResult explains itself.
            const cause = summarizeAllocFailure(events);
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { alloc: alloc.ID, status: alloc.ClientStatus },
              `alloc failed${cause ? ` — ${cause}` : ""}`,
            );
          }
        }
      }
      await abortableDelay(interval, signal);
    }
    throw new UpstreamError("UPSTREAM_ERROR", { jobId }, "timed out waiting for alloc completion");
  }

  // Whether the job's latest evaluation is BLOCKED with failed task-group allocations (nomad's "cannot place
  // this anywhere right now" verdict). Returns a human-readable summary of the exhausted dimensions
  // ("cpu exhausted on 1 node(s)") or undefined when placement is not blocked. Best-effort — an evals API
  // error reads as "not blocked" (the alloc poll keeps its own timeout as the backstop).
  private async blockedPlacement(jobId: string, nsq: string): Promise<string | undefined> {
    try {
      const res = await this.http.request("GET", `/v1/job/${jobId}/evaluations${nsq}`);
      if (res.status >= 300) return undefined;
      const evals = JSON.parse(res.text) as Array<{
        Status?: string;
        FailedTGAllocs?: Record<
          string,
          {
            NodesEvaluated?: number;
            DimensionExhausted?: Record<string, number>;
            ClassExhausted?: Record<string, number>;
          }
        > | null;
      }>;
      const failed = evals.find((e) => e.FailedTGAllocs && Object.keys(e.FailedTGAllocs).length > 0);
      const blocked = evals.some((e) => e.Status === "blocked") || failed !== undefined;
      if (!blocked || !failed?.FailedTGAllocs) return blocked ? "no eligible node (blocked evaluation)" : undefined;
      const parts: string[] = [];
      for (const [group, metrics] of Object.entries(failed.FailedTGAllocs)) {
        const dims = Object.entries(metrics.DimensionExhausted ?? {})
          .map(([dim, n]) => `${dim} exhausted on ${n} node(s)`)
          .join(", ");
        parts.push(
          `${group}: ${dims || "no eligible node"}${metrics.NodesEvaluated !== undefined ? ` (${metrics.NodesEvaluated} evaluated)` : ""}`,
        );
      }
      return parts.join("; ");
    } catch {
      return undefined;
    }
  }
}
