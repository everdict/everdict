import {
  type CaseJob,
  ConflictError,
  type Driver,
  InternalError,
  type KillOutcome,
  type PersistedWorkIntent,
  type RuntimeSample,
  type RuntimeWorkRef,
  type TraceEvent,
  type VerifierInvocation,
  type VerifierJob,
  type WorkPresence,
} from "@everdict/contracts";
// Type-only reuse of the inspection wire schemas as the SSOT for Inspectable.inspect's / ManagedWorkControl.
// inspectCase's returns (no drift, no runtime edge). backends → contracts is the allowed direction; /wire is the
// same package's DTO surface.
import type { CasePlacement, InspectRuntimeResult, TopologyStatus } from "@everdict/contracts/wire";

// Which job output stream a log read targets (ManagedWorkControl.logsForWork). Harnesses often log to stderr
// while stdout carries only the final result block — the live tail needs both to be reachable.
export type LogStream = "stdout" | "stderr";

// Result of a one-shot in-container exec (ManagedWorkControl.execInWork) — stdout/stderr/exit.
export interface ExecInContainer {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// A live interactive shell stream inside a case container (ManagedWorkControl.execStreamInWork).
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
  // ── "COULD NOT COUNT" IS NOT "COUNTED ZERO" (arch-review 63, the fleet-permit assessment) ──────────
  //
  // This number is the ONLY fleet-wide bound on a backend's slots. The tenant quota has an atomic permit; the
  // slot, memory and CPU envelopes are per-PROCESS accounting, so what stops N replicas each admitting a full
  // `total` is that they all read the orchestrator's own count of what is running. Both managed lanes used to
  // report a failed probe as `0` — `used ?? 0` over a `countActiveJobs` that already answered `undefined`,
  // and a Nomad `catch` commented "probe failed -> used 0". During an API-server outage every replica then
  // computed free slots against an empty cluster and kept admitting at full width, for as long as the outage
  // lasted. That is a different failure from the probe LAG disclosed below: lag self-corrects on the next
  // probe, this does not.
  //
  // So a lane says which it means, and `effectiveUsed` is the one place the third answer is folded — into
  // `total`, i.e. no free slots, because a replica that cannot verify the bound may not spend it (rule
  // `protocol` L2, whose fail-closed side is holding). The work stays queued, which is the right answer
  // anyway: a dispatch to an orchestrator we cannot reach was going to fail.
  //
  // External usage the backend observed at probe time (0 when it can't cheaply tell). NOT the whole story: the
  // Scheduler computes free = total − max(used, itsOwnInFlight), because `used` may already INCLUDE this scheduler's
  // jobs (so max avoids double-counting) OR LAG behind them (a just-submitted job the probe hasn't seen yet). The
  // reconciliation is therefore best-effort — under probe lag a backend can briefly over-admit; acceptable for eval
  // workloads and self-correcting on the next probe. Report 0 rather than guessing when a live count is unavailable.
  used: number | "unknown";
  // ── WHAT THESE TWO AXES BOUND, AND WHAT THEY DO NOT (arch-review 64 P1) ────────────────────────────
  //
  // Assessed rather than assumed, because the answer is not the same as it is for `used` above.
  //
  //   TENANT CONCURRENCY is fleet-wide and hard — `AdmissionLedger.tryAdmit` is an atomic per-tenant permit.
  //   SLOTS are bounded across replicas by OBSERVATION: `used` is the orchestrator's own count, so another
  //     replica's placement becomes visible once its object exists, and an unverifiable probe is fail-closed.
  //   MEMORY and CPU are bounded PER PROCESS ONLY, and there is no weaker word for it. The two fields below
  //     are DECLARED envelopes read from config; nothing observes actual allocation, so the usage subtracted
  //     from them is `Admission`'s process-local accounting and nothing else. Two replicas with a 4 GiB
  //     runtime budget can each locally reserve 3 GiB and neither sees the other: 6 GiB admitted.
  //
  // ── …AND THE PROBE THAT MAKES THEM FLEET-WIDE (arch-review 68) ───────────────────────────────────
  //
  // The paragraph above named two ways to close it: a capacity probe reporting observed memory/CPU, or a
  // durable per-backend resource permit. The probe is the right one here and not by preference — it is the
  // mechanism SLOTS already use, so closing the gap adds an axis to a working primitive rather than a second
  // primitive beside it. `effectiveUsed` folds all three identically, including the fail-closed `unknown`.
  //
  // A lane that cannot cheaply tell reports `unknown` rather than `0`, for the reason the slot count learned
  // the hard way: during an API-server outage, `?? 0` had every replica computing free capacity against an
  // empty cluster and admitting at full width for as long as the outage lasted. A lane that reports NOTHING
  // (leaves these undefined) keeps the previous behaviour — process-local accounting — because a lane with
  // no probe must not be silently upgraded to claiming a bound it cannot observe.
  //
  // Observed memory allocated on this backend right now, in MiB, or `unknown` when the probe could not tell.
  // Undefined = this lane has no memory probe; admission stays process-local for this axis and says so.
  usedMemoryMb?: number | "unknown";
  // The CPU twin, in the same units as `cpuBudget` (1000 = 1 vCPU).
  usedCpu?: number | "unknown";
  //
  // Optional memory envelope (declared, e.g. RuntimeSpec.memoryBudgetMb) — caps the SUM of in-flight
  // harness-declared memory the Scheduler admits at once. Fleet-wide when `usedMemoryMb` is observed,
  // WITHIN ONE PROCESS otherwise. Absent = slots-only admission.
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
import type { Dispatcher, ManagedDispatchAuthority, VerifierDispatchHooks } from "@everdict/application-control";
import type { AdoptedWork } from "@everdict/contracts";

// The uniform "this dispatch was cancelled via its AbortSignal" rejection (reuses the CANCELLED code the Scheduler
// already rejects queued entries with, so callers classify it the same way).
export function dispatchAborted(job: CaseJob): InternalError {
  return new InternalError("CANCELLED", { caseId: job.evalCase.id }, "dispatch aborted.");
}

// The CORE placement contract — every backend implements this. "Where does it run": the control plane holds the
// backends and routes jobs; isolation is provided by each backend's runtime (Nomad task driver / K8s runtimeClass /
// Windows VM). Anything beyond dispatch+capacity is an OPTIONAL capability (see the capability interfaces below) —
// expressed as a separate interface + a narrowing guard, NOT as optional methods on this one, so a caller narrows
// with `isWorkControllable(backend)` (compiler-checked) instead of feature-detecting `backend.logsForWork`.
export interface Backend extends Dispatcher {
  capacity(): Promise<BackendCapacity>; // for capacity-aware placement — free concurrent slots
}

// --- Capability interfaces: a backend MAY additionally implement any of these. Narrow to them with the guards below. ---

// The result of ManagedWorkControl.adoptWork — three-valued so the caller never conflates "no job to adopt"
// (safe to re-dispatch) with "couldn't determine" (re-dispatching may double-spend a job that is actually still
// live). The old `CaseResult | undefined` collapsed both into undefined and quietly risked double compute.
export type AdoptOutcome =
  // Harvested a finished job's answer → do NOT re-dispatch. The STAGE travels with it (arch-review 60 P0):
  // a case's agent half and its private verifier are two handles under one execution id, and a caller that
  // takes "the first adopted answer" must be unable to settle the wrong one as the case's result.
  | { status: "adopted"; adopted: AdoptedWork }
  | { status: "absent" } // the listing succeeded and there is definitively no job for this case → safe to re-dispatch
  // ── THE OBJECT EXISTS AND CAN NEVER FINISH (arch-review 62 P0) ────────────────────────────────────
  //
  // Both managed lanes create their external object INERT — a K8s Job at `suspend: true`, a Nomad job at
  // `Count: 0` — so a cancellation racing a dispatch always has something to address. A crash between that
  // creation and the activation leaves the object in that phase with nobody to move it, and the three
  // answers above had no word for it: the object is present, so adoption waited for it to complete, and a
  // suspended Job does not complete. The timeout became `unknown`, `unknown` is `retry_later` by design,
  // and every later sweep repeated it over an orphan no owner would ever resume or delete.
  //
  // Not a rename of `unknown`: that arm means compute MAY be burning, which is why re-dispatching over it
  // can double-spend. Inert means NOTHING has been spent — zero pods, zero allocations, both verified on
  // live clusters — so the caller re-drives exactly as it does for `absent`. The lane reports this only
  // after reclaiming the object and READING THE DELETE BACK (L5); a delete it could not confirm is
  // `unknown`, because a submitter paused across the crash could still resume what is still there.
  // …and WHICH object was reclaimed, so the attempt that owned it can be closed by whoever re-drives.
  | { status: "inert"; work: RuntimeWorkRef }
  | { status: "unknown" }; // an API/parse failure left it ambiguous → re-dispatch MAY double-spend a live job

// What a recovery DOES with one lane's answer. Exported and pure because the fold that consumes it lives in a
// composition root, where no counterexample can reach it — and this is the decision the new arm exists to
// make, so it has to be assertable. Exhaustive by construction: a status added later stops compiling here
// instead of falling through to whichever arm happens to be last (arch-review 62 P0).
export type AdoptionStep =
  | { kind: "harvest"; adopted: AdoptedWork } // a finished container's answer — settle it, never re-dispatch
  // Established that nothing of this work is live or can become live — safe to re-place. `reclaimed` names
  // the object the lane REMOVED to get here, which only the inert arm has: an attempt whose external object
  // was taken away is not a live attempt, and leaving its row `reserved`/`active` tells a cancellation to
  // chase an object that is gone and an operator that work is running when none is (arch-review 63 P1).
  | { kind: "redrive"; reclaimed?: RuntimeWorkRef }
  | { kind: "unresolved" }; // nobody could tell us — decide nothing, the sweep comes back

export function adoptionStep(outcome: AdoptOutcome): AdoptionStep {
  switch (outcome.status) {
    case "adopted":
      return { kind: "harvest", adopted: outcome.adopted };
    case "unknown":
      return { kind: "unresolved" };
    // An object still in its birth phase was found AND reclaimed by the lane, which read the delete back
    // before reporting it. Nothing was ever spent on it and it is gone, so this run stands exactly where one
    // whose object was never created stands. Joined to `absent` HERE, in one place a test can point at,
    // rather than by a fall-through nobody wrote down.
    case "inert":
      // The lane found an object still in its birth phase and removed it, reading the delete back first. The
      // attempt that owned it is therefore over — say which one, so the caller can close its row instead of
      // opening a second execution beside a first that still reads as live.
      return { kind: "redrive", reclaimed: outcome.work };
    case "absent":
      return { kind: "redrive" };
  }
}

// WorkAddressable — CONTROL ADDRESSED BY THE EXACT WORK, not by what the work was about (arch-review 52,
// Wave 2). The backend minted the handle when it created the external object (`DispatchOptions.onWork`); the
// caller persisted it; this is the other end. `killWork` stops the object that handle names, in the namespace
// it names, and nothing else — no prefix scan, no cross-namespace sweep, no label that another run shares.
//
// Backends whose work outlives the dispatch call implement it (Nomad/K8s), the same set that implements
// `ManagedWorkControl`. In-process and pull backends do not: they have no external object to name.
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
// The case-id twins are GONE (arch-review 53, legacy removal). They survived one wave as a compatibility
// surface for pre-handle ledger rows, forbidden on decision paths by a scanner; that arrangement asked every
// future caller to know which of two functions was the safe one, and the answer was never visible at the call
// site. A caller that holds no handle now gets `unknown` — the postcondition is unestablished, which is the
// honest answer and the one the constitution already requires everywhere else.
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
  // An INTERACTIVE shell stream inside exactly this work's container (the WS terminal). Optional on the
  // capability because it needs a real streaming exec: Nomad has `nomad alloc exec -i`, K8s does not.
  execStreamInWork?(work: RuntimeWorkRef): Promise<ExecStreamHandle | undefined>;
  // Placement view of exactly this work — phase, unit, node, events.
  inspectWork(work: RuntimeWorkRef): Promise<CasePlacement | undefined>;
  // Live resource usage of exactly this work.
  sampleWork(work: RuntimeWorkRef): Promise<CaseRuntimeSample | undefined>;
  // DOES IT STILL EXIST? (arch-review 56, Wave G.) `killWork` answers `stopped` when the orchestrator ACCEPTED
  // the delete — K8s returns from `--wait=false` as soon as the API server records it, Nomad once the job is
  // marked — and the container keeps running through its grace period. A cancellation converging on that
  // certifies freed compute that is still burning, so a teardown reads back and only an observed `absent`
  // converges. Separate from `inspectWork` on purpose: that answers a display PHASE, and a phase cannot tell
  // "not started yet" from "not there any more".
  probeWork(work: RuntimeWorkRef): Promise<WorkPresence>;
}

// VerifierDispatchable — this lane can run a case's JUDGING half away from its agent (arch-review 56, Wave K).
//
// A case whose grading depends on material the agent must not see is REFUSED by `caseJobPayload` on a lane
// that runs both in one container. This is what lifts that refusal: the same image and the same result
// contract, dispatched a second time with the verifier payload, so the plan and its credentials are never in
// the container the harness ran in.
//
// Separate from `Backend` because a lane may legitimately not have it (a self-hosted runner grades in place by
// design), and a caller narrows with `isVerifierDispatchable` rather than feature-detecting a method.
// What a verifier lane is handed mid-dispatch. IMPORTED, not re-declared: the note that used to sit here said
// it was spelled locally "because a backend may not depend on application-control (the cone runs the other
// way)" — and this package has depended on it for as long as it has imported `DispatchOptions` from it. So
// the sentence was false and the duplicate was drift: two spellings of one shape, which is how the next field
// lands in one of them (rule `protocol` L3). Re-exported so consumers of this module keep their import.
export type { VerifierDispatchHooks } from "@everdict/application-control";

export interface VerifierDispatchable {
  // Answers the INVOCATION, not bare numbers (arch-review 57 P1). A lane knows which procedure it ran, which
  // workspace it read, where it ran and in which world; answering `Score[]` threw all of that away one frame
  // from where it was known, so a replay could report a verdict and not what produced it.
  // `onReserved` is the SAME ordering the agent's dispatch uses (arch-review 57 P0-verifier): the lane
  // reports the exact work it is about to create BEFORE creating it, so a control plane that dies in
  // between leaves a row naming a job something can address — and so a cancellation, which reads attempt
  // rows, can see the verifier at all. Optional: a lane with no ledger wired passes nothing.
  dispatchVerifier(job: VerifierJob, hooks?: VerifierDispatchHooks): Promise<VerifierInvocation>;
}

export function isVerifierDispatchable(backend: Backend): backend is Backend & VerifierDispatchable {
  return typeof (backend as Partial<VerifierDispatchable>).dispatchVerifier === "function";
}

// ScreenCapturable — a live screen frame for a run's per-case browser (topology backends only). Deliberately keyed
// by the CP-minted runId (not caseId) because the browser is a per-RUN resource the control plane rediscovers by
// that id; isolating it here keeps the run-vs-case key mismatch off the core Backend contract.
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

// (superseded by ManagedWorkControl.sampleWork) — a point-in-time resource sample, read from the orchestrator's
// stats API. The producer half of the replay runtime plane (docs/architecture/replay.md ③): the control-plane
// sampler polls it while the case runs and streams the samples onto the recording's `runtime` lane, so a replay
// can answer "did it OOM / thrash" alongside the agent trace. The sample is UNstamped — `t` belongs to the
// caller (the sample instant is when the poll fired). undefined = no live alloc (pre-dispatch / settled / GC'd).
// Best-effort and MUST NOT throw (observability read).
export type CaseRuntimeSample = Omit<RuntimeSample, "t">;

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

export function isWorkAddressable(backend: Backend): backend is Backend & WorkAddressable {
  return typeof (backend as Partial<WorkAddressable>).killWork === "function";
}

// Narrows to the exact-work control surface (arch-review 53, Wave B). A backend implements all of it or none:
// the methods share one resolution (the handle names the object) and a partial implementation would put a
// caller back to guessing which reads are exact.
export function isWorkControllable(backend: Backend): backend is Backend & ManagedWorkControl {
  return typeof (backend as Partial<ManagedWorkControl>).adoptWork === "function";
}

// ── THE RESERVATION A MANAGED DISPATCH MUST HOLD (arch-review 54, Phase 1) ──────────────────────────
//
// One place, shared by every backend that creates addressable external work, because "did the caller record
// this?" is the same question on K8s and Nomad and the two must not answer it differently — the last time a
// rung was implemented twice, one adapter reported a cluster error as absence for a whole review cycle.
//
// The rule it enforces: a job that names a run is TRACKED work, and tracked work is not created until the
// store says the handle is durable. An absent hook is not "this deployment does not track placements" — the
// deployment that does not track them dispatches jobs with no `runId`, which never reach this line. A hook
// that resolves without proof is the same hole with a callback in front of it.
export async function requireReservation(
  job: CaseJob,
  work: RuntimeWorkRef,
  authority?: ManagedDispatchAuthority,
): Promise<PersistedWorkIntent> {
  if (!authority)
    throw new InternalError(
      "NOT_CONFIGURED",
      { runId: job.runId, externalJobId: work.externalJobId },
      "a managed dispatch for a tracked run needs a reservation hook — nothing would record where this work is placed, so no teardown, recovery or cancellation could name it.",
    );
  const intent = await authority.reserve(work);
  // A hook that answered with nothing is a hook that wrote nothing. Refusing here is what makes the returned
  // value a protocol rather than a courtesy: there is no path from "reservation unproven" to "job created".
  if (!intent || typeof intent.attemptId !== "string" || intent.attemptId === "")
    throw new InternalError(
      "NOT_CONFIGURED",
      { runId: job.runId, externalJobId: work.externalJobId },
      "the reservation hook returned no persisted intent — the placement was never recorded, so this dispatch would create work nothing can address.",
    );
  return intent;
}

// ── AND THE SAME PROOF, RE-PRESENTED AT THE SEAM (arch-review 57 P0) ─────────────────────────────────
//
// Called by every managed lane immediately before it creates the external object. `requireReservation` says
// the placement was recorded; this says the recording is STILL good — the attempt has not been revoked, the
// work is the one it reserved, and the run may still author external work.
//
// A lane with no hook wired keeps the old behaviour rather than failing: the CLI and the in-process paths
// have no attempt ledger to transition, and refusing them would break dispatch for deployments that have no
// cancellation racing anything. Where the ledger IS wired, a refusal aborts the dispatch before the birth.
export async function requireActivation(
  job: CaseJob,
  work: RuntimeWorkRef,
  authority?: ManagedDispatchAuthority,
): Promise<void> {
  if (!authority) return;
  const decision = await authority.activate(work);
  if (decision.kind === "refuse")
    throw new ConflictError(
      "CONFLICT",
      { runId: job.runId, externalJobId: work.externalJobId },
      `this dispatch may no longer create external work: ${decision.reason}`,
    );
}

export function isPoolReporting(backend: Backend): backend is Backend & PoolReporting {
  return typeof (backend as Partial<PoolReporting>).poolStats === "function";
}

export function isCaseCapacityAware(backend: Backend): backend is Backend & CaseCapacityAware {
  return typeof (backend as Partial<CaseCapacityAware>).capacityFor === "function";
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
