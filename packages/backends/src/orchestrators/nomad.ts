import { spawn } from "node:child_process";
import {
  type Score,
  type VerifierJob,
  type WorkPresence,
  caseJobPayload,
  describeNomadPlacementFailure,
  extractLiveEvents,
  parseResult,
  stripSentinel,
  verifierJobPayload,
} from "@everdict/contracts";
import type { NomadPlacementMetrics } from "@everdict/contracts";
import {
  AppError,
  BadRequestError,
  type CaseJob,
  type CaseResult,
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  InternalError,
  type KillOutcome,
  NotFoundError,
  OOM_KILLED,
  type ReadResult,
  type RuntimeWorkRef,
  type TraceEvent,
  UpstreamError,
  judgeAuthEnv,
  judgeEnv,
  worstKillOutcome,
} from "@everdict/contracts";
import type {
  CasePlacement,
  InspectNode,
  InspectRuntimeResult,
  InspectStore,
  InspectWorkload,
  PlacementEvent,
} from "@everdict/contracts/wire";
import { assertHardenedIsolation, laneImageProvenance, pickRegistryAuth, registryAuthsOf } from "@everdict/domain";
import type { TrustZonePolicy } from "@everdict/domain";
import {
  type AdoptOutcome,
  type Backend,
  type BackendCapacity,
  type CaseRuntimeSample,
  type DispatchOptions,
  type ExecStreamHandle,
  type Inspectable,
  type LogStream,
  type ManagedWorkControl,
  type ProbeResult,
  type Probeable,
  type Reclaimable,
  type WorkAddressable,
  dispatchAborted,
  requireReservation,
} from "../backend.js";
import type { SecretProvider } from "../policy/secrets.js";
import { abortableDelay } from "./abortable-delay.js";
import {
  EVERDICT_PREFIX,
  FAILURE_EVENT_CAP,
  FAILURE_LOG_TAIL_CAP,
  NODE_DETAIL_CAP,
  WORKLOAD_CAP,
  classifyWorkloadRole,
} from "./inspect-common.js";
import {
  NomadSessionHandle,
  SESSION_BASE,
  SESSION_JOB_PREFIX,
  SESSION_POLL_MS,
  SESSION_READY_TIMEOUT_MS,
  SESSION_TASK,
  parseSessionComputeId,
} from "./nomad-session.js";

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
  image: string; // job-runner image (in-house registry)
  apiToken?: string; // Nomad ACL token (X-Nomad-Token) — control-plane↔Nomad API auth. Unrelated to the alloc env.
  http?: NomadHttp;
  secretEnv?: Record<string, string>; // auth to inject into the alloc (e.g. CLAUDE_CODE_OAUTH_TOKEN). The default when secrets is absent.
  secrets?: SecretProvider; // per-tenant secret scoping — inject only that tenant's keys per job (no leakage).
  datacenters?: string[];
  // Runtime-side placement binding (from RuntimeSpec, operator-owned) — reserve N GPUs per job + pin jobs to
  // matching nodes. The harness stays infra-agnostic; the cluster's own scheduler places onto the matching node.
  gpu?: number;
  constraints?: Array<{ attribute: string; operator?: string; value: string }>;
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
  Resources: { CPU: number; MemoryMB: number; Devices?: Array<{ Name: string; Count: number }> };
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
      Constraints?: Array<{ LTarget: string; Operand: string; RTarget: string }>;
      RestartPolicy: { Attempts: number; Mode: string };
      Tasks: NomadTask[];
    }>;
  };
}

// The job's id on the cluster. The RUN is in it (arch-review 52, Wave 2) so two concurrent executions of one
// case — a re-evaluation beside a scheduled batch, a shadow beside its baseline — are two distinct objects
// rather than two names that a `prefix=everdict-<caseId>-` search cannot tell apart. It stays AFTER the case
// so the legacy case-prefix lookups keep matching: `everdict-<caseId>-` is still this id's prefix.
//
// Not a uniqueness device — the dispatch suffix already is one. It makes the id SELF-DESCRIBING, which is
// what an operator reading `nomad job status` and a future run-scoped sweep both need.
export function nomadJobId(job: CaseJob, suffix?: string): string {
  const run = job.runId === undefined ? "" : `-${nomadIdPart(job.runId)}`;
  return `everdict-${job.evalCase.id}${run}${suffix ? `-${suffix}` : ""}`;
}

// Keep an id fragment to what a Nomad job id may hold without escaping. The case id is passed through raw
// (long-standing behavior, and Nomad accepts it); only the fragments THIS layer adds are normalized.
function nomadIdPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

// One task event as the alloc API reports it (Type = short phase, DisplayMessage = the human cause,
// Time = nanoseconds since epoch).
export interface NomadTaskEvent {
  Type?: string;
  DisplayMessage?: string;
  Details?: Record<string, string>;
  Time?: number;
}

// How many orchestrator events a CasePlacement carries (the newest ones — the tail is where the live cause is).
const PLACEMENT_EVENT_CAP = 20;

// Nomad task events → the failure-evidence lines (CaseFailure.placement.events): "Type: DisplayMessage",
// newest FAILURE_EVENT_CAP, empty ones dropped.
export function placementEventLines(events: NomadTaskEvent[]): string[] {
  return events
    .map((e) => `${e.Type ? `${e.Type}: ` : ""}${e.DisplayMessage ?? ""}`.trim())
    .filter((line) => line !== "")
    .slice(-FAILURE_EVENT_CAP);
}

// Alloc task events → infra-plane trace events with REAL timestamps (event Time − dispatch t0) — the cluster's
// own account of the case, appended to the result's trace so it seals with the trajectory.
export function nomadInfraEvents(
  events: NomadTaskEvent[],
  unit: string,
  node: string | undefined,
  t0: number,
): TraceEvent[] {
  return events
    .filter((e) => (e.DisplayMessage ?? "").trim() !== "" || (e.Type ?? "").trim() !== "")
    .slice(-PLACEMENT_EVENT_CAP)
    .map((e) => {
      const epochMs = typeof e.Time === "number" && e.Time > 0 ? Math.floor(e.Time / 1e6) : Date.now();
      return {
        t: Math.max(0, epochMs - t0),
        kind: "infra" as const,
        scope: "placement" as const,
        ...(e.Type ? { event: e.Type } : {}),
        message: (e.DisplayMessage ?? e.Type ?? "").trim(),
        unit,
        ...(node ? { node } : {}),
        at: new Date(epochMs).toISOString(),
      };
    });
}

// Nomad task events → the wire PlacementEvent feed (newest PLACEMENT_EVENT_CAP, empty ones dropped, ns → ISO).
export function nomadEventsToPlacement(events: NomadTaskEvent[]): PlacementEvent[] {
  return events
    .filter((e) => (e.DisplayMessage ?? "").trim() !== "" || (e.Type ?? "").trim() !== "")
    .slice(-PLACEMENT_EVENT_CAP)
    .map((e) => ({
      ...(e.Type ? { type: e.Type } : {}),
      message: (e.DisplayMessage ?? e.Type ?? "").trim(),
      ...(typeof e.Time === "number" && e.Time > 0 ? { at: new Date(Math.floor(e.Time / 1e6)).toISOString() } : {}),
    }));
}

// The CURRENT alloc of a dispatch job — desired-run allocs first, newest CreateIndex wins. A task restart or
// reschedule under the SAME job id leaves the previous dead alloc in the list until GC, and the old `allocs[0]`
// could read the PAST alloc's terminal state (and later its logs) as this case's result. Pure/generic — the
// list-stub shapes vary per call site ("DesiredStatus" is "run" for the alloc the scheduler currently wants,
// "stop"/"evict" for superseded ones).
export function currentAlloc<T extends { CreateIndex?: number; DesiredStatus?: string }>(allocs: T[]): T | undefined {
  const sorted = [...allocs].sort((a, b) => (b.CreateIndex ?? 0) - (a.CreateIndex ?? 0));
  return sorted.find((a) => a.DesiredStatus === "run") ?? sorted[0];
}

export function eventsIndicateOom(events: NomadTaskEvent[]): boolean {
  // Details.oom_killed carries "true"/"false" — the docker driver may report the kill ONLY there
  // (Type "Terminated", message "Exit Code: 137"), so a text match on "oom" alone misses it. Exit code 137
  // (SIGKILL — the OOM killer's signature) is ALSO detected on its own: real drivers report a bare 137 with
  // neither the oom_killed detail nor an "oom" substring, and that used to fall through to the mushy generic.
  return events.some(
    (e) =>
      e.Details?.oom_killed === "true" ||
      e.Details?.exit_code === "137" ||
      /\bexit code:?\s*137\b/i.test(e.DisplayMessage ?? "") ||
      `${e.Type ?? ""} ${e.DisplayMessage ?? ""}`.toLowerCase().includes("oom"),
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
  | "gpuTotal"
  | "gpuProduct"
> {
  try {
    const d = JSON.parse(text) as {
      NodeResources?: {
        Cpu?: { CpuShares?: number };
        Memory?: { MemoryMB?: number };
        Devices?: Array<{ Type?: string; Vendor?: string; Name?: string; Instances?: unknown[] }>;
      };
      Attributes?: Record<string, string | undefined>;
    };
    const cpu = d.NodeResources?.Cpu?.CpuShares;
    const mem = d.NodeResources?.Memory?.MemoryMB;
    // GPU fingerprint — Nomad's device plugin reports gpu devices under NodeResources.Devices (Type "gpu"). The node's
    // GPU count = the sum of their instances; the product/model is the first gpu device's vendor + name.
    const gpuDevices = (d.NodeResources?.Devices ?? []).filter((dev) => dev.Type === "gpu");
    const gpuTotal = gpuDevices.reduce((sum, dev) => sum + (dev.Instances?.length ?? 0), 0) || undefined;
    const gpuProduct =
      gpuDevices.length > 0
        ? [gpuDevices[0]?.Vendor, gpuDevices[0]?.Name].filter(Boolean).join(" ") || undefined
        : undefined;
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
      ...(gpuTotal !== undefined ? { gpuTotal } : {}),
      ...(gpuProduct ? { gpuProduct } : {}),
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

// CaseJob → Nomad batch job spec. The job payload is carried in the EVERDICT_CASE_JOB(base64) env.
export function buildNomadJob(
  job: CaseJob,
  opts: NomadBackendOptions,
  jobId?: string,
  // THE JUDGING HALF (arch-review 56, Wave K) — see the K8s twin. The case payload is NOT set alongside it,
  // which is what keeps "the agent's container never held the plan" a property of the spec.
  verifierPayload?: string,
): NomadJobSpec {
  const env: Record<string, string> = {
    // THE ONE SERIALIZER (arch-review 56, Wave B) — it refuses a case whose grading depends on material
    // this lane would hand to the agent along with the job.
    ...(verifierPayload !== undefined
      ? { EVERDICT_VERIFIER_JOB: verifierPayload }
      : { EVERDICT_CASE_JOB: caseJobPayload(job) }),
    ...judgeEnv(job.judge), // per-run judge model config. The inline judge grader judges with this model.
    ...opts.secretEnv,
    // Judge provider key resolved per-job at dispatch (workspace tier → submitter personal fallback) — AFTER
    // secretEnv so the job-level credential wins over the backend's baked workspace tier.
    ...judgeAuthEnv(job.judge, job.judgeAuth),
  };
  // Prefer the per-case image (e.g. the official SWE-bench prebuilt = deps+repo bundled), otherwise the default job-runner image.
  const image = job.evalCase.image ?? opts.image;
  // docker auth (transient job credentials) — the credential covering THIS task's image, if any. A Nomad task runs one
  // image, so the many-credential job resolves to at most one auth block here.
  const registryAuth = pickRegistryAuth(registryAuthsOf(job), image);
  const auth = registryAuth
    ? [{ username: registryAuth.username ?? "everdict", password: registryAuth.password }]
    : undefined;
  // Runtime-side node constraints (operator-owned) → Nomad's {LTarget, Operand, RTarget} form.
  const constraints = opts.constraints?.map((c) => ({
    LTarget: c.attribute,
    Operand: c.operator ?? "=",
    RTarget: c.value,
  }));
  // Harness-declared GPUs win over the runtime binding's blanket default (same rule as cpu/mem).
  const gpuCount = (job.harnessSpec?.kind === "command" ? job.harnessSpec.resources?.gpu : undefined) ?? opts.gpu;
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
          ...(constraints && constraints.length > 0 ? { Constraints: constraints } : {}),
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
                ...(gpuCount !== undefined ? { Devices: [{ Name: "nvidia/gpu", Count: gpuCount }] } : {}),
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

// Launch the job-runner as a Nomad batch alloc, poll for completion, then
// parse the CaseResult from the sentinel in the stdout log.
export class NomadBackend
  implements
    Backend,
    // The session mode (agent worlds): the same cluster, held open instead of run to completion. Implemented
    // HERE rather than in a parallel class so Nomad's placement knowledge — submission, trust zone, namespace,
    // alloc exec — has one owner, and so a session shows up in this backend's own `capacity()` probe (its jobs
    // carry the same `everdict-` prefix the probe counts) instead of being invisible to the Scheduler.
    Driver,
    WorkAddressable,
    ManagedWorkControl,
    Probeable,
    Inspectable,
    Reclaimable
{
  // The Driver contract's identity (the session mode) — "which compute is this". Backend placement is named
  // by its registry key, so the two identities never had to agree.
  readonly id = "nomad";
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
  private async effectiveOpts(job: CaseJob): Promise<NomadBackendOptions> {
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

  // ── NAME THE WORK WITHOUT CREATING IT (arch-review 53, Wave A) ─────────────────────────────────────
  //
  // Pure: the Nomad job id is ours to choose and the namespace comes from the trust zone, so the exact
  // coordinate is decidable with no call to the cluster. See `DispatchIntent` (@everdict/contracts) for why
  // the decision has to precede the effect rather than report it.
  async reserve(job: CaseJob): Promise<RuntimeWorkRef> {
    const opts = await this.effectiveOpts(job);
    const jobId = nomadJobId(job, dispatchSuffix());
    return {
      tenant: job.tenant ?? "default",
      runId: job.runId ?? "",
      externalJobId: jobId,
      ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
      ...(job.attemptId !== undefined ? { attemptId: job.attemptId } : {}),
    };
  }

  // ── THE JUDGING HALF, AS ITS OWN UNIT (arch-review 56, Wave K) ─────────────────────────────────
  //
  // The same image, the same result contract and the same register/wait/log/parse path as a case — with the
  // verifier payload instead of the case one, and no reservation or attempt row: a verifier unit is not one of
  // the case's execution attempts, it is how the case's verdict is reached.
  //
  // It goes through `dispatch` rather than a second copy of that path, because a second copy is how the two
  // would drift on the next change to alloc-log handling.
  async dispatchVerifier(job: VerifierJob): Promise<Score[]> {
    const spec = {
      runId: undefined,
      tenant: job.tenant,
      evalCase: { id: `${job.caseId}-verify`, ...(job.image !== undefined ? { image: job.image } : {}) },
      harness: { id: "verifier", version: "1" },
    } as unknown as CaseJob;
    const result = await this.dispatch(spec, undefined, verifierJobPayload(job));
    return result.scores;
  }

  async dispatch(job: CaseJob, options?: DispatchOptions, verifierPayload?: string): Promise<CaseResult> {
    if (options?.signal?.aborted) throw dispatchAborted(job); // cancelled before we even submitted
    const opts = await this.effectiveOpts(job);
    const ns = opts.namespace;
    const jobId = nomadJobId(job, dispatchSuffix()); // unique per dispatch (concurrent same-case batches + no stale-alloc reads)
    // THE INTENT IS DURABLE BEFORE THE JOB EXISTS (arch-review 53, Wave A) — AND WE HOLD THE PROOF
    // (arch-review 54, Phase 1). Awaited, and a rejection aborts the dispatch before the submit: an ambiguous
    // submit (Nomad accepted it, the response never arrived) is precisely the case where the handle matters
    // most, and the old post-submit hook guaranteed there was none. A hook that RESOLVED having written
    // nothing was the same hole one layer in, so the store's answer is required rather than assumed.
    if (job.runId !== undefined)
      await requireReservation(
        job,
        {
          tenant: job.tenant ?? "default",
          runId: job.runId,
          externalJobId: jobId,
          ...(ns !== undefined ? { namespace: ns } : {}),
          ...(job.attemptId !== undefined ? { attemptId: job.attemptId } : {}),
        },
        options?.onReserved,
      );
    // …and ONLY NOW is this run "started" (arch-review 54, Phase 1). The flip used to fire above, before the
    // reservation and before the submit, so a reservation failure left a record marked `running` with no
    // cluster object anywhere and nothing to reconcile it against. `running` means the orchestrator was asked.
    options?.onStarted?.();
    // The infra-plane record of THIS dispatch (submission, blocked verdicts, placement) — appended to the
    // result's trace so the sealed trajectory keeps the orchestrator's account after the job is GC'd.
    const t0 = Date.now();
    const infra: TraceEvent[] = [];
    const mark = (event: string, message: string, extra?: { unit?: string; node?: string }): void => {
      const now = Date.now();
      infra.push({
        t: Math.max(0, now - t0),
        kind: "infra",
        scope: "placement",
        event,
        message,
        ...(extra?.unit ? { unit: extra.unit } : {}),
        ...(extra?.node ? { node: extra.node } : {}),
        at: new Date(now).toISOString(),
      });
    };
    const submit = await this.http.request("POST", "/v1/jobs", buildNomadJob(job, opts, jobId, verifierPayload));
    if (submit.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "Nomad job submission failed");
    }
    mark("submitted", `nomad job ${jobId}${ns ? ` (namespace ${ns})` : ""}`);
    try {
      const allocId = await this.waitForAlloc(jobId, ns, options?.signal, options?.onWaiting, mark);
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
      const result = await this.parseResultOrExplain(logs.text, allocId, ns);
      // The cluster's own task-event account (with REAL event timestamps) closes the infra record — best-effort:
      // a detail miss just leaves the collector's own marks.
      const detail = await this.allocDetail(allocId);
      result.trace = [
        ...result.trace,
        ...[...infra, ...nomadInfraEvents(detail.events, allocId, detail.stub?.NodeName, t0)].sort((a, b) => a.t - b.t),
      ];
      return result;
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

  // Decode the job-runner's stdout sentinel; when it is ABSENT, explain WHY from the alloc's task events instead of
  // the mushy generic. A bare crash (OOM SIGKILL) bypasses the in-process result guard entirely — the sentinel is
  // simply missing — so an OOM here becomes the fatal-infra OOM_KILLED verdict (never an "agent failure"), and any
  // other death carries its task-event cause. This is the batch-path twin of the topology drive diagnosis (A6).
  private async parseResultOrExplain(logsText: string, allocId: string, namespace?: string): Promise<CaseResult> {
    try {
      return parseResult(logsText);
    } catch (err) {
      const events = await this.allocTaskEvents(allocId).catch(() => [] as NomadTaskEvent[]);
      // Failure evidence at the last reachable moment (the dead job is purged/GC'd after settlement): the alloc's
      // event lines + its log tail (stderr preferred; the in-hand sentinel-less stdout is the fallback).
      const stdoutTail = stripSentinel(logsText).trim().slice(-FAILURE_LOG_TAIL_CAP);
      const tail = await this.allocLogTailEvidence(allocId, namespace);
      const evidence = {
        placement: { unit: allocId, events: placementEventLines(events) },
        ...(tail.logTail !== undefined ? tail : stdoutTail !== "" ? { logTail: stdoutTail } : {}),
      };
      if (eventsIndicateOom(events)) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { alloc: allocId, signal: OOM_KILLED, ...evidence },
          "task OOM-killed (exit 137) — raise the harness's resources.memoryMb (infra, not an agent failure)",
        );
      }
      const cause = summarizeAllocFailure(events);
      if (err instanceof AppError && cause) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { ...(err.extra ?? {}), alloc: allocId, ...evidence },
          `${err.message} — ${cause}`,
        );
      }
      throw err;
    }
  }

  // `nomad alloc exec` into ONE named alloc — the shared tail of exec() and execInWork(), so a command can
  // never land in a different container than the one its caller addressed.
  private async execInAlloc(
    allocId: string,
    ns: string | undefined,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const runner = this.opts.execRunner ?? ((bin, args, env) => spawnRunner(bin, args, env));
    const env: Record<string, string> = { NOMAD_ADDR: this.opts.addr };
    if (this.opts.apiToken) env.NOMAD_TOKEN = this.opts.apiToken;
    const args = ["alloc", "exec", "-task", "agent", ...(ns ? ["-namespace", ns] : []), allocId, "sh", "-c", command];
    const r = await runner("nomad", args, env);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  }

  // Open an interactive shell inside the case's live alloc (observability ⑥) — `nomad alloc exec -i -task agent
  // <alloc> /bin/sh`. Returns a stream handle the WS terminal route pipes to. undefined = no running alloc.
  // Interactive shell into exactly this work's live alloc (arch-review 53, Wave B/legacy removal). The
  // case-id twin is gone: it resolved "the newest job of this case", so a terminal opened for one run could
  // land in another run's container — a WRITE into a world nobody asked about, which is the worst form the
  // case-id defect took.
  async execStreamInWork(work: RuntimeWorkRef): Promise<ExecStreamHandle | undefined> {
    try {
      const nsq = work.namespace ? `?namespace=${encodeURIComponent(work.namespace)}` : "";
      const allocsRes = await this.http.request(
        "GET",
        `/v1/job/${encodeURIComponent(work.externalJobId)}/allocations${nsq}`,
      );
      if (allocsRes.status >= 300) return undefined;
      const alloc = (JSON.parse(allocsRes.text) as Array<{ ID: string; ClientStatus?: string }>).find(
        (a) => a.ClientStatus === "running",
      );
      if (!alloc) return undefined;
      const env: Record<string, string> = { ...process.env, NOMAD_ADDR: this.opts.addr };
      if (this.opts.apiToken) env.NOMAD_TOKEN = this.opts.apiToken;
      const args = [
        "alloc",
        "exec",
        "-i",
        "-task",
        "agent",
        ...(work.namespace ? ["-namespace", work.namespace] : []),
        alloc.ID,
        "/bin/sh",
      ];
      return streamHandleFor(spawn("nomad", args, { stdio: ["pipe", "pipe", "pipe"], env }));
    } catch {
      return undefined;
    }
  }

  // The case's newest job's current raw output — the shared fetch behind logs() (human view, sentinel-stripped)
  // and caseEvents() (live-event lines, decoded). No waiting: a job with no alloc yet reads as undefined and the
  // caller polls again.
  // ── THE EXACT-WORK CONTROL SURFACE (ManagedWorkControl — arch-review 53, Wave B) ──────────────────
  //
  // The twins of the case-id reads above, resolving the object by the handle's own job id and namespace
  // instead of by "the newest job whose id starts with everdict-<caseId>- in any namespace". They share the
  // projections with their legacy twins, so the pair can differ only in WHICH job — which was the defect.
  async adoptWork(work: RuntimeWorkRef): Promise<AdoptOutcome> {
    const ns = work.namespace;
    try {
      // Does exactly this job exist? A read that FAILED is `unknown` — re-dispatching on an unestablished
      // liveness double-spends — while a successful read that finds nothing is `absent` and safe.
      const found = await this.findJob(work.externalJobId, ns);
      // Exhaustive, and the `unknown` arm is the one this rung exists for: a cluster that could not answer
      // has told us nothing about whether the job is running, and re-dispatching on that double-spends.
      if (found.kind === "unknown") return { status: "unknown" };
      if (found.kind === "absent") return { status: "absent" };
      const allocId = await this.waitForAlloc(work.externalJobId, ns);
      const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
      const logs = await this.http.request(
        "GET",
        `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
      );
      if (logs.status >= 300) return { status: "unknown" };
      return { status: "adopted", result: await this.parseResultOrExplain(logs.text, allocId, ns) };
    } catch {
      return { status: "unknown" };
    }
  }

  async logsForWork(work: RuntimeWorkRef, stream: LogStream = "stdout"): Promise<string | undefined> {
    try {
      const text = await this.rawJobLogs(work.externalJobId, work.namespace, stream);
      return text === undefined ? undefined : stripSentinel(text);
    } catch {
      return undefined;
    }
  }

  async eventsForWork(work: RuntimeWorkRef): Promise<TraceEvent[] | undefined> {
    try {
      const text = await this.rawJobLogs(work.externalJobId, work.namespace, "stdout");
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
      // A RUNNING alloc, not merely the current one: `currentAlloc` answers "which alloc is this job's now",
      // which includes a finished one, and there is nothing to exec into inside a container that has exited.
      // The same predicate the case-id exec used before it was deleted (arch-review 53, legacy removal).
      const allocId = await this.runningAllocIdOf(work.externalJobId, work.namespace);
      if (!allocId) return undefined;
      return await this.execInAlloc(allocId, work.namespace, command);
    } catch {
      return undefined;
    }
  }

  async inspectWork(work: RuntimeWorkRef): Promise<CasePlacement | undefined> {
    try {
      return await this.placementOfJob(work.externalJobId, work.namespace);
    } catch {
      return undefined;
    }
  }

  async sampleWork(work: RuntimeWorkRef): Promise<CaseRuntimeSample | undefined> {
    try {
      const allocId = await this.currentAllocIdOf(work.externalJobId, work.namespace);
      if (!allocId) return undefined;
      return await this.sampleAlloc(allocId, work.namespace);
    } catch {
      return undefined;
    }
  }

  // The RUNNING alloc of ONE named job — what an exec or a terminal needs, as opposed to "the current alloc"
  // below, which a resource sample legitimately wants even as the container winds down.
  private async runningAllocIdOf(jobId: string, ns: string | undefined): Promise<string | undefined> {
    const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
    const res = await this.http.request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations${nsq}`);
    if (res.status >= 300) return undefined;
    return (JSON.parse(res.text) as Array<{ ID: string; ClientStatus?: string }>).find(
      (a) => a.ClientStatus === "running",
    )?.ID;
  }

  // The current alloc of ONE named job — shared by the sample twin, so "which container" is decided once.
  private async currentAllocIdOf(jobId: string, ns: string | undefined): Promise<string | undefined> {
    const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
    const res = await this.http.request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations${nsq}`);
    if (res.status >= 300) return undefined;
    const alloc = currentAlloc(
      JSON.parse(res.text) as Array<{ ID: string; CreateIndex?: number; DesiredStatus?: string }>,
    );
    return alloc?.ID;
  }

  // The current output of ONE named job. The shared tail of both the exact read and the legacy one, so the
  // two cannot differ in anything but which job they were pointed at.
  private async rawJobLogs(jobId: string, ns: string | undefined, stream: LogStream): Promise<string | undefined> {
    const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
    const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations${nsq}`);
    if (allocsRes.status >= 300) return undefined;
    // The CURRENT alloc's log file — a stale terminal alloc's file used to be tailed as "live progress".
    const alloc = currentAlloc(
      JSON.parse(allocsRes.text) as Array<{ ID: string; CreateIndex?: number; DesiredStatus?: string }>,
    );
    if (!alloc?.ID) return undefined; // still queued — nothing to tail yet
    const nsq2 = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
    const logs = await this.http.request(
      "GET",
      `/v1/client/fs/logs/${alloc.ID}?task=agent&type=${stream}&plain=true${nsq2}`,
    );
    if (logs.status >= 300) return undefined;
    return logs.text;
  }

  // The client stats read for ONE named alloc — shared by sampleCase() and sampleWork().
  private async sampleAlloc(allocId: string, ns: string | undefined): Promise<CaseRuntimeSample | undefined> {
    const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
    const stats = await this.http.request("GET", `/v1/client/allocation/${allocId}/stats${nsq}`);
    if (stats.status >= 300) return undefined;
    const usage = (
      JSON.parse(stats.text) as {
        ResourceUsage?: { MemoryStats?: { RSS?: number; Usage?: number }; CpuStats?: { Percent?: number } };
      }
    ).ResourceUsage;
    const cpuPct = usage?.CpuStats?.Percent;
    const memBytes = usage?.MemoryStats?.RSS ?? usage?.MemoryStats?.Usage;
    if (cpuPct === undefined && memBytes === undefined) return undefined;
    return { ...(cpuPct !== undefined ? { cpuPct } : {}), ...(memBytes !== undefined ? { memBytes } : {}) };
  }

  // The placement projection for ONE named job — shared by inspectCase() and inspectWork(), so a panel can
  // only ever be wrong about WHICH job it was pointed at, never about how a job is described.
  private async placementOfJob(jobId: string, ns: string | undefined): Promise<CasePlacement | undefined> {
    const nsq = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
    const allocsRes = await this.http.request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations${nsq}`);
    if (allocsRes.status >= 300) return undefined;
    const alloc = currentAlloc(
      JSON.parse(allocsRes.text) as Array<NomadAllocStub & { CreateIndex?: number; DesiredStatus?: string }>,
    );
    const base = { job: jobId, ...(ns ? { namespace: ns } : {}) };
    if (!alloc?.ID) {
      // No alloc: either the scheduler simply hasn't placed it yet (queued) or it CANNOT place it (blocked) —
      // the blocked-evaluation read tells them apart, with the exhausted dimensions as the reason.
      const blocked = await this.blockedPlacement(jobId, nsq);
      return {
        ...base,
        phase: blocked ? "blocked" : "queued",
        ...(blocked ? { blockedReason: blocked } : {}),
        events: [],
      };
    }
    // One detail fetch feeds BOTH the event feed and the resource ask: the per-job allocations LIST omits
    // AllocatedResources even with ?resources=true (live-verified on Nomad 2.0.3 — only the global
    // /v1/allocations honors that flag), while the alloc DETAIL always carries it.
    const detail = await this.allocDetail(alloc.ID);
    const events = detail.events;
    const status = alloc.ClientStatus ?? "pending";
    const phase =
      status === "running"
        ? ("running" as const)
        : status === "complete" || status === "failed" || status === "lost"
          ? ("dead" as const)
          : ("starting" as const);
    const restarts = events.filter((e) => e.Type === "Restarting").length;
    const age = nomadAllocAgeSeconds(alloc.CreateTime, Date.now());
    return {
      ...base,
      phase,
      unit: alloc.ID,
      ...(alloc.NodeName ? { node: alloc.NodeName } : {}),
      ...(eventsIndicateOom(events) ? { oom: true } : {}),
      ...(restarts > 0 ? { restarts } : {}),
      ...nomadAllocResources(detail.stub ?? alloc),
      ...(age !== undefined ? { ageSeconds: age } : {}),
      events: nomadEventsToPlacement(events),
    };
  }

  // Stop the work a HANDLE names, and nothing else (WorkAddressable — arch-review 52, Wave 2).
  //
  // ONE request: deregister the exact job id, in the namespace the handle carries. No listing at all — the
  // listing was the defect. `kill(caseId)` below asks `prefix=everdict-<caseId>-&namespace=*` and deregisters
  // every live match, so a tenant's cancellation reached ANOTHER TENANT'S job of the same case in another
  // namespace; a stop that crosses a trust zone is the same violation as a read that does, and it was silent
  // because kill returns void. A handle knows which namespace its work is in, so nothing has to be searched
  // for. Deregister WITHOUT purge (the purge saga: purging a job a client still tracks panics its alloc
  // watcher). Idempotent and never throws — but it ANSWERS (arch-review 52, Wave 3): a 404 is `absent` (the
  // job already ended, or this shard never placed it), a 2xx is `stopped`, and anything else is `failed`
  // with the cluster's own words. The old `catch {}` reported all three as success.
  async killWork(work: RuntimeWorkRef): Promise<KillOutcome> {
    try {
      const nsq =
        work.namespace && work.namespace !== "default" ? `?namespace=${encodeURIComponent(work.namespace)}` : "";
      const res = await this.http.request("DELETE", `/v1/job/${encodeURIComponent(work.externalJobId)}${nsq}`);
      if (res.status === 404) return { status: "absent" };
      if (res.status >= 300)
        return { status: "failed", reason: `nomad deregister ${work.externalJobId}: HTTP ${res.status}` };
      return { status: "stopped" };
    } catch (err) {
      return {
        status: "failed",
        reason: `nomad deregister ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── DOES THIS JOB STILL EXIST? (arch-review 56, Wave G) ─────────────────────────────────────────
  //
  // `killWork` above answers `stopped` once Nomad has MARKED the job for stopping — its allocations are still
  // running through their kill timeout at that moment. A cancellation that converged there certified freed
  // compute that was still burning. This is the read-back, and it is an EXISTENCE question rather than the
  // placement projection `inspectWork` returns: that one reports a phase, and a phase cannot tell "not
  // started" from "not there".
  //
  // A dead job is one Nomad no longer has (404) or one it reports as `dead` with nothing still running — the
  // second matters because a deregistered job lingers in the API until garbage collection.
  async probeWork(work: RuntimeWorkRef): Promise<WorkPresence> {
    try {
      const nsq =
        work.namespace && work.namespace !== "default" ? `?namespace=${encodeURIComponent(work.namespace)}` : "";
      const res = await this.http.request("GET", `/v1/job/${encodeURIComponent(work.externalJobId)}${nsq}`);
      if (res.status === 404) return { kind: "absent" };
      if (res.status >= 300)
        return { kind: "unknown", reason: `nomad job read ${work.externalJobId}: HTTP ${res.status}` };
      let job: { Status?: string } | undefined;
      try {
        job = JSON.parse(res.text) as { Status?: string };
      } catch {
        // A body this adapter cannot read is not a job it can call gone.
        return { kind: "unknown", reason: `nomad job read ${work.externalJobId}: unparseable body` };
      }
      // `dead` is Nomad's terminal job status; anything else means allocations may still be running.
      return job?.Status === "dead" ? { kind: "absent" } : { kind: "live" };
    } catch (err) {
      // An unreachable cluster is not an absence (L2) — the teardown stays owed.
      return {
        kind: "unknown",
        reason: `nomad job read ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
      };
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
      if (job.kind !== "read" || !job.value.ID) return; // absent (already gone) or unreadable — the caller re-inspects
      const nsq =
        job.value.Namespace && job.value.Namespace !== "default"
          ? `?namespace=${encodeURIComponent(job.value.Namespace)}`
          : "";
      await this.http.request("DELETE", `/v1/job/${encodeURIComponent(job.value.ID)}${nsq}`);
    } catch {
      // best-effort — the caller re-inspects
    }
  }

  // Exact-id job lookup across namespaces (optionally pinned to one namespace).
  //
  // THREE-VALUED (arch-review 54, Phase 2). It used to answer `undefined` for both "the cluster refused to
  // answer" and "the cluster answered and this job is not there", and `adoptWork` read that single value as
  // `absent` — two lines below a comment stating that a failed read is `unknown`. So a Nomad 500 (leader
  // election, rate limit, expired token) meant "this job is gone", and boot recovery re-dispatched a job that
  // was still running: two attempts of one execution, both billing, both writing evidence.
  //
  // K8s already distinguished them. Two implementations of one contract disagreeing about what a failure MEANS
  // is precisely what the shared conformance suite has to assert — and it did not, because it asked whether
  // the method existed rather than what it answers when the cluster errors.
  private async findJob(name: string, namespace?: string): Promise<ReadResult<{ ID?: string; Namespace?: string }>> {
    const res = await this.http.request("GET", `/v1/jobs?prefix=${encodeURIComponent(name)}&namespace=*`);
    if (res.status >= 300) return { kind: "unknown", reason: `the Nomad job listing returned ${res.status}` };
    const found = (JSON.parse(res.text) as Array<{ ID?: string; Namespace?: string }>).find(
      (j) => j.ID === name && (!namespace || (j.Namespace ?? "default") === namespace),
    );
    return found === undefined ? { kind: "absent" } : { kind: "read", value: found };
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
    let read: ReadResult<{ ID?: string; Namespace?: string }>;
    try {
      read = await this.findJob(name, namespace);
    } catch (e) {
      throw new UpstreamError("UPSTREAM_ERROR", { name }, `job lookup failed: ${e instanceof Error ? e.message : e}`);
    }
    // A listing the cluster refused is not a missing workload: answering 404 there tells an operator the
    // job is gone when nobody knows that.
    if (read.kind === "unknown")
      throw new UpstreamError("UPSTREAM_ERROR", { name }, `job lookup failed: ${read.reason}`);
    const stub = read.kind === "read" ? read.value : undefined;
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

  // The failed alloc's log tail as failure evidence ({ logTail } or {}) — stderr preferred (crashes land there),
  // stdout fallback, sentinel-stripped + tail-capped. Best-effort: an unreadable log is simply no evidence.
  private async allocLogTailEvidence(allocId: string, namespace?: string): Promise<{ logTail?: string }> {
    const nsq = namespace ? `&namespace=${encodeURIComponent(namespace)}` : "";
    const read = async (stream: "stderr" | "stdout"): Promise<string> => {
      try {
        const res = await this.http.request(
          "GET",
          `/v1/client/fs/logs/${allocId}?task=agent&type=${stream}&plain=true${nsq}`,
        );
        return res.status < 300 ? stripSentinel(res.text).trim() : "";
      } catch {
        return "";
      }
    };
    const err = await read("stderr");
    const text = err !== "" ? err : await read("stdout");
    return text === "" ? {} : { logTail: text.slice(-FAILURE_LOG_TAIL_CAP) };
  }

  // The alloc DETAIL read — one fetch feeds the task events (OOM detection + the failure summary + the
  // placement event feed) AND the resource ask (the per-job allocations list omits AllocatedResources, so the
  // detail is the only reliable source). Best-effort: a miss reads as no events / no stub.
  private async allocDetail(allocId: string): Promise<{ events: NomadTaskEvent[]; stub?: NomadAllocStub }> {
    try {
      const res = await this.http.request("GET", `/v1/allocation/${allocId}`);
      if (res.status >= 300) return { events: [] };
      const detail = JSON.parse(res.text) as NomadAllocStub & {
        TaskStates?: Record<string, { Events?: NomadTaskEvent[] }>;
      };
      return { events: Object.values(detail.TaskStates ?? {}).flatMap((st) => st.Events ?? []), stub: detail };
    } catch {
      /* detection is best-effort — fall through to the generic alloc-failed error */
      return { events: [] };
    }
  }

  // The alloc's task events, flattened across tasks (one fetch feeds OOM detection AND the failure summary).
  private async allocTaskEvents(allocId: string): Promise<NomadTaskEvent[]> {
    return (await this.allocDetail(allocId)).events;
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

  private async waitForAlloc(
    jobId: string,
    namespace?: string,
    signal?: AbortSignal,
    onWaiting?: (reason: string) => void,
    onInfra?: (event: string, message: string, extra?: { unit?: string; node?: string }) => void,
  ): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    const blockedBudgetMs = this.opts.failOnBlockedEvalMs ?? 120_000;
    const nsq = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
    let blockedSinceMs: number | undefined;
    let placedMarked = false;
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) throw new InternalError("CANCELLED", { jobId }, "dispatch aborted while waiting for alloc.");
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations${nsq}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as Array<{
          ID: string;
          ClientStatus: string;
          CreateIndex?: number;
          DesiredStatus?: string;
          NodeName?: string;
        }>;
        // The CURRENT alloc only — the unique per-dispatch job id shields against CROSS-dispatch staleness, but an
        // in-job restart/reschedule still lists the previous dead alloc, and allocs[0] could judge (and later read
        // the logs of) the PAST alloc as this case's result.
        const alloc = currentAlloc(allocs);
        // No alloc yet: an UNPLACEABLE job (resources beyond every node) never produces one — the scheduler
        // parks a BLOCKED evaluation instead, and this loop would grind the full 30-minute budget on a job
        // that can never start. Surface the blocked verdict (with the exhausted dimensions) after a bounded
        // patience window; short blocked spells (capacity about to free) are tolerated, and the
        // failure is retryable-infra so a sharded batch spills the case to another runtime.
        if (!alloc) {
          const blocked = await this.blockedPlacement(jobId, nsq);
          if (blocked) {
            // Surface the blocked verdict IMMEDIATELY (once per blocked spell) — the caller shows it as a
            // waiting step ("placement blocked — cpu exhausted on 2 node(s)") instead of a silent "queued"
            // while the patience window runs. Managed-lane twin of the self-hosted offline-runner onWaiting.
            if (blockedSinceMs === undefined) {
              try {
                onWaiting?.(`placement blocked — ${blocked}`);
                onInfra?.("blocked", blocked);
              } catch {
                // best-effort; a listener throw must not break dispatch
              }
            }
            blockedSinceMs ??= Date.now();
            if (Date.now() - blockedSinceMs >= blockedBudgetMs) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                // The verdict rides as evidence too (classifyFailure → CaseFailure.placement.events → the
                // failed result's infra trace) — an unplaceable case's record explains itself after GC.
                { jobId, reason: "placement_blocked", placement: { events: [`blocked: ${blocked}`] } },
                `placement blocked — ${blocked} (the job's resources exceed what any eligible node offers; lower the harness resources or add capacity)`,
              );
            }
          } else {
            blockedSinceMs = undefined; // eval progressed — reset the patience window
          }
        }
        if (alloc) {
          // First sighting of the placed unit — the infra record's "placed" mark (unit + node identity).
          if (!placedMarked) {
            placedMarked = true;
            try {
              onInfra?.("placed", `alloc ${alloc.ID}${alloc.NodeName ? ` on ${alloc.NodeName}` : ""}`, {
                unit: alloc.ID,
                ...(alloc.NodeName ? { node: alloc.NodeName } : {}),
              });
            } catch {
              // best-effort; a listener throw must not break dispatch
            }
          }
          if (alloc.ClientStatus === "complete") return alloc.ID;
          if (alloc.ClientStatus === "failed" || alloc.ClientStatus === "lost") {
            const events = await this.allocTaskEvents(alloc.ID);
            // Failure evidence, captured NOW — the dead job (and its raw log) is deleted/GC'd right after
            // settlement, so this throw is the last moment the unit/node/events/log-tail are reachable.
            // classifyFailure lifts extra.placement/logTail onto the CaseFailure.
            const evidence = {
              placement: {
                unit: alloc.ID,
                ...(alloc.NodeName ? { node: alloc.NodeName } : {}),
                events: placementEventLines(events),
              },
              ...(await this.allocLogTailEvidence(alloc.ID, namespace)),
            };
            // OOM-killed reads as fatal infra (raise the harness resources), never as an agent failure.
            if (eventsIndicateOom(events)) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { alloc: alloc.ID, signal: OOM_KILLED, ...evidence },
                "task OOM-killed — raise the harness's resources.memoryMb (infra, not an agent failure)",
              );
            }
            // Carry the task-event cause (image pull denial, driver failure, …) so the CaseResult explains itself.
            const cause = summarizeAllocFailure(events);
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { alloc: alloc.ID, status: alloc.ClientStatus, ...evidence },
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
        FailedTGAllocs?: Record<string, NomadPlacementMetrics> | null;
      }>;
      const failed = evals.find((e) => e.FailedTGAllocs && Object.keys(e.FailedTGAllocs).length > 0);
      const blocked = evals.some((e) => e.Status === "blocked") || failed !== undefined;
      // The renderer is shared with the topology runtime and reads EVERY reason the scheduler records —
      // constraint and class filters included. Reading only the exhausted dimensions is why an unplaceable
      // job ("no node has this driver") used to report as an empty "no eligible node (blocked evaluation)".
      const described = describeNomadPlacementFailure(failed?.FailedTGAllocs);
      if (described) return described;
      return blocked ? "no eligible node (blocked evaluation)" : undefined;
    } catch {
      return undefined;
    }
  }

  // ── Session mode (agent worlds W4) ───────────────────────────────────────────────────────────────────
  // `provision` holds a compute open instead of running one program to completion. Deliberately NO
  // `snapshot`: nothing here can reach a container daemon, which is why the registry layer-append path
  // exists (docs/architecture/agent-worlds.md §W4) — a caller that finds no `snapshot` captures over this
  // compute's own exec channel instead.

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    if (!spec.image) throw new UpstreamError("UPSTREAM_ERROR", {}, "a cluster-placed session needs an image to run");
    // The tenant's zone decides isolation and namespace — the SAME policy `effectiveOpts` applies to a
    // dispatched case, because a session runs untrusted code exactly as a case does.
    const zone = spec.tenant !== undefined ? this.opts.trustZones?.resolve(spec.tenant) : undefined;
    if (zone) assertHardenedIsolation(zone);
    const namespace = zone?.namespace ?? this.opts.namespace;
    const jobId = `${SESSION_JOB_PREFIX}${dispatchSuffix()}`;
    const body = {
      Job: {
        ID: jobId,
        Type: "service", // held open until dispose — a batch job would end the moment its command did
        ...(namespace ? { Namespace: namespace } : {}),
        Datacenters: this.opts.datacenters ?? ["dc1"],
        TaskGroups: [
          {
            Name: SESSION_TASK,
            Count: 1,
            // A session that dies must not be silently restarted underneath its handle: the container's
            // filesystem IS the session, and a fresh one would quietly lose the work.
            RestartPolicy: { Attempts: 0, Mode: "fail" },
            Tasks: [
              {
                Name: SESSION_TASK,
                Driver: "docker",
                Config: {
                  image: spec.image,
                  ...((zone?.isolationRuntime ?? this.opts.runtime)
                    ? { runtime: zone?.isolationRuntime ?? this.opts.runtime }
                    : {}),
                  // The image's own entrypoint is irrelevant — this container is a filesystem to live in.
                  entrypoint: ["sh"],
                  args: ["-c", `mkdir -p ${SESSION_BASE} && exec sleep infinity`],
                  ...(spec.registryAuths?.[0]
                    ? {
                        auth: [
                          {
                            username: spec.registryAuths[0].username ?? "everdict",
                            password: spec.registryAuths[0].password,
                          },
                        ],
                      }
                    : {}),
                },
                Resources: { CPU: 1000, MemoryMB: 2048 },
              },
            ],
          },
        ],
      },
    };
    const submitted = await this.http.request("POST", "/v1/jobs", body);
    if (submitted.status >= 300)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: submitted.status, job: jobId },
        `the cluster refused the session job: ${submitted.text.slice(0, 300)}`,
      );
    try {
      const allocId = await this.waitForSessionAlloc(jobId, namespace);
      return new NomadSessionHandle({
        jobId,
        allocId,
        // A reference the caller already pinned names its own bytes and needs no cluster read; anything else
        // cannot be identified from Nomad's API, and the lane says so rather than staying silent.
        image: laneImageProvenance(spec.image, "the Nomad API"),
        ...(namespace ? { namespace } : {}),
        http: this.http,
        addr: this.opts.addr,
        ...(this.opts.apiToken ? { apiToken: this.opts.apiToken } : {}),
        run: this.opts.execRunner ?? ((bin, args, env) => spawnRunner(bin, args, env)),
      });
    } catch (err) {
      await this.purgeSessionJob(jobId, namespace); // never leave a job the caller has no handle to
      throw err;
    }
  }

  // Tear down a session this process holds no handle to — the durable reaper's path, from the recorded id.
  async reap(id: string): Promise<void> {
    const { jobId, namespace } = parseSessionComputeId(id);
    if (jobId !== "") await this.purgeSessionJob(jobId, namespace);
  }

  private async purgeSessionJob(jobId: string, namespace?: string): Promise<void> {
    const ns = namespace ? `&namespace=${encodeURIComponent(namespace)}` : "";
    // purge=true: a session's job is not history worth keeping, and a lingering dead job would collide with
    // the next session that reuses the id.
    await this.http.request("DELETE", `/v1/job/${encodeURIComponent(jobId)}?purge=true${ns}`).catch(() => undefined);
  }

  private async waitForSessionAlloc(jobId: string, namespace?: string): Promise<string> {
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
    const ns = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
    let lastStatus = "none";
    while (Date.now() < deadline) {
      const res = await this.http.request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations${ns}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as Array<{ ID: string; ClientStatus?: string }>;
        const running = allocs.find((a) => a.ClientStatus === "running");
        if (running) return running.ID;
        const dead = allocs.find((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost");
        if (dead)
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { job: jobId, alloc: dead.ID, status: dead.ClientStatus },
            `the session's allocation ${dead.ClientStatus} before it started — check the image and the client's resources`,
          );
        lastStatus = allocs[0]?.ClientStatus ?? "pending";
      }
      await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
    }
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { job: jobId, lastStatus },
      `the session did not start within ${Math.round(SESSION_READY_TIMEOUT_MS / 1000)}s (last allocation status: ${lastStatus})`,
    );
  }
}
