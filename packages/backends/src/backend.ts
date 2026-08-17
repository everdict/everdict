import {
  type CaseJob,
  type CaseResult,
  type Driver,
  InternalError,
  type KillOutcome,
  type RuntimeSample,
  type RuntimeWorkRef,
  type TraceEvent,
} from "@everdict/contracts";
// Type-only reuse of the inspection wire schemas as the SSOT for Inspectable.inspect's / CaseInspectable.
// inspectCase's returns (no drift, no runtime edge). backends → contracts is the allowed direction; /wire is the
// same package's DTO surface.
import type { CasePlacement, InspectRuntimeResult, TopologyStatus } from "@everdict/contracts/wire";

// Which job output stream a log read targets (Observable.logs). Harnesses often log progress to stderr
// while stdout carries only the final result block — the live tail needs both to be reachable.
export type LogStream = "stdout" | "stderr";

// Result of a one-shot in-container exec (Observable.exec) — the sandbox command's stdout/stderr/exit.
export interface ExecInContainer {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// A live interactive shell stream inside a case container (Shellable.execStream) — the WS terminal route drives it.
// Lifecycle = the WS connection: exactly one consumer, torn down by close(), so there is no unsubscribe (that, and a
// full Node-stream/backpressure model, are deliberate non-goals here). write() is best-effort fire-and-forget.
export interface ExecStreamHandle {
  write(data: string): void; // forward the terminal's keystrokes to the shell's stdin (dropped if the shell already exited)
  onData(cb: (chunk: string) => void): void; // shell stdout/stderr → the terminal
  onError(cb: (err: Error) => void): void; // transport/spawn failure (distinct from a clean exit) — otherwise it is lost
  onExit(cb: (code: number | null) => void): void; // the shell exited (or the container died)
  close(): void; // tear down (WS closed / run terminal)
}

// A backend's concurrent capacity. The scheduler adds its own in-flight to compute free slots.
export interface BackendCapacity {
  total: number; // upper bound of concurrent slots (static config or live probe)
  // External usage the backend observed at probe time (0 when it can't cheaply tell). NOT the whole story: the
  // Scheduler computes free = total − max(used, itsOwnInFlight), because `used` may already INCLUDE this scheduler's
  // jobs (so max avoids double-counting) OR LAG behind them (a just-submitted job the probe hasn't seen yet). The
  // reconciliation is therefore best-effort — under probe lag a backend can briefly over-admit; acceptable for eval
  // workloads and self-correcting on the next probe. Report 0 rather than guessing when a live count is unavailable.
  used: number;
  // Optional memory envelope (declared, e.g. RuntimeSpec.memoryBudgetMb) — caps the SUM of in-flight
  // harness-declared memory the Scheduler admits at once. Absent = slots-only admission (previous behavior).
  memoryBudgetMb?: number;
  // Optional CPU envelope (RuntimeSpec.cpuBudget, resources.cpu units: 1000 = 1 vCPU) — same admission
  // contract as memoryBudgetMb for the SUM of in-flight harness-declared cpu.
  cpuBudget?: number;
}

// Runtime connection probe result — without running a job, checks only "does this cluster actually connect (reachability + auth)".
// Surfaces the "will it connect, unknown" that schema validate() at registration time couldn't tell.
export interface ProbeResult {
  reachable: boolean; // reached the cluster API + (if credentials exist) authenticated successfully
  detail: string; // success: identifying info like version/name; failure: reason (status code/error message)
  // Structured failure classification (undefined when reachable): "auth" = reached but the credential was rejected,
  // "unreachable" = couldn't reach the API at all, "error" = reached but returned an unexpected error. Lets a caller
  // or UI branch ("check your token" vs "check the address") instead of scraping the human-readable `detail`.
  reason?: "unreachable" | "auth" | "error";
}

// Per-dispatch options — currently just cooperative cancellation. A backend that cannot interrupt an already-started
// run (in-process / pull) honors `signal` best-effort by rejecting a not-yet-started dispatch; the pollers (Nomad/K8s)
// additionally stop waiting and reclaim the orchestrator job when the signal aborts mid-run. Ties cancellation to the
// in-flight promise, complementing the id-keyed kill(caseId) side channel.
// The Dispatcher port lives in @everdict/application-control; Backend extends it, so backends re-exports it
// here as a deliberate convenience — a consumer narrowing a Backend gets its supertype from the same module.
export type { DispatchOptions, Dispatcher } from "@everdict/application-control";
import type { DispatchOptions, Dispatcher } from "@everdict/application-control";

// The uniform "this dispatch was cancelled via its AbortSignal" rejection (reuses the CANCELLED code the Scheduler
// already rejects queued entries with, so callers classify it the same way).
export function dispatchAborted(job: CaseJob): InternalError {
  return new InternalError("CANCELLED", { caseId: job.evalCase.id }, "dispatch aborted.");
}

// The CORE placement contract — every backend implements this. "Where does it run": the control plane holds the
// backends and routes jobs; isolation is provided by each backend's runtime (Nomad task driver / K8s runtimeClass /
// Windows VM). Anything beyond dispatch+capacity is an OPTIONAL capability (see the capability interfaces below) —
// expressed as a separate interface + a narrowing guard, NOT as optional methods on this one, so a caller narrows
// with `isObservable(backend)` (compiler-checked) instead of feature-detecting `backend.logs` (undefined at runtime).
export interface Backend extends Dispatcher {
  capacity(): Promise<BackendCapacity>; // for capacity-aware placement — free concurrent slots
}

// --- Capability interfaces: a backend MAY additionally implement any of these. Narrow to them with the guards below. ---

// The result of Recoverable.adopt — deliberately three-valued so the caller never conflates "no job to adopt"
// (safe to re-dispatch) with "couldn't determine" (re-dispatching may double-spend a job that is actually still
// live). The old `CaseResult | undefined` collapsed both into undefined and quietly risked double compute.
export type AdoptOutcome =
  | { status: "adopted"; result: CaseResult } // harvested a finished job's result → do NOT re-dispatch
  | { status: "absent" } // the listing succeeded and there is definitively no job for this case → safe to re-dispatch
  | { status: "unknown" }; // an API/parse failure left it ambiguous → re-dispatch MAY double-spend a live job

// Recoverable — reclaim a case's orchestrator job without re-running it. Backends whose jobs outlive the control
// plane (Nomad/K8s) implement this; in-process/pull backends do not.
export interface Recoverable {
  // Adopt an already-dispatched case job (boot recovery): find the orchestrator job this backend previously
  // submitted for the case, wait for it, and harvest its result — instead of re-dispatching and double-spending
  // compute. Best-effort and TOTAL — never throws; the ambiguity is encoded in AdoptOutcome, not swallowed to a
  // bare undefined, so the caller decides re-dispatch policy per `absent` (safe) vs `unknown` (may double-spend).
  //
  // ⚠️ CASE-ID ADDRESSED, therefore AMBIGUOUS (arch-review 52, Wave 2). It picks the NEWEST job carrying the
  // case id — which, with two runs of one case live at once, is somebody else's execution, and adopting it
  // attributes their verdict to this run. A caller that HOLDS a work handle must not come here; the exact
  // path is `WorkAddressable`. This stays for the callers that hold none (legacy attempt rows written before
  // the handle was persisted, and the lanes that never mint one).
  adopt(caseId: string): Promise<AdoptOutcome>;
  // Force-stop every live orchestrator job of a case (superseded batch reclaim). Never throws — it ANSWERS
  // instead (arch-review 52, Wave 3): `stopped`/`absent` are convergence, `unknown`/`failed` say the compute
  // is probably still burning and the caller's cancellation is still owed. It used to return `Promise<void>`,
  // which made "the delete request returned" and "the job stopped" the same observation.
  //
  // ⚠️ SAME AMBIGUITY, with a destructive blast radius: "every live job of this case" includes the ones other
  // runs — and, before the K8s case label became injective, other CASES — placed. Use `WorkAddressable.
  // killWork` wherever a handle exists; this is the no-handle fallback and nothing else.
  kill(caseId: string): Promise<KillOutcome>;
}

// WorkAddressable — CONTROL ADDRESSED BY THE EXACT WORK, not by what the work was about (arch-review 52,
// Wave 2). The backend minted the handle when it created the external object (`DispatchOptions.onWork`); the
// caller persisted it; this is the other end. `killWork` stops the object that handle names, in the namespace
// it names, and nothing else — no prefix scan, no cross-namespace sweep, no label that another run shares.
//
// Backends whose work outlives the dispatch call implement it (Nomad/K8s), the same set that implements
// `Recoverable`. In-process and pull backends do not: they have no external object to hand out a name for.
export interface WorkAddressable {
  // Idempotent, like every stop on this layer: work that is already gone is `absent`, and a handle from
  // another cluster simply matches nothing there — also `absent`. Never throws; the ambiguity is in the
  // ANSWER (arch-review 52, Wave 3), because a caller that cannot tell "stopped" from "could not reach the
  // cluster" has no honest way to decide whether its cancellation converged.
  killWork(work: RuntimeWorkRef): Promise<KillOutcome>;
}

// ── EXACT ADDRESSING IS THE DEFAULT, NOT A KILL-ONLY CAPABILITY (arch-review 53, Wave B) ─────────────
//
// Wave 2 gave the stop an exact address and stopped there. Every other control path into live work kept
// resolving a CASE ID the way the old kill did — list the jobs carrying `everdict.dev/case=<slug>`, take the
// newest — and "newest" is whichever job the cluster created last, not the one the caller asked about. Two
// runs of one case are two live jobs by construction (a re-evaluation beside a scheduled batch, a retry
// beside the attempt it replaces, a shadow beside its baseline), so:
//
//   logs      → another run's output in this run's live panel
//   exec      → a command executed inside another run's sandbox: a WRITE into a world nobody asked about
//   inspect   → this run's placement panel describing another run's phase, node and events
//   adopt     → boot recovery handing THIS execution the verdict ANOTHER execution's job produced
//
// The last one is not observability. Adoption decides which bytes a receipt vouches for, so a case-id-resolved
// adopt puts the decision plane at the mercy of creation timestamps.
//
// A backend that can name its work (`reserve`) can be asked about exactly that work. The case-id twins on
// `Recoverable`/`Observable`/`CaseInspectable`/`CaseSampleable` survive as the LEGACY compatibility surface —
// pre-handle rows, and the debug/display reads a human drives — and are forbidden on recovery, cancellation
// and decision paths (`unknown-collapse-guard`'s sibling scan enforces the ban).
export interface ManagedWorkControl {
  // Harvest the finished result of exactly this work, for boot recovery. `absent` means the object is not
  // there (safe to re-dispatch); `unknown` means the cluster could not be asked (re-dispatching may
  // double-spend) — the same three-valued discipline the case-id adopt already had, now about the right job.
  adoptWork(work: RuntimeWorkRef): Promise<AdoptOutcome>;
  // Current output of exactly this work's pod/alloc. undefined = the object is gone or its log is unreadable.
  logsForWork(work: RuntimeWorkRef, stream?: LogStream): Promise<string | undefined>;
  // The live event lines this work emitted (the same stream `caseEvents` reads, addressed exactly).
  eventsForWork(work: RuntimeWorkRef): Promise<TraceEvent[] | undefined>;
  // One-shot exec inside exactly this work's container. undefined = no live container.
  execInWork(
    work: RuntimeWorkRef,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  // Placement view of exactly this work — phase, unit, node, events.
  inspectWork(work: RuntimeWorkRef): Promise<CasePlacement | undefined>;
  // Live resource usage of exactly this work.
  sampleWork(work: RuntimeWorkRef): Promise<CaseRuntimeSample | undefined>;
}

// Observable — live-progress introspection into a case's running sandbox (logs + one-shot exec). The sandbox is
// already untrusted+isolated, so the control plane gates WHO may call these (run creator / workspace admin).
export interface Observable {
  // Current output of the case's newest orchestrator job (live-progress observability). Raw text with the result
  // sentinel and live-event lines stripped; undefined = no job / logs unreadable. Snapshot semantics — callers poll
  // and diff for a tail. stream selects stdout (default) or stderr — agents/harnesses often log progress to stderr
  // while stdout carries only the final result block. K8s merges both streams in the pod log, so it accepts and
  // ignores the parameter.
  logs(caseId: string, stream?: LogStream): Promise<string | undefined>;
  // The live-event lines of that same job stdout, decoded (live-observability ⑨): the TraceEvents the in-job agent
  // printed as EVENT_SENTINEL lines while the case runs — the managed lane's live trajectory. Snapshot semantics
  // like logs() (each read returns everything printed so far). undefined = no job / logs unreadable; [] = a job
  // that hasn't printed any events yet. Best-effort, never throws.
  caseEvents(caseId: string): Promise<TraceEvent[] | undefined>;
  // Run a one-shot command INSIDE the case's live sandbox container (web terminal / live-screen capture). The
  // command is passed to `sh -c`. undefined = no live container to exec into. Best-effort.
  exec(caseId: string, command: string): Promise<ExecInContainer | undefined>;
}

// Shellable — an INTERACTIVE shell stream inside the case's live container (observability ⑥ — PTY over WS). Split
// from Observable because it needs a real streaming exec: Nomad (`nomad alloc exec -i`) has it, K8s does not — the
// type now says so instead of a runtime `undefined`. The control plane pipes a WebSocket to the returned handle.
export interface Shellable {
  execStream(caseId: string): Promise<ExecStreamHandle | undefined>; // undefined = no live container. Best-effort.
}

// ScreenCapturable — a live screen frame for a run's per-case browser (topology backends only). Deliberately keyed
// by the CP-minted runId (not caseId) because the browser is a per-RUN resource the control plane rediscovers by
// that id; isolating it here keeps the run-vs-case key mismatch off the core Backend/Observable contracts.
export interface ScreenCapturable {
  // base64 PNG (no data: prefix), or undefined when there's no running browser.
  captureScreen(runId: string): Promise<string | undefined>;
}

// ScreenAttachable — where a run's live browser can be REACHED, as opposed to a frame of it. Watching answers
// "what is the agent doing"; attaching answers "let me do it myself" — the login wall, the captcha, the consent
// dialog a case cannot get past on its own. Separate from ScreenCapturable because a lane may be able to take a
// picture (an exec + screenshot) without offering anything to drive.
export interface ScreenAttachable {
  // Control-plane-reachable CDP HTTP base of the run's live browser, or undefined once it is gone.
  screenEndpoint(runId: string): Promise<string | undefined>;
}

// Probeable — a connection test: a light call to the cluster API without a job, to check reachability/auth.
export interface Probeable {
  probe(): Promise<ProbeResult>;
}

// Inspectable — a read-only live view of the cluster behind a runtime: its composition (nodes/datacenters),
// concurrent capacity, the everdict workload currently placed on it, and any shared topology stores. A superset of
// probe (it establishes reachability first, then enumerates) for the runtime detail screen. TOTAL/best-effort: a
// partial-cluster failure never throws — the failed sub-read is recorded in the result's `warnings` and its section
// omitted, so a degraded cluster still renders. Only nomad/k8s implement it; local (no cluster) does not.
export interface Inspectable {
  inspect(): Promise<InspectRuntimeResult>;
}

// CaseInspectable — case-scoped placement introspection: where does THIS case's orchestrator job stand inside the
// cluster (placed or not, on which node, and why not). The case-scoped sibling of the runtime-scoped Inspectable —
// it answers "is my case blocked on capacity / stuck pulling an image / OOM-looping" while the case is still alive,
// instead of that verdict surfacing only inside a thrown error after the dispatch has already failed. undefined =
// no orchestrator job for the case (pre-dispatch / GC'd). Best-effort and MUST NOT throw (observability read).
export interface CaseInspectable {
  inspectCase(caseId: string): Promise<CasePlacement | undefined>;
}

// CaseSampleable — a point-in-time resource sample of THIS case's live sandbox, read from the orchestrator's
// stats API. The producer half of the replay runtime plane (docs/architecture/replay.md ③): the control-plane
// sampler polls it while the case runs and streams the samples onto the recording's `runtime` lane, so a replay
// can answer "did it OOM / thrash" alongside the agent trace. The sample is UNstamped — `t` belongs to the
// caller (the sample instant is when the poll fired). undefined = no live alloc (pre-dispatch / settled / GC'd).
// Best-effort and MUST NOT throw (observability read).
export type CaseRuntimeSample = Omit<RuntimeSample, "t">;
export interface CaseSampleable {
  sampleCase(caseId: string): Promise<CaseRuntimeSample | undefined>;
}

// TopologyInspectable — service-topology health introspection: the live roster of a service harness's deployed
// stack (per-service state/restarts/OOM) + one service's log tail. Keyed by the HARNESS (the topology is a warm
// per-(harness,version,zone) deployment, not a per-case unit) with the tenant resolving the trust zone. Only
// ServiceTopologyBackend implements it; the topology runtime behind it (Nomad/K8s/Docker) does the actual read.
// undefined = not a service harness / no live topology / the runtime can't tell. Best-effort, MUST NOT throw.
export interface TopologyInspectable {
  inspectTopology(harness: { id: string; version: string }, tenant?: string): Promise<TopologyStatus | undefined>;
  topologyServiceLogs(
    harness: { id: string; version: string },
    service: string,
    tenant?: string,
  ): Promise<string | undefined>;
}

// CaseCapacityAware — harness-keyed capacity, for a backend whose REAL limit depends on which harness a job
// drives (a topology backend's session pools are per warm topology, so one runtime carrying two service
// harnesses has two independent limits). The Scheduler consults it per job during placement ON TOP of the
// backend-wide capacity() (which stays the aggregate the probe reports): a job only places where its own
// harness has room. Must be CHEAP — it runs per queued job per placement round, so implementations answer from
// the readings the backend-wide capacity() probe already refreshed, never with a live probe of their own.
// undefined = no per-harness signal for this job (not warm yet / no pool declared) → the aggregate decides.
export interface CaseCapacityAware {
  capacityFor(job: CaseJob): Promise<BackendCapacity | undefined>;
}

// PoolReporting — the last known session-pool readings behind a backend's capacity (the pool that lives INSIDE a
// service container, invisible to any orchestrator read). Read-only and non-probing: the readings refresh with the
// capacity probes the Scheduler pump already drives, so the /metrics scrape samples without touching the cluster.
// `pool` is the warm identity (spec id@version, zone-suffixed for zoned tenants); `used` is absent when the
// service does not report it. ServiceTopologyBackend implements it; job-runner backends have no session pool.
export interface PoolReporting {
  poolStats(): Array<{ pool: string; total: number; used?: number }>;
}

// Reclaimable — DESTRUCTIVE live-cluster control paired with Inspectable, for the runtime detail screen's admin
// actions (gated runtimes:control at the control plane). Nomad/K8s implement it; local does not. The reclaim
// methods are best-effort and idempotent (acting on an already-gone target is a no-op, not an error) — the caller
// re-inspects after. stopWorkload force-stops one unit — an everdict unit (aborts that one eval, distinct from the
// graceful run/scorecard cancel) or, with its namespace, an EXTERNAL unit (K8s: deletes the pod's owning controller;
// Nomad: deregisters the job); reclaimIdle stops long-running NON-store everdict units in bulk (external units are
// never swept); purgeTerminal GCs dead/completed everdict jobs (reclaims slots/disk); setNodeSchedulable cordons/
// uncordons a node (reversible) for maintenance. resizeWorkload is the one DELIBERATE exception to best-effort:
// changing a unit's resources on an unsupported target must not read as done, so it THROWS an AppError
// (BadRequestError/NotFoundError/UpstreamError) instead of silently no-oping.
export interface Reclaimable {
  stopWorkload(name: string, namespace?: string): Promise<void>; // force-stop one live unit by its InspectWorkload.name (+namespace for external units)
  reclaimIdle(olderThanSeconds: number): Promise<{ stopped: number }>; // stop non-store everdict units running longer than the threshold
  purgeTerminal(): Promise<{ purged: number }>; // deregister/delete dead/completed everdict jobs
  setNodeSchedulable(node: string, schedulable: boolean): Promise<void>; // cordon (false) / uncordon (true) a node by name
  // Change a unit's resource ask in the runtime's NATIVE units (cpu MHz|millicores, memory MiB). Replaces the unit
  // (Nomad job resubmit / K8s controller rolling update). Throws on unsupported targets — see the contract above.
  resizeWorkload(
    name: string,
    resources: { cpu?: number; memoryMb?: number },
    namespace?: string,
  ): Promise<{ detail: string }>;
}

// --- Narrowing guards: express capability at the type level. Prefer these over `if (backend.method)` feature detection. ---

export function isRecoverable(backend: Backend): backend is Backend & Recoverable {
  const b = backend as Partial<Recoverable>;
  return typeof b.adopt === "function" && typeof b.kill === "function";
}

export function isWorkAddressable(backend: Backend): backend is Backend & WorkAddressable {
  return typeof (backend as Partial<WorkAddressable>).killWork === "function";
}

// Narrows to the exact-work control surface (arch-review 53, Wave B). A backend implements all of it or none:
// the methods share one resolution (the handle names the object) and a partial implementation would put a
// caller back to guessing which reads are exact.
export function isWorkControllable(backend: Backend): backend is Backend & ManagedWorkControl {
  return typeof (backend as Partial<ManagedWorkControl>).adoptWork === "function";
}

export function isPoolReporting(backend: Backend): backend is Backend & PoolReporting {
  return typeof (backend as Partial<PoolReporting>).poolStats === "function";
}

export function isCaseCapacityAware(backend: Backend): backend is Backend & CaseCapacityAware {
  return typeof (backend as Partial<CaseCapacityAware>).capacityFor === "function";
}

export function isObservable(backend: Backend): backend is Backend & Observable {
  const b = backend as Partial<Observable>;
  return typeof b.logs === "function" && typeof b.exec === "function" && typeof b.caseEvents === "function";
}

export function isShellable(backend: Backend): backend is Backend & Shellable {
  return typeof (backend as Partial<Shellable>).execStream === "function";
}

// Sessionable — this placement target can also hold a compute OPEN instead of running one program to completion.
//
// `dispatch` runs a job and hands back its result; a world session is the SAME compute under a different mode:
// held open while the control plane drives it step by step. Two modes of one resource, not two resources — and
// the first cut of agent worlds got that wrong. It shipped a separate session driver, which duplicated the
// orchestrator's placement knowledge (job submission, zone application, namespace, exec) and, worse, put
// sessions OUTSIDE `capacity()`: a cluster could fill with sessions while the Scheduler still believed it had
// slots. Folding the mode in makes ONE object the authority for "compute on this target".
//
// The capability IS the existing `Driver` contract rather than a new interface, so the consumer — the sandbox
// session service, which sits BELOW this package — keeps depending on @everdict/contracts alone.
export function isSessionable(backend: Backend): backend is Backend & Driver {
  return typeof (backend as Partial<Driver>).provision === "function";
}

export function isScreenCapturable(backend: Backend): backend is Backend & ScreenCapturable {
  return typeof (backend as Partial<ScreenCapturable>).captureScreen === "function";
}

export function isScreenAttachable(backend: Backend): backend is Backend & ScreenAttachable {
  return typeof (backend as Partial<ScreenAttachable>).screenEndpoint === "function";
}

export function isProbeable(backend: Backend): backend is Backend & Probeable {
  return typeof (backend as Partial<Probeable>).probe === "function";
}

export function isInspectable(backend: Backend): backend is Backend & Inspectable {
  return typeof (backend as Partial<Inspectable>).inspect === "function";
}

export function isCaseInspectable(backend: Backend): backend is Backend & CaseInspectable {
  return typeof (backend as Partial<CaseInspectable>).inspectCase === "function";
}

export function isCaseSampleable(backend: Backend): backend is Backend & CaseSampleable {
  return typeof (backend as Partial<CaseSampleable>).sampleCase === "function";
}

export function isTopologyInspectable(backend: Backend): backend is Backend & TopologyInspectable {
  const b = backend as Partial<TopologyInspectable>;
  return typeof b.inspectTopology === "function" && typeof b.topologyServiceLogs === "function";
}

export function isReclaimable(backend: Backend): backend is Backend & Reclaimable {
  const b = backend as Partial<Reclaimable>;
  return (
    typeof b.stopWorkload === "function" &&
    typeof b.reclaimIdle === "function" &&
    typeof b.purgeTerminal === "function" &&
    typeof b.setNodeSchedulable === "function" &&
    typeof b.resizeWorkload === "function"
  );
}
