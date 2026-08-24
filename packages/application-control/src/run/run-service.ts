import {
  type ActivationDecision,
  AppError,
  BadRequestError,
  type CaseFsFilePayload,
  type CaseFsTreePayload,
  type CaseJob,
  type CaseRecording,
  type CaseResult,
  ConflictError,
  type DomainFact,
  type EvalCase,
  type ExecutionAttemptRecord,
  type ExecutionAttemptState,
  type HarnessSpec,
  InternalError,
  type JudgeRunConfig,
  type KillOutcome,
  NotFoundError,
  type PersistedWorkIntent,
  type ReadResult,
  type RegistryAuth,
  type RunOrigin,
  type RunRecord,
  type RuntimeWorkRef,
  type TraceEvent,
  type TraceSource,
  type TraceSourceConfig,
  type TraceSpan,
  UpstreamError,
  type WorkPresence,
  attemptIdOf,
  isPulledCommandTrace,
  isTerminalAttemptState,
  killConverged,
  readOk,
  readOrUnknown,
  recordExecutionId,
  runExecutionId,
  worstKillOutcome,
} from "@everdict/contracts";
// Type-only wire reuse (same package's DTO subpath): the placement/topology read models the backends produce.
import type { ExecutionId } from "@everdict/contracts";
import type { CasePlacement, TopologyStatus } from "@everdict/contracts/wire";
import {
  type BudgetTracker,
  type HarnessSecretMaps,
  type PolicyResolution,
  Run,
  type RunTransition,
  type UsageMeter,
  attachChannelsFor,
  billingCharges,
  canReadRun,
  caseVerdict,
  fsFileCommand,
  fsTreeCommand,
  parseFsFile,
  parseFsTree,
  priceUsd,
  resolveHarnessSecrets,
  runAudience,
  runEvidenceIdentity,
  usageFromTrace,
  validRepoPath,
} from "@everdict/domain";
import { admitCausedWork } from "../admission/admission.js";
import { type CancellationTeardownResult, runDurableTeardown } from "../cancellation/cancellation-coordinator.js";
import { type AgentHalfStore, discardIntermediates, stagedHalfDigestOf } from "../execution/agent-half.js";
import { type ExecuteCaseDeps, executeCase } from "../execution/execute-case.js";
import { openPhysicalAttempt } from "../execution/open-physical-attempt.js";
import type { DriverAuthority } from "../ops/startup-recovery.js";
import { type StampedFact, stampFacts } from "../platform-event/outbox.js";
import { type ArtifactStore, offloadSnapshot, refreshSnapshotRefs } from "../ports/artifact-store.js";
import type { CancellationCertificate, CancellationStore, CancellationTarget } from "../ports/cancellation-store.js";
import type { CaseReceiptStore } from "../ports/case-receipt-store.js";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { EnvelopeStore } from "../ports/envelope-store.js";
import type { ExecStreamHandle } from "../ports/exec-stream.js";
import type { ExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import { type RecordingStore, recordingGenerationOf } from "../ports/recording-store.js";
import type { AttemptStamp, RunStore } from "../ports/run-store.js";
import { settleRun } from "../ports/settle.js";
import {
  type TrajectorySegmentWire,
  type TrajectoryStore,
  sealExecutionPlanes,
  trajectorySegmentsWire,
} from "../ports/trajectory-store.js";
import { dispatchManifest, foldEnvDeltas } from "../recording-manifest.js";
import { assertRuntimeTarget } from "../require-runtime/require-runtime.js";
import { failedCaseResult } from "../run-suite.js";

// The run workbench's live repo reads (fsTree/fsFile). The shapes are the contracts' (both lanes serve them);
// these aliases keep the service's public names stable for the transports. The git commands + parsers live in
// @everdict/domain (workbench-fs) — ONE implementation shared with the self-hosted runner's in-case servicing.
export type RunFsTree = CaseFsTreePayload;
export type RunFsFile = CaseFsFilePayload;
export type RunFsEntry = CaseFsTreePayload["files"][number];
export type RunFsStatus = NonNullable<RunFsEntry["status"]>;

// Where a running case's platform trace is accumulating (derived on read; docs/architecture/live-observability.md).
export interface LiveTraceRef {
  kind: string; // otel | mlflow | langfuse | langsmith | phoenix
  endpoint: string; // the platform endpoint from the harness spec (UI entry point, best-effort)
  runId: string; // correlation value (everdict.run_id tag / trace search key)
}

export interface SubmitInput {
  tenant: string;
  // submitter (principal.subject) — the owner used to resolve a personally-owned connection for a private-repo seed ("clone with my connection").
  // HTTP/MCP routes always carry principal.subject; if unset, resolveRepoToken falls back to tenant (test compatibility).
  submittedBy?: string;
  // The team that owns this run — the same axis assets carry (the route decides and passes it).
  teamId?: string;
  harness: { id: string; version: string };
  case: EvalCase;
  runtime?: string; // the tenant Runtime id to run on (placement.target). If absent, the default backend (same symmetry as scorecard).
  // this run's origin (activity-view source axis): web|mcp|api|… if unset, unset (direct API). Scorecard children are shown as "scorecard" by the service.
  trigger?: string;
  // Causation edge (P3): the agent run whose action submitted this — origin becomes {cause:"run", causedByRunId}.
  causedByRunId?: string;
  // Inline harness spec for a service-internal synthetic harness that has no registry entry (the code-judge dry-run
  // wrapper). When set, dispatch embeds it verbatim instead of resolving the registry. Never exposed on the HTTP DTO.
  // Boot recovery re-dispatches from the registry only, so an interrupted run of an inline spec fails visibly.
  harnessSpec?: HarnessSpec;
  webhookUrl?: string;
  meterUsage?: boolean; // metering override for this request only (if unset, the workspace policy)
  judge?: JudgeRunConfig; // judge-model override for this request only (if unset, the workspace default)
}

export interface RunServiceDeps {
  dispatcher: Dispatcher; // Scheduler (recommended) or Router — placement/fairness/autoscaling live there
  store: RunStore;
  // Durable replay recording (optional) — at finalize, seal the frames/logs teed during the run and attach the ref.
  recordingStore?: RecordingStore;
  // The PHYSICAL execution ledger (arch-review 42, Phase 1) — one unconditional row per physical execution of
  // this run, including the re-drive that the recording buffer alone could never distinguish. Dual-write and
  // observed-only: nothing reads it to decide anything yet.
  attempts?: ExecutionAttemptStore;
  // Where a two-phase case's intermediates live, so THIS settlement can end their window (arch-review 64
  // P1-high). Absent = this deployment stages nothing, which is the deployment that also cannot recover a
  // crash between the halves.
  agentHalves?: AgentHalfStore;
  verdicts?: AgentHalfStore;
  // Grader factory (@everdict/graders) injected into executeCase's collection-mode scoring — the application layer
  // never imports the grader impls, so apps/api supplies makeGraders here (re-architecture P2 S3). Optional: a mock
  // dispatcher (unit tests) never reaches the collection path, so it may be omitted there; main.ts always supplies it.
  makeGraders?: ExecuteCaseDeps["makeGraders"];
  // Source factory for out-of-job trace collection (collect="control-plane") — used by executeCase to complete a traceRef result.
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  // Auth for the collection pull (re-resolving the traceRef.authSecret name) — the workspace SecretStore's decrypted value. Same as scorecard.
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  // Policy gate: if true, submitting a run with no runtime/self target is 400 (no silent local fallback). The API (main.ts) is always true.
  // Unset (test: a mock dispatcher injected directly) = no gate. Not an env toggle — a fixed deployment policy.
  requireRuntime?: boolean;
  // Submit-time placement preflight — reject a run whose chosen runtime can't run the harness (e.g. a Windows-service
  // topology on a Linux-only cluster) at SUBMIT (400), before any case is dispatched. Wired by apps/api from the
  // harness + runtime registries (runtimeSatisfies vs requiredCapabilitiesForHarness); absent in unit tests (mock
  // dispatcher). Throws a BadRequestError when the runtime can't satisfy the harness. self:* targets are skipped
  // (the runner lease gate handles those). The RuntimeDispatcher still gates per-case at dispatch as the backstop.
  preflightPlacement?: (input: {
    tenant: string;
    target: string;
    harness: { id: string; version: string };
  }) => Promise<void>;
  budget?: BudgetTracker; // the API owns the admission gate (402 when exceeded) and cost settle
  // Envelope spend ledger (§5.2, P4): caused runs draw from their causer's delegated envelope — the gate
  // reads headroom here, the settle meters real cost. Absent = envelopes unenforced (dev wiring).
  envelopes?: EnvelopeStore;
  admissionMaxInFlight?: number; // O7 in-flight cap override (EVERDICT_ENVELOPE_MAX_INFLIGHT)
  // Cascade cancel (§5.5, O8) — wired by the composition to ScorecardService.cancelCausedBy (late-bound:
  // the scorecard service is built after the run service). Fired when an agent run settles cancelled.
  //
  // PART OF THE TEARDOWN, not a side effect of it (arch-review 52, Wave 3). It used to be
  // `void this.deps.onAgentRunCancelled?.(…)?.catch?.(() => {})` — fire-and-forget over a void catch — so a
  // crash between the parent's terminal write and the descendants' cancel orphaned the whole causal subtree
  // with nothing recording that it was owed. It is awaited inside `stopRun` now, which puts it under the
  // same operation row the reconciler sweeps; `cancelCausedBy` reports its own per-batch failures so a
  // subtree that could not be revoked keeps the parent's cancellation owed.
  onAgentRunCancelled?: (tenant: string, runId: string) => Promise<{ cancelled: number; failures: string[] }>;
  // The cancel TEARDOWN's durable owner — the same ledger the batch lane uses, keyed on this run
  // (`target.kind === "run"`). Absent = today's behavior exactly: the teardown runs, a failure throws, and
  // the caller's retry is the only thing that converges it.
  cancellations?: CancellationStore;
  // ── THE STANDALONE CANCEL'S TEARDOWN ARMS (see `cancel`) ──────────────────────────────────────────
  // The same three the batch lane tears down with, at run scale and keyed on the run's OWN job identity
  // (`CaseJob.runId` = `evd-run-<id>`) rather than a batchId. All optional: a deployment without them can
  // still DECIDE a cancel (the terminal commit is the decision) — it just cannot force-free the compute,
  // which is exactly what the unit tests run as.
  // Force-stop the EXACT external work this run placed (arch-review 52, Wave 2) — the handle the backend
  // reported at dispatch and the attempt ledger persisted. The only managed stop there is wherever a handle
  // exists, because "every job of this case" is also every OTHER run's job of that case.
  //
  // It ANSWERS rather than resolving (arch-review 52, Wave 3): `stopped`/`absent` are convergence,
  // `unknown`/`failed` mean the compute is probably still burning and this cancellation is still owed.
  killWork?: (tenant: string, runtime: string | undefined, work: RuntimeWorkRef) => Promise<KillOutcome>;
  // Force-kill an already-dispatched managed backend job (the run is `running`). ⚠️ CASE-ID ADDRESSED —
  // the fallback for a run whose attempts recorded no handle (legacy rows, a lane that mints none, a stamp
  // that lost the race with a crash). See `stopRun`.
  // What a teardown answers when the attempt ledger recorded NO handle (arch-review 53, legacy removal).
  // The case-id kill it replaces reached every run's job of the case — an over-broad stop is not a safer
  // answer than no answer, it is a wrong action taken confidently. A self-hosted lane answers `absent` (its
  // teardown is the lease revocation, which ran); a managed lane answers `unknown`, and the cancellation
  // stays owed for the reconciler.
  killUnhandled?: (tenant: string, runtime: string | undefined) => Promise<KillOutcome>;
  // ── THE POSTCONDITION READ (arch-review 53, Wave E) ────────────────────────────────────────────
  //
  // A stop that answered `stopped` means the orchestrator ACCEPTED a delete — a K8s Job in `Terminating`
  // answers that while its container runs to its grace period, and a Nomad deregister is asynchronous by
  // design. So "the commands converged" is not "the compute is freed", and completing a cancellation on the
  // former is the one claim this protocol exists to make honestly. This asks the cluster whether the object
  // the handle names is actually gone.
  //
  // `unknown` is a first-class answer: a cluster that cannot be asked leaves the postcondition unestablished,
  // and the operation stays owed rather than completing on an optimistic reading. Absent dep = this
  // deployment takes no readback, and the certificate says so by carrying no count.
  // The postcondition read (arch-review 53, Wave E) — now the SHARED `WorkPresence` (arch-review 56, Wave G).
  // It was its own `"absent" | "live" | "unknown"` string union here and a different one in the scorecard
  // lane, which is two spellings of one question; the shared one also carries WHY an unknown is unknown.
  probeWork?: (tenant: string, runtime: string | undefined, work: RuntimeWorkRef) => Promise<WorkPresence>;
  // Drop a still-queued scheduler entry — it would otherwise dispatch only to be discarded.
  cancelQueued?: (predicate: (job: CaseJob) => boolean) => number;
  // Revoke a self-hosted lease: the runner aborts the in-flight case on its next heartbeat. AWAITED by the
  // teardown (a store-backed hub's revocation is a durable write), so its failure is the cancel's failure.
  cancelLeased?: (predicate: (job: CaseJob) => boolean) => number | Promise<number>;
  // The OWNED trajectory store (P5 rung 1) — dual-write: the run row keeps its embed for now, and the
  // trajectory ALSO seals here (first write wins). Reads that want the owned copy go through this store.
  trajectories?: TrajectoryStore;
  // THE RECEIPT IS WHAT SAYS WHICH EVIDENCE IS CANONICAL (arch-review 52, Wave 7). The trajectory store is
  // append-oriented — on the ClickHouse rung two replicas can both seal a plane, and the clock that decides
  // between them is the writer's, so a slow attempt with an older timestamp can out-rank the attempt that
  // actually answered the case. The ledger already knows which attempt committed; this is what lets the read
  // ASK for it. Absent (a standalone run, an install with no receipts) ⇒ the clock read, unchanged.
  caseReceipts?: CaseReceiptStore;
  // Parent-scorecard verdict-policy resolution for CHILD runs (parentScorecardId set): a child's served
  // verdict must be derived under the policy that judged its BATCH — the stamped/composed document — not
  // today's default ladder, or the run detail and the scorecard case dialog disagree about the same
  // evidence one click apart. Wired by the composition over the scorecard STORE (cross-resource data goes
  // through the owning store, never a peer service). Absent, scorecard missing, or unresolvable ⇒ the child
  // serves NO verdict (fail-closed: a verdict is a claim about which rules decided, and without the
  // document that claim cannot be made).
  scorecardPolicy?: (tenant: string, scorecardId: string) => Promise<PolicyResolution | undefined>;
  usage?: UsageMeter; // meter-only billing usage — itemized per (source × model), attributed via billingCharges
  // Resolve a declarative harness spec from the registry and embed it in the job (if absent, built-in id branching). An unknown harness is rejected → undefined fallback.
  resolveHarness?: (tenant: string, id: string, version: string) => Promise<HarnessSpec | undefined>;
  // For resolving {secretRef} in harness env — two tiers: shared (workspace) + the submitter's personal secrets. Picked by scope and injected. Same as scorecard.
  scopedSecretsFor?: (tenant: string, subject?: string) => Promise<HarnessSecretMaps>;
  // Per-workspace metering policy (default off). A per-request override (SubmitInput.meterUsage) takes precedence over this.
  // async allowed — a DB-backed workspace settings store can be plugged in directly.
  meterUsageFor?: (tenant: string) => boolean | Promise<boolean>;
  // The workspace default judge model (for inline judge-grader scoring). A per-request override (SubmitInput.judge) takes precedence.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
  // Token resolution for a private-repo seed — evalCase.env.source.connectionId → an external account (Connected accounts) token.
  // The connection is personally owned, so resolve by owner (= submitter subject) ("clone with my connection"). If unset/unresolved, public clone.
  // The token is carried transiently on the job (CaseJob.repoToken) only and never stored on the record/case.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // Workspace-owned GitHub App token (preferred) — if the case git URL owner matches a workspace installation, issued via that App.
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // Workspace image-registry pull credentials — if the job image is from that registry, attach as job.registryAuth (executeCase).
  registryAuthsFor?: (workspace: string, images: string[]) => Promise<RegistryAuth[]>;
  // Live-progress log read (observability ②): resolve the run's runtime lane to a live backend and read the
  // case job's current stdout (Backend.logs). Best-effort — absent/miss = no logs, never an error.
  // stream: stdout (default, the result stream) | stderr (harness progress logs) — structural twin of the
  // backends LogStream union (this layer can't import from @everdict/backends).
  readCaseLogs?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    stream?: "stdout" | "stderr",
    // The exact object to read, when this run's ledger holds one (arch-review 53, Wave B). Without it the
    // lane resolves "the newest job of this case" — another run's, whenever two runs of one case are live.
    work?: RuntimeWorkRef,
  ) => Promise<string | undefined>;
  // Open an interactive shell stream inside a run's live sandbox (observability ⑥). undefined = no live container.
  openTerminalStream?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
  ) => Promise<ExecStreamHandle | undefined>;
  // Capture a live browser frame (observability ⑦) — resolves the run's runtime to a topology backend and
  // captures its per-case browser CDP screen by runId. Returns base64 PNG (no data: prefix). undefined = none.
  captureBrowserScreen?: (
    tenant: string,
    runtimeList: string | undefined,
    runId: string,
  ) => Promise<string | undefined>;
  // Where the run's live browser can be REACHED, for the interactive takeover relay (watching answers "what is
  // the agent doing"; attaching answers "let me get it past this login wall myself").
  screenEndpoint?: (tenant: string, runtimeList: string | undefined, runId: string) => Promise<string | undefined>;
  // Latest live-screen frame PUSHED by a self-hosted runner (report_case_screen), by CP-minted runId. base64 PNG (no
  // data: prefix) or undefined. Takes precedence over the env-kind pull paths: a self-hosted container is unreachable
  // from the control plane, so a self-driven-browser command harness (e.g. browser-use, env.kind "prompt") relies on
  // the runner pushing frames rather than the CP pulling them.
  liveFrame?: (runId: string) => string | undefined;
  // Live execution log PUSHED by a self-hosted runner (report_case_log), by CP-minted runId — the runner's per-case
  // lifecycle lines (started / completed / failed [class/stage]: reason). Takes precedence over readCaseLogs for the
  // default (stdout) view: a self-hosted runner has no backend the control plane can tail, so it pushes instead.
  pushLogs?: (runId: string) => string | undefined;
  // Live trajectory PUSHED to the control plane while the run executes (observability ⑨), by CP-minted runId —
  // the dispatch account's placement marks plus a self-hosted runner's drained-event batches (report_case_trace).
  // Ephemeral (TTL/cap); the sealed trajectory is the durable record.
  liveTraceEvents?: (runId: string) => TraceEvent[] | undefined;
  // The managed twin of liveTraceEvents: decode the EVENT_SENTINEL lines the case job printed to its stdout —
  // resolves the run's runtime lane to a live backend (Backend.caseEvents). Best-effort — absent/miss = no events.
  readCaseEvents?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    work?: RuntimeWorkRef,
  ) => Promise<TraceEvent[] | undefined>;
  // Self-hosted twin of execInSandbox for the run workbench's repo reads: the control plane cannot exec into a
  // runner's sandbox, so these PARK a request the runner's in-case servicing loop (RunContext.caseFs) answers,
  // and await it (undefined = no answer in time — no live sandbox / an old runner without the loop). Keyed by
  // the CP-minted runId, like every report_case_* push.
  runnerCaseFs?: {
    tree(runId: string): Promise<CaseFsTreePayload | undefined>;
    file(runId: string, path: string): Promise<CaseFsFilePayload | undefined>;
  };
  // One-shot exec inside the case's live sandbox (observability ④ web terminal / ⑤ screen capture). Resolves the
  // run's runtime to a live backend and runs `sh -c command`. undefined = no live container.
  execInSandbox?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    command: string,
    work?: RuntimeWorkRef,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  // Case-scoped placement read (runtime debugging): where the case's orchestrator job stands INSIDE the cluster —
  // queued/blocked (capacity verdict)/starting/running/dead, node, and the orchestrator event feed. Resolves the
  // run's runtime lane to a CaseInspectable backend. Best-effort — absent/miss = no placement info, never an error.
  inspectCasePlacement?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    work?: RuntimeWorkRef,
  ) => Promise<CasePlacement | undefined>;
  // Topology health roster (runtime debugging, service harnesses): the warm topology's per-service state behind
  // the run's runtime lane. Best-effort — absent/miss = no topology info, never an error.
  inspectTopology?: (
    tenant: string,
    runtimeList: string | undefined,
    harness: { id: string; version: string },
  ) => Promise<TopologyStatus | undefined>;
  // One deployed topology service's current log tail — the service-level twin of readCaseLogs.
  readTopologyServiceLogs?: (
    tenant: string,
    runtimeList: string | undefined,
    harness: { id: string; version: string },
    service: string,
  ) => Promise<string | undefined>;
  // Completion callback (succeeded/failed) — completion notifications (Mattermost etc.). Failure is independent of the run result (the service swallows it). Separate from webhook.
  onComplete?: (tenant: string, record: RunRecord) => Promise<void>;
  // Platform-event emit seam (agent-automation A1) — run.submitted only; completion facts flow through
  // onComplete → NotificationService, which emits on the same seam. emit never throws (best-effort).
  events?: PlatformEventEmitter;
  // Artifact store (when configured): offload os-use screenshots to object storage → the record keeps only the URL (no inline base64).
  artifacts?: ArtifactStore;
  newId?: () => string;
  now?: () => string;
  fetch?: typeof fetch; // for the webhook (test injection)
}

// Price the model calls of a reported trace before it is sealed. The agent counts tokens (it is the only one
// who can) but must not carry a pricing table — the domain owns exactly one, and the usage meter already
// prices agent tokens with it. So a reported llm_call arrives with usd 0 and gets its price here; anything
// that already carries a cost (a harness that reports its own spend, e.g. Claude's total_cost_usd) is left
// untouched. Without this the sealed evidence would show tokens at zero dollars forever.
function pricedTrace(trace: TraceEvent[]): TraceEvent[] {
  return trace.map((event) => {
    if (event.kind !== "llm_call" || !event.cost || event.cost.usd > 0) return event;
    const { inputTokens, outputTokens } = event.cost;
    return { ...event, cost: { ...event.cost, usd: priceUsd(event.model, { inputTokens, outputTokens }) } };
  });
}

// Manages a run's async lifecycle: accept (202) → delegate to the dispatcher → on completion, update the store + webhook.
// Unit-testable independent of HTTP. AppError is thrown as-is so the caller (server) maps it to a status code.
// WHAT A RESUME ANSWERED. Three outcomes, and only one of them is a licence to tombstone:
//
//   resumed         — this recovery owns the record now and re-drove it.
//   already_settled — somebody else finished it first. The work is DONE; the row carries their outcome, and
//                     the caller's job is to leave it alone.
//   unresumable     — there is nothing to re-drive (a legacy record with no persisted case). This one, and
//                     only this one, the caller settles.
//
// The boolean this replaced could not tell the second from the third, and a caller that guessed wrong wrote
// FAILED{INTERRUPTED} over a successful evaluation (arch-review 31 P0).
export type ResumeResult =
  | { kind: "resumed" }
  | { kind: "already_settled"; record: RunRecord }
  // The record cannot be driven and never will be — a legacy row with no caseSpec, a dataset that no longer
  // resolves. The recovery sweep tombstones it as INTERRUPTED, which is a statement about history.
  | { kind: "unresumable" }
  // ── "WE COULD NOT FIND OUT" IS NOT "IT FAILED" (arch-review 55) ─────────────────────────────────────
  //
  // The fourth case, and the one whose absence turned a transient outage into a permanent verdict. An
  // attempt-ledger read that failed, a cluster that would not answer whether a job is still live: nothing
  // about the record has been established, so nothing terminal may be written for it. The sweep leaves it
  // and comes back.
  //
  // It exists because `unresumable` was doing both jobs. The recovery boundary spoke `boolean`, every
  // failure funnelled through `.catch(() => false)`, and `false` meant tombstone — so an unreadable ledger
  // was recorded as `failed{INTERRUPTED}` on a batch whose managed jobs were still running. A caller that
  // cannot tell "this will never work" from "ask again shortly" will always answer with the more damaging
  // one, because that is the branch the boolean already had.
  | { kind: "retry_later"; reason: string };

const UNRESUMABLE: ResumeResult = { kind: "unresumable" };

// The record as a reader may see it: everything the run is, minus where to call back. See the note in
// `RunService` for why this is a read-boundary rule rather than a per-transport one.
function withoutCallback<T extends { webhookUrl?: string }>(record: T): T {
  if (record.webhookUrl === undefined) return record;
  const { webhookUrl: _dropped, ...rest } = record;
  return rest as T;
}

export class RunService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: RunServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.fetchImpl = deps.fetch ?? fetch;
  }

  // Synchronous admission (throws → 402 if over budget). On pass, create the record then dispatch asynchronously (no await).
  async submit(input: SubmitInput): Promise<RunRecord> {
    // Deployment policy: the execution location (registered runtime or self:<runner>) must be specified — if absent, 400 (block silent local fallback).
    const target = input.runtime ?? input.case.placement?.target;
    assertRuntimeTarget(this.deps.requireRuntime, target);
    // Placement capability preflight: reject at submit (400) if the chosen runtime can't run this harness (before any dispatch).
    if (target) await this.deps.preflightPlacement?.({ tenant: input.tenant, target, harness: input.harness });
    // P4 causal leg FIRST (§5.1 order): caused work draws from its causer's envelope (402 past the cap,
    // 429 past the depth guard) and is stamped with it; only then the tenant-level budget gate.
    // The record id is minted BEFORE the gate and doubles as the admission's request identity (H6) — a
    // re-admission of this same creation is the same right, never a second charge.
    const runId = this.newId();
    const causedEnvelope = input.causedByRunId
      ? await admitCausedWork(
          {
            runStore: this.deps.store,
            ...(this.deps.envelopes ? { envelopes: this.deps.envelopes } : {}),
            ...(this.deps.events ? { events: this.deps.events } : {}),
            ...(this.deps.admissionMaxInFlight !== undefined ? { maxInFlight: this.deps.admissionMaxInFlight } : {}),
          },
          input.tenant,
          input.causedByRunId,
          1,
          { requestId: `adm:run:${runId}` },
        )
      : undefined;
    this.deps.budget?.admit(input.tenant); // PaymentRequiredError (402) when exceeded — no run created
    // When a runtime is chosen, inject it as the case's placement.target → RuntimeDispatcher routes to the tenant runtime (same symmetry as scorecard).
    const effective: SubmitInput = input.runtime
      ? { ...input, case: { ...input.case, placement: { ...input.case.placement, target: input.runtime } } }
      : input;
    // The placed runtime (work-queue axis) — an explicit runtime or the case's own placement.target. If absent, the default backend (unset).
    const placedRuntime = input.runtime ?? input.case.placement?.target;
    // Record assembly is the domain's job (Run.newQueued) — the service only orchestrates. The persisted
    // (placement-injected) case body is boot recovery's re-dispatch basis (mig 0051).
    const record: RunRecord = Run.newQueued({
      id: runId,
      tenant: effective.tenant,
      harness: effective.harness,
      evalCase: effective.case,
      ...(placedRuntime ? { runtime: placedRuntime } : {}),
      ...(effective.trigger ? { trigger: effective.trigger } : {}),
      // Recorded, not remembered: the callback outlives this process and this driver (mig 0171).
      ...(effective.webhookUrl ? { webhookUrl: effective.webhookUrl } : {}),
      ...(effective.submittedBy ? { submittedBy: effective.submittedBy } : {}),
      ...(effective.teamId ? { teamId: effective.teamId } : {}),
      origin: standaloneRunOrigin(effective.trigger, effective.submittedBy, effective.causedByRunId),
      // Caused work is background by default (§5.4 — autonomous fan-out never starves a human's click).
      ...(effective.causedByRunId ? { class: "background" as const } : {}),
      ...(causedEnvelope ? { envelope: causedEnvelope } : {}),
      now: this.now(),
    });
    // E0 outbox: the creation fact (domain-computed — children stay silent) persists in the SAME transaction
    // as the record; the push afterwards is a latency nudge carrying the same id (consumer dedup holds).
    const creation = this.stampFacts(record.tenant, Run.creationFacts(record));
    await this.deps.store.create(
      record,
      creation.map((c) => c.record),
    );
    if (creation.length > 0) void this.deps.events?.pushPersisted?.(creation);
    void this.track(record.id, effective, record.envelope?.id, record.ownerEpoch ?? 0); // fire-and-track
    return record;
  }

  async get(id: string): Promise<(RunRecord & { liveTrace?: LiveTraceRef }) | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    return this.withLiveTrace(
      withAttachChannels(await this.withTrajectoryUsage(await this.withVerdict(withoutCallback(record)))),
    );
  }

  // The read whose answer ends up on a SCREEN (the detail route + its MCP twin — keep the two in step). Identical to
  // get(), except the snapshot's artifact refs are re-minted for the viewer's browser: the persisted ones are
  // server-side handles (in-network host, hour-old signature). Our own callers keep using get() so their fetches stay
  // in-cluster.
  //
  // `viewer` is the member asking. A run another member's agent turn or shell produced reads as undefined — the same
  // answer as a foreign workspace's run, so a transport maps both to 404 and neither leaks that the row exists
  // (`runAudience`, @everdict/domain). Serving a PERSON goes through here; our own reads keep get().
  async getForDisplay(id: string, viewer: string): Promise<(RunRecord & { liveTrace?: LiveTraceRef }) | undefined> {
    const record = await this.get(id);
    if (record && !canReadRun(record, viewer)) return undefined;
    if (!record?.result?.snapshot) return record;
    const snapshot = await refreshSnapshotRefs(record.result.snapshot, this.deps.artifacts);
    return snapshot === record.result.snapshot ? record : { ...record, result: { ...record.result, snapshot } };
  }

  // The served RunRecord.verdict — derived HERE, in the application query layer, never in the DB adapter:
  // the store cannot know which policy judged a record (a persistence concern must not interpret evidence).
  // A standalone run has no stamp by construction, so the live default ladder is its policy; a scorecard
  // CHILD is judged under its PARENT's stamped/composed policy (deps.scorecardPolicy), so the run detail and
  // the scorecard case dialog answer identically about the same evidence. No resolution / unresolvable ⇒ no
  // verdict (fail-closed — never a silent re-judgement under today's ladder).
  private async withVerdict(record: RunRecord): Promise<RunRecord> {
    const [attached] = await this.withVerdicts([record]);
    return attached ?? record;
  }

  private async withVerdicts(records: RunRecord[]): Promise<RunRecord[]> {
    const resolutions = new Map<string, PolicyResolution | undefined>(); // one parent lookup per batch
    const out: RunRecord[] = [];
    for (const r of records) {
      if (!r.result) {
        out.push(r);
        continue;
      }
      const parent = r.parentScorecardId;
      if (parent === undefined || parent === null) {
        const verdict = caseVerdict(r.result); // no stamp exists for a standalone run — the live ladder IS its policy
        out.push(verdict !== undefined ? { ...r, verdict } : r);
        continue;
      }
      const key = `${r.tenant}:${parent}`;
      if (!resolutions.has(key)) {
        resolutions.set(key, await this.deps.scorecardPolicy?.(r.tenant, parent));
      }
      const resolution = resolutions.get(key);
      if (resolution === undefined || resolution.status === "unresolvable") {
        out.push(r); // fail-closed: the batch's rules are not in hand, so no verdict is claimed
        continue;
      }
      const verdict = caseVerdict(r.result, resolution.policy);
      out.push(verdict !== undefined ? { ...r, verdict } : r);
    }
    return out;
  }

  // A run recorded before executions declared their channels: derive them from the same rule the domain
  // stamps new ones with, so every reader sees a declaration and no surface keeps a heuristic of its own.
  // Derived on read (the ProjectRollup treatment) rather than backfilled — the rule can change without a
  // migration, and a stored copy would be a cache to invalidate.

  // Usage for the runs whose evidence is NOT a row embed. The store derives usage from `result.trace`, which
  // an eval run has and an agent turn never does (its transcript is sealed in the trajectory store, per O10 —
  // new runs write refs, not embeds). The result was that the executions which actually spend money reported
  // no cost on their own detail, while the invoice knew. So when a record has no result, fall back to the
  // sealed trajectory — the same derivation over the same events, one extra read on the DETAIL path only
  // (the list keeps its single query; a per-row trajectory read would be N+1).
  private async withTrajectoryUsage(record: RunRecord): Promise<RunRecord> {
    if (record.result || record.usage || !this.deps.trajectories) return record;
    const sealed = await this.deps.trajectories.get(record.tenant, record.id).catch(() => undefined);
    if (!sealed || sealed.events.length === 0) return record;
    const usage = usageFromTrace(sealed.events);
    return usage.calls > 0 ? { ...record, usage } : record;
  }

  // Live trace deep-link (observability ③, derived — never stored): while the run is still active AND its
  // harness exports a platform trace, surface where that trace is accumulating. The correlation id is the
  // control-plane-minted job runId, derivable from the record alone (evd-run-<id> / evd-<batch>-<caseId>), so
  // observers can open the tenant's own observability UI mid-run with zero coordination.
  private async withLiveTrace(record: RunRecord): Promise<RunRecord & { liveTrace?: LiveTraceRef }> {
    if (record.status !== "queued" && record.status !== "running") return record;
    if (!this.deps.resolveHarness) return record;
    const spec = await this.deps
      .resolveHarness(record.tenant, record.harness.id, record.harness.version)
      .catch(() => undefined);
    const source =
      spec?.kind === "command" && isPulledCommandTrace(spec.trace)
        ? { kind: spec.trace.kind, endpoint: spec.trace.endpoint }
        : spec?.kind === "service"
          ? { kind: spec.traceSource.kind, endpoint: spec.traceSource.endpoint }
          : undefined;
    if (!source) return record;
    const runId = record.parentScorecardId
      ? `evd-${record.parentScorecardId}-${record.caseId}`
      : `evd-run-${record.id}`;
    return { ...record, liveTrace: { ...source, runId } };
  }

  // One-shot exec inside a run's live sandbox (observability ④). Returns the record (for authz/scoping) + the
  // command result, or undefined when the record doesn't exist. result=undefined = no live container to exec into.
  async exec(
    id: string,
    command: string,
  ): Promise<
    { record: RunRecord; result: { stdout: string; stderr: string; exitCode: number } | undefined } | undefined
  > {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const result = this.deps.execInSandbox
      ? await this.deps
          .execInSandbox(
            record.tenant,
            record.runtime,
            record.caseId,
            command,
            await this.displayWork(RunService.runIdFor(record)),
          )
          .catch(() => undefined)
      : undefined;
    return { record, result };
  }

  // Repo file tree of a run's live sandbox (run workbench — "the VS Code view" of a coding case). Managed lane:
  // rides the same one-shot exec channel the web terminal uses. Self-hosted lane (`self:*`): the control plane
  // cannot exec into a runner's sandbox, so the read PARKS a request the runner's in-case servicing loop answers
  // (same commands, run from inside — @everdict/domain workbench-fs). tree=undefined = no live container / no
  // git worktree / the runner did not answer — the workbench then renders nothing rather than a wrong filesystem.
  async fsTree(id: string): Promise<{ record: RunRecord; tree: RunFsTree | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    if (record.runtime?.startsWith("self:")) {
      const tree = this.deps.runnerCaseFs
        ? await this.deps.runnerCaseFs.tree(RunService.runIdFor(record)).catch(() => undefined)
        : undefined;
      return { record, tree };
    }
    if (!this.deps.execInSandbox) return { record, tree: undefined };
    const out = await this.deps
      .execInSandbox(record.tenant, record.runtime, record.caseId, fsTreeCommand())
      .catch(() => undefined);
    if (!out || out.exitCode !== 0) return { record, tree: undefined };
    return { record, tree: parseFsTree(out.stdout) };
  }

  // One file of the run's live repo (run workbench). Content travels base64 so binary/UTF-8 survives the exec
  // stdout transport; the working-tree diff vs HEAD rides along for changed files. Reads are capped (a workbench
  // shows a file, it does not download one) and a binary file reports itself instead of shipping garbage.
  // file=undefined = no live container / not a git worktree / no such file. Self-hosted lane parks the request
  // for the runner's in-case servicing, like fsTree.
  async fsFile(id: string, path: string): Promise<{ record: RunRecord; file: RunFsFile | undefined } | undefined> {
    // Repo-RELATIVE paths only — traversal, absolute paths and control characters are a client bug, refused
    // before any shell sees them. Lives HERE so both transports (HTTP route + MCP tool) inherit one rule.
    if (!validRepoPath(path))
      throw new BadRequestError("BAD_REQUEST", undefined, "path must be a repo-relative file path.");
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    if (record.runtime?.startsWith("self:")) {
      const file = this.deps.runnerCaseFs
        ? await this.deps.runnerCaseFs.file(RunService.runIdFor(record), path).catch(() => undefined)
        : undefined;
      return { record, file };
    }
    if (!this.deps.execInSandbox) return { record, file: undefined };
    const out = await this.deps
      .execInSandbox(record.tenant, record.runtime, record.caseId, fsFileCommand(path))
      .catch(() => undefined);
    if (!out || out.exitCode !== 0) return { record, file: undefined };
    return { record, file: parseFsFile(path, out.stdout) };
  }

  // Live screen frame (observability ⑤) — the case's current screen as a PNG data URL, from whichever source can
  // actually reach it: a frame the runner pushed, the per-case browser over CDP, or a desktop screenshot exec'd in
  // the sandbox. `supported` reports what we COULD capture, never what the case's declared env kind suggests we
  // ought to be able to — a lane that can't reach the screen must read as unsupported (the viewer then shows
  // nothing) instead of parking the operator in front of a permanently empty frame.
  async screen(
    id: string,
  ): Promise<{ record: RunRecord; dataUrl: string | undefined; supported: boolean } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const runId = RunService.runIdFor(record);
    // Pushed frame (self-hosted runner) wins — the control plane can't reach a self-hosted container to pull one. This
    // is how a browser-use command harness (env.kind "prompt", self-driven Chromium) surfaces its live screen.
    const pushed = this.deps.liveFrame?.(runId);
    if (pushed) return { record, dataUrl: `data:image/png;base64,${pushed}`, supported: true };
    // Per-case browser over CDP. Deliberately NOT gated on the case's env kind: a service harness drives a real
    // browser while its case env is `prompt` (the browser belongs to the topology, not to the case), and a case
    // declaring `browser` may run on a lane with no rediscovery at all. The capture attempt is the only honest test.
    if (record.runtime && this.deps.captureBrowserScreen) {
      const b64 = await this.deps.captureBrowserScreen(record.tenant, record.runtime, runId).catch(() => undefined);
      if (b64) return { record, dataUrl: `data:image/png;base64,${b64}`, supported: true };
    }
    const env = record.caseSpec?.env;
    // os-use (desktop) — scrot on the case's DISPLAY via an in-sandbox exec. The display only exists for this env kind.
    if (env?.kind !== "os-use" || !this.deps.execInSandbox) return { record, dataUrl: undefined, supported: false };
    const display = env.display ?? ":99";
    const shot = "/tmp/.everdict-live.png";
    // Capture then base64 in one shell so nothing is left on disk / no second round-trip. best-effort.
    const command = `DISPLAY=${display} scrot -o ${shot} 2>/dev/null && base64 -w0 ${shot}`;
    const out = await this.deps
      .execInSandbox(record.tenant, record.runtime, record.caseId, command)
      .catch(() => undefined);
    const b64 = out && out.exitCode === 0 ? out.stdout.trim() : "";
    return { record, dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined, supported: Boolean(b64) };
  }

  // Where this run's live browser can be driven from (observability ⑦b). Returns the record (for authz/scoping)
  // + the reachable CDP base, or undefined endpoint when there is nothing to take over (settled run, a lane with
  // no per-case browser). The caller mints a WS ticket against it; the relay does the driving.
  async screenEndpoint(id: string): Promise<{ record: RunRecord; endpoint: string | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const endpoint =
      record.runtime && this.deps.screenEndpoint
        ? await this.deps
            .screenEndpoint(record.tenant, record.runtime, RunService.runIdFor(record))
            .catch(() => undefined)
        : undefined;
    return { record, endpoint };
  }

  // Case-scoped placement read (runtime debugging) — the record (for authz/scoping) + where the case's job stands
  // inside its runtime cluster. placement=undefined = nothing to describe (pre-dispatch, GC'd, or no backend support).
  async placement(id: string): Promise<{ record: RunRecord; placement: CasePlacement | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const placement = this.deps.inspectCasePlacement
      ? await this.deps
          .inspectCasePlacement(
            record.tenant,
            record.runtime,
            record.caseId,
            await this.displayWork(RunService.runIdFor(record)),
          )
          .catch(() => undefined)
      : undefined;
    return { record, placement };
  }

  // Topology health roster (runtime debugging) — the record (for authz/scoping) + the per-service state of the
  // warm topology the run's service harness drives. topology=undefined = not a service harness / no topology
  // runtime behind the lane / the read degraded.
  async topology(id: string): Promise<{ record: RunRecord; topology: TopologyStatus | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const topology = this.deps.inspectTopology
      ? await this.deps.inspectTopology(record.tenant, record.runtime, record.harness).catch(() => undefined)
      : undefined;
    return { record, topology };
  }

  // One deployed topology service's current log tail (runtime debugging) — the record + the service's log text.
  async topologyServiceLogs(
    id: string,
    service: string,
  ): Promise<{ record: RunRecord; text: string | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const text = this.deps.readTopologyServiceLogs
      ? await this.deps
          .readTopologyServiceLogs(record.tenant, record.runtime, record.harness, service)
          .catch(() => undefined)
      : undefined;
    return { record, text };
  }

  // Open an interactive terminal on a run's live sandbox (observability ⑥). Returns the record (for authz) + a
  // stream handle, or undefined when the record doesn't exist. stream=undefined = no live container to attach to.
  async openTerminal(id: string): Promise<{ record: RunRecord; stream: ExecStreamHandle | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const stream = this.deps.openTerminalStream
      ? await this.deps.openTerminalStream(record.tenant, record.runtime, record.caseId).catch(() => undefined)
      : undefined;
    return { record, stream };
  }

  // Live-progress logs (observability ②) — the record plus the case job's current raw output. text=undefined
  // when there is no job to read (queued, GC'd, or the backend can't tail); the record still scopes/authorizes.
  // stream=stderr tails the job's stderr — harnesses often log progress there while stdout carries only the result.
  async logs(
    id: string,
    stream?: "stdout" | "stderr",
  ): Promise<{ record: RunRecord; text: string | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    // Pushed runner log (self-hosted) wins for the default (stdout) view — a self-hosted runner has no backend the
    // control plane can tail, so it pushes its per-case lifecycle log instead. Same runId derivation as screen().
    const pushed = this.deps.pushLogs?.(RunService.runIdFor(record));
    if (stream !== "stderr" && pushed) return { record, text: pushed };
    const text = this.deps.readCaseLogs
      ? await this.deps
          .readCaseLogs(
            record.tenant,
            record.runtime,
            record.caseId,
            stream,
            await this.displayWork(RunService.runIdFor(record)),
          )
          .catch(() => undefined)
      : undefined;
    // A lane with no orchestrator job carries ONE stream, so the stderr view falls back to that same pushed log —
    // otherwise switching streams on a self-hosted run reads as "this run wrote nothing to stderr", which is a
    // statement about the run rather than the truth, which is that this lane has no second stream to offer.
    return { record, text: text ?? pushed };
  }

  // Live trajectory (observability ⑨) — the run's own TraceEvents accumulating BEFORE anything seals: the events
  // the control plane collected live (the dispatch account's placement marks + runner-pushed batches, keyed by the
  // CP-minted runId) plus the events the managed job printed to its stdout as EVENT_SENTINEL lines (pulled from
  // the orchestrator log, snapshot semantics). events=[] when nothing has arrived yet; the record still
  // scopes/authorizes. The sealed trajectory is the durable record — this read is a preview.
  async liveTrace(id: string): Promise<{ record: RunRecord; events: TraceEvent[] } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const pushed = this.deps.liveTraceEvents?.(RunService.runIdFor(record)) ?? [];
    const pulled = this.deps.readCaseEvents
      ? ((await this.deps
          .readCaseEvents(
            record.tenant,
            record.runtime,
            record.caseId,
            await this.displayWork(RunService.runIdFor(record)),
          )
          .catch(() => undefined)) ?? [])
      : [];
    // Disjoint sources (a runner pushes, a managed job prints — never both), so concatenation is the merge; the
    // dispatch marks lead, mirroring the sealed layout (TraceRecordingDispatcher prepends the placement plane).
    return { record, events: [...pushed, ...pulled] };
  }

  // Persisted replay recording (docs/architecture/replay.md) — the sealed screen frames + logs + env/runtime tracks of a
  // settled run, on the shared t0 clock with the trace. Returns the record (for authz) + the recording (undefined = none
  // recorded, e.g. recording disabled or nothing was teed). Keyed by the same runId derivation as screen()/logs().
  async recording(id: string): Promise<{ record: RunRecord; recording: CaseRecording | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    // ── A TERMINAL RUN IS READ THROUGH ITS OWN REF, NEVER OFF THE LOGICAL KEY (review 39 P0-5) ────────
    //
    // The recording buffer is keyed by the run's live-CORRELATION id, which a re-drive deliberately reuses.
    // So a settled run whose own attempt sealed nothing — a fence that could not be raised, an attempt that
    // recorded nothing, a reset that failed — was served the recording sitting under that key: some OTHER
    // attempt's, presented as this result's replay. The result itself says whether it has one, in the ref it
    // carries; a terminal run with no ref has no replay, and answering with the neighbouring attempt's is
    // worse than answering with nothing.
    //
    // While the run is still going there is no result to consult and the live tail IS the answer, so the
    // logical read stays exactly where it was correct.
    const runId = RunService.runIdFor(record);
    const terminal = Run.from(record).isTerminal();
    const recording =
      this.deps.recordingStore === undefined
        ? undefined
        : terminal
          ? // …and now that an attempt is a row (mig 0177), the ref does not merely PROVE this result has a
            // replay — it NAMES which one, so the read follows it instead of taking the newest sealed attempt
            // and hoping the two agree. A ref written before the grammar existed names no generation, and
            // that reads as "the producer did not say": the newest sealed attempt, exactly as before.
            record.result?.recordingRef
            ? await this.deps.recordingStore.get(runId, recordingGenerationOf(record.result.recordingRef.ref))
            : undefined
          : ((await this.deps.recordingStore.get(runId)) ?? (await this.deps.recordingStore.peek(runId)));
    // The player draws every frame straight from its ref, so this read is display-only by nature — re-mint them
    // (same reason as getForDisplay). Frames dedup by ref, so re-sign each distinct one once.
    if (!recording?.tracks.frames?.length || !this.deps.artifacts) return { record, recording };
    const minted = new Map<string, string>();
    const frames = [];
    for (const frame of recording.tracks.frames) {
      if (!minted.has(frame.ref))
        minted.set(frame.ref, (await this.deps.artifacts.publicUrlFor(frame.ref)) ?? frame.ref);
      frames.push({ ...frame, ref: minted.get(frame.ref) ?? frame.ref });
    }
    return { record, recording: { ...recording, tracks: { ...recording.tracks, frames } } };
  }

  // CP-minted correlation id — the same derivation the dispatch stamps on CaseJob.runId (evd-run-<id> for a single
  // run, evd-<batchId>-<caseId> for a scorecard child). Shared by the pushed-frame + pushed-log lookups (both keyed by
  // the runId the runner reports with).
  private static runIdFor(record: RunRecord): ExecutionId {
    // The STAMPED id first (mig 0172). The derivation below is the fallback for rows written before the
    // column, and it is lossy where it matters: a multi-trial case dispatches `…-c1-t0/-t1/-t2` and all three
    // rows derive `…-c1`, so two of them read evidence that belongs to a sibling.
    return recordExecutionId(record);
  }

  // Boot recovery for an interrupted standalone run. adopted = a result harvested from the still-alive backend
  // job (settle it directly — zero re-run); else re-drive from the persisted caseSpec; legacy records without
  // one are `unresumable` and keep the tombstone path. docs/architecture/batch-resilience.md
  //
  // FAILED TO RESUME IS NOT "THE WORK FAILED" (arch-review 31 P0). This used to answer `boolean`, which
  // collapsed two opposite outcomes into one word: "there is nothing here to re-drive" and "somebody else
  // finished it while I was asking". A caller reading `false` as the first meaning tombstones the second —
  // and one did, over a run that had SUCCEEDED, with no CAS to stop it. The distinction is the whole point,
  // so it is in the type: only `unresumable` may be settled by the caller.
  async resume(
    record: RunRecord,
    adopted?: CaseResult,
    authority?: DriverAuthority,
    // WHICH physical attempt produced `adopted`, so this settlement can stamp it as part of its own decision
    // (arch-review 63 P1-high). The recovery holds it on the handle it adopted from; nothing here can derive
    // it, and deriving it would be the re-derivation rule `protocol` L3 forbids.
    adoptedAttemptId?: string,
  ): Promise<ResumeResult> {
    // The epoch this recovery WON, or — for a caller with no claim behind it — the record's own. Every write
    // below proves it, adoption included: `settleRun` has taken an epoch since mig 0170 and this branch was
    // the one caller that never passed one, so a replica that had already been displaced could still decide
    // a run's outcome (arch-review 32 P0). Adoption WAITS for the backend job, which is precisely the pause
    // during which a takeover happens.
    const epoch = authority?.epoch ?? record.ownerEpoch ?? 0;
    // A CAS GUARD PRESENT IS NOT A CAS AUTHORITY CONSUMED (arch-review 28 P1). Both writes below were
    // correctly fenced and both ignored the answer — so a recovery that LOST the race still reported success
    // and, worse, still dispatched. The guard stopped the row from being corrupted and did nothing about the
    // second execution it then paid for. Authority to act downstream comes from the transition that
    // COMMITTED, never from the code path that attempted one.
    const run = Run.from(record);
    const settledElsewhere = async (): Promise<ResumeResult> => ({
      kind: "already_settled",
      record: (await this.deps.store.get(record.id)) ?? record,
    });
    if (adopted) {
      if (!run.canAdopt()) return settledElsewhere(); // already settled — never rewrite a terminal record
      // …with its FACTS (arch-review 34 P1). An adopted settle used to persist the row and nothing else, so
      // the run's completion callback — which now hangs off that fact — never fired for exactly the runs the
      // durable callback exists for: the ones whose original process died.
      const adoption = run.adopt(adopted, this.now());
      const stampedAdoption = this.stampFacts(record.tenant, adoption.facts);
      // ── AND THE ADOPTED ATTEMPT IS STAMPED BY THIS SETTLEMENT (arch-review 63 P1-high) ─────────────
      //
      // The recovery used to close the attempt itself, after this call returned. `committed` requires the
      // parent to be open and a successful settle closes it, so that stamp was refused every time and every
      // successful recovery left its attempt `reserved`. The seam for exactly this has existed since
      // arch-review 45: hand the stamp to the settlement and the two writes are one decision, ordered so the
      // guard's question still has an answer.
      const adoptedAttempt = adoptedAttemptId;
      // …and the VERDICT'S attempt, when the recovered result carries one (arch-review 64 P1-high). A
      // two-phase case has two rows under one execution id, and a recovery that adopts the merged document is
      // adopting both halves' work — so both reach the same terminal in this write, or the verifier's row is
      // left at `verdict_produced` for a case that finished. Read off the receipt this settlement is
      // committing, never remembered, so it cannot name a verdict the run did not take.
      const adoptedVerifier = adoption.patch.result?.verifier?.work?.attemptId;
      const claimed = await settleRun(
        this.deps.store,
        record.id,
        adoption.patch,
        stampedAdoption.map((f) => f.record),
        {
          epoch,
          ...(adoptedAttempt !== undefined && this.deps.attempts !== undefined
            ? {
                stamp: {
                  attempts: this.deps.attempts,
                  attemptId: adoptedAttempt,
                  apply: async (ledger) => {
                    await ledger.transition(adoptedAttempt, "committed");
                    if (adoptedVerifier !== undefined) await ledger.transition(adoptedVerifier, "committed");
                  },
                },
              }
            : {}),
        },
      );
      if (claimed !== undefined && stampedAdoption.length > 0) void this.deps.events?.pushPersisted?.(stampedAdoption);
      // …and the intermediates are owed no longer (arch-review 64 P1-high). This is a SETTLEMENT — the
      // adoption path does not pass through `finalize` — so the window ends here too, and only when the
      // claim landed: a refused fence means the winner still needs the halves.
      const adoptedDigest = adoption.patch.result !== undefined ? stagedHalfDigestOf(adoption.patch.result) : undefined;
      if (claimed !== undefined && adoptedDigest !== undefined)
        await discardIntermediates(
          this.deps.agentHalves,
          this.deps.verdicts,
          record.tenant,
          runExecutionId(record.id),
          adoptedDigest,
        );
      // Lost: the run settled on its own, which is a resume nobody needs rather than one that failed.
      return claimed === undefined ? settledElsewhere() : { kind: "resumed" };
    }
    const spec = record.caseSpec; // local narrow — canRedispatch() already requires it
    if (!run.canRedispatch() || !spec) return Run.from(record).isTerminal() ? settledElsewhere() : UNRESUMABLE;
    const redispatched = await this.deps.store.update(record.id, run.redispatch(this.now()).patch, undefined, {
      expectNonTerminal: true,
      // …under the epoch this recovery claimed. Without it a second takeover between the claim and here would
      // leave two replicas re-dispatching the same case, each holding a guard the other also satisfies.
      // Absent is ZERO, never "unfenced": a claim raises `epoch + 1` from that same absent value, so proving
      // 0 holds exactly while nobody has claimed and fails the moment somebody has.
      expectOwnerEpoch: epoch,
    });
    // …and the dispatch is DOWNSTREAM of that claim. Without this, a replica whose redispatch lost still
    // started a second execution of a case that already had an answer.
    if (redispatched === undefined) return settledElsewhere();
    // A NEW ATTEMPT OPENS A NEW RECORDING (arch-review 33 P1). The replay buffer is keyed by the run's
    // live-correlation id, which a re-drive reuses on purpose — so without this the winner seals a replay
    // holding the frames of an execution whose settlement was refused, and a reader scrubbing that timeline
    // watches two runs. The claim above is what earns the right to do this: only the driver that won the
    // re-drive clears the buffer.
    // A NEW ATTEMPT IS OPENED AND NAMED (mig 0173/0177). `open` INSERTS the next attempt and returns the
    // generation it owns; the recorder serving this process is told, and every producer that reports through
    // it stamps that number. The previous attempt keeps its own row — its frames, its seal, its ref — and its
    // recorder keeps the number it was started with, which no longer addresses anything this run replays.
    // …and a re-drive is exactly the case that HAS an earlier producer to revoke, which is why this one
    // always opens a new attempt while a first dispatch opens none (see the batch's note).
    // …and the PHYSICAL ledger records the re-drive as its own attempt (arch-review 42), which is the one
    // thing the recording buffer alone could never say: both executions of a re-driven run are addressed by
    // the same live-correlation id, and only the attempt ordinal tells them apart.
    const runId = RunService.runIdFor(record);
    const attempt = await openPhysicalAttempt(
      { attempts: this.deps.attempts, recordings: this.deps.recordingStore },
      { executionId: runId, tenant: record.tenant, childRunId: record.id, driverEpoch: epoch },
    );
    this.rememberAttempt(runId, attempt);
    if (attempt.generation !== undefined) {
      this.attempt.set(runId, attempt.generation); // …and it rides onto the job below (CaseJob.recordingGeneration)
    }
    void this.track(
      record.id,
      {
        tenant: record.tenant,
        harness: record.harness,
        case: spec, // placement.target was injected before persisting — routes to the same runtime
        ...(record.createdBy ? { submittedBy: record.createdBy } : {}),
        ...(record.trigger ? { trigger: record.trigger } : {}),
      },
      undefined,
      // The epoch this recovery WON — handed over by the claim, not read back off the row.
      epoch,
    );
    return { kind: "resumed" };
  }

  // Default is standalone runs (activity list); scorecardId → only that batch's child runs (scorecard-detail case
  // drilldown); includeChildren → all runs (standalone + children) for the activity console's "all executions" view;
  // runnerId → runs a self-hosted runner executed (runner-detail activity feed), offset-paginated by limit (newest first).
  // `viewer` (the member asking) drops another member's personal executions in the QUERY — a transport always
  // passes it; an internal sweep leaves it unset.
  // ── A DELIVERY TARGET IS NOT A RUN PROPERTY ANYONE MAY READ (arch-review 34 P1, security) ───────────
  //
  // The completion callback had to become durable — a URL that lives only in the submit request belongs to
  // one process, which is the defect the durable intent fixed. What it must NOT become is part of the run
  // every workspace member can read: a webhook URL is routinely the credential itself
  // (`…/hook/<secret>`, `…?token=<secret>`), and the served RunRecord goes to `GET /runs/:id`, to the list,
  // and to the MCP tools that hand an agent the whole record. Storing it and serving it are two decisions,
  // and only the first one was needed.
  //
  // Stripped at the read boundary rather than at each transport, because "every caller remembers to remove
  // it" is the shape of rule this codebase has already watched fail several times. The consumer that
  // actually delivers reads the STORE, not this.
  async list(
    tenant?: string,
    opts?: {
      scorecardId?: string;
      includeChildren?: boolean;
      runnerId?: string;
      limit?: number;
      offset?: number;
      viewer?: string;
    },
  ): Promise<RunRecord[]> {
    // Verdicts attach here for the same reason as get(): the policy that judged a child is its parent's,
    // which the store cannot know. Batched — one parent-policy resolution per distinct scorecard in the page.
    return this.withVerdicts((await this.deps.store.list(tenant, opts)).map(withoutCallback));
  }

  // THE EPOCH THIS PROCESS IS DRIVING UNDER (arch-review 31 P1, mig 0170). Captured when the dispatch starts
  // and proved on the settle, because a settle that re-READ the epoch would read the value its usurper just
  // wrote and sail straight through — the displaced driver has to be measured against the number it held,
  // not against the world as it now is.
  private readonly driverEpoch = new Map<string, number>();
  // …and the recording ATTEMPT it is serving (mig 0173). Every append and the seal carry it; the store
  // refuses a producer holding any other number, which is what revokes an attempt that came back.
  private readonly attempt = new Map<string, number>();
  // ── THE PHYSICAL ATTEMPT THIS DISPATCH IS, BY NAME (arch-review 44) ────────────────────────────────
  //
  // The map above is a RECORDING FENCE — a number producers stamp — and it is absent whenever the recording
  // claim was refused (`unisolated`). Everything that has to NAME the attempt was deriving itself from that
  // number, so an unisolated execution named nothing: its ledger row was opened, the run then succeeded, and
  // the row still said `created` because the terminal stamp had no coordinate to address. Two ledgers that
  // are opened together must be closed together, so the coordinate is kept in its own right.
  private readonly attemptRow = new Map<string, string>();
  // The dispatch this process is awaiting, by run id — the cooperative half of `cancel`'s teardown. Present
  // only while THIS replica drives the run; a cancel served by another replica tears down through the kill
  // and lease arms instead, which is why none of them is sufficient alone.
  private readonly inFlight = new Map<string, AbortController>();

  // The one place a dispatch learns its attempt's name: the ledger's row id when a row was opened, else the
  // coordinate the recording generation spells (a deployment with recordings and no attempt ledger still has
  // real attempts — they are simply unrecorded as rows).
  private rememberAttempt(executionId: string, attempt: { attemptId?: string; generation?: number }): void {
    const named =
      attempt.attemptId ??
      (attempt.generation !== undefined ? attemptIdOf(executionId, attempt.generation) : undefined);
    if (named !== undefined) this.attemptRow.set(executionId, named);
  }

  // The settle's authority, as this process holds it. Absent = a run this process never dispatched (a
  // self-hosted lease reporting in, a legacy row) — unfenced exactly as before, never invented.
  private fence(id: string): { epoch?: number } | undefined {
    const epoch = this.driverEpoch.get(id);
    return epoch === undefined ? undefined : { epoch };
  }

  private async track(id: string, input: SubmitInput, envelopeId?: string, epoch?: number): Promise<void> {
    if (epoch !== undefined) this.driverEpoch.set(id, epoch);
    // The cooperative abort a user cancel pulls (the batch lane's `inFlight`, at run scale): the signal
    // reaches the dispatcher, which rejects a not-yet-started dispatch and stops the pollers waiting on a
    // started one. Registered BEFORE the first await — `submit` fires this method with `void`, so a cancel
    // arriving in the same tick would otherwise find no controller and fall back to the kill/lease arms.
    const abort = new AbortController();
    this.inFlight.set(id, abort);
    // ── AN ATTEMPT IS OPENED BY EVERY DISPATCH, THE FIRST ONE INCLUDED (review 40 P1) ─────────────────
    //
    // A re-drive opened one in resume(); a FIRST dispatch opened none, so the job shipped with no
    // recordingGeneration and the whole durable evidence lane failed closed against it: a self-hosted
    // runner's frame/log tee was refused ("this job opened no recording attempt") and the terminal run had
    // no replay — on the first execution only, the one every run has. Attempt opening is a dispatch
    // primitive, not a recovery privilege. An open that fails leaves the map unset (the case still runs;
    // its replay is simply not claimed), which is the same fail-closed reading the batch dispatch has.
    if (this.attempt.get(runExecutionId(id)) === undefined) {
      const attempt = await openPhysicalAttempt(
        { attempts: this.deps.attempts, recordings: this.deps.recordingStore },
        {
          executionId: runExecutionId(id),
          tenant: input.tenant,
          childRunId: id,
          ...(epoch !== undefined ? { driverEpoch: epoch } : {}),
        },
      );
      this.rememberAttempt(`evd-run-${id}`, attempt);
      if (attempt.generation !== undefined) this.attempt.set(`evd-run-${id}`, attempt.generation);
    }
    // A declarative harness (command etc.) has its spec resolved from the registry and embedded in the job — the agent interprets it with no code.
    // An inline spec (service-internal synthetic harness, e.g. the code-judge dry-run wrapper) wins over the registry.
    // Built-ins (claude-code/scripted) aren't in the registry, so undefined → fall back to id branching.
    const harnessSpec =
      input.harnessSpec ??
      (this.deps.resolveHarness
        ? await this.deps.resolveHarness(input.tenant, input.harness.id, input.harness.version).catch(() => undefined)
        : undefined);
    // Metering: request override → workspace policy (DB) → off. The control plane is authoritative — carried on the job and sent to the agent.
    const meterUsage =
      input.meterUsage ?? (this.deps.meterUsageFor ? await this.deps.meterUsageFor(input.tenant) : false);
    // Judge model: request override → workspace default (DB) → none (the judge grader is skipped). The key is injected by the backend as secretEnv.
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);
    // The attempt this dispatch is, as the ledger named it (see rememberAttempt) — read once, so the job
    // literal below states it rather than re-deriving it.
    const attemptRowId = this.attemptRow.get(`evd-run-${id}`);
    const job: CaseJob = {
      evalCase: input.case,
      harness: input.harness,
      tenant: input.tenant,
      meterUsage,
      runId: `evd-run-${id}`, // trace correlation — derivable from the record id, so live observers need no lookup
      priority: "interactive", // a person is waiting on a single run — jumps ahead of batch fan-out in the queue
      ...(input.submittedBy ? { submittedBy: input.submittedBy } : {}),
      ...(harnessSpec ? { harnessSpec } : {}),
      ...(judge ? { judge } : {}),
      // The attempt this dispatch owns, carried to the producer (review 39 P0-1). A re-drive opened a new
      // generation before calling here; a first dispatch has none, and a producer with none stamps 0 — which
      // is what an unopened attempt is, not a way past the fence.
      ...(this.attempt.get(`evd-run-${id}`) !== undefined
        ? { recordingGeneration: this.attempt.get(`evd-run-${id}`) as number }
        : {}),
      // …and the ledger ROW by name (arch-review 51). The generation above is absent whenever the recording
      // claim was refused, while the attempt row exists all the same — and it is this name a SELF-HOSTED park
      // writes to `runner_jobs.current_attempt_id`, which is what lets a later re-lease supersede the attempt
      // it replaced instead of leaving it `executing` for ever.
      ...(attemptRowId !== undefined ? { attemptId: attemptRowId } : {}),
    };
    // Did THIS driver's settlement land? Everything after the fork below hangs off it (arch-review 31 P2).
    let committed = false;
    try {
      // Resolve env secret references ({secretRef}) just before dispatch — shared + the submitter's personal secrets. If absent, throw → isolate as a run failure.
      const secrets =
        job.harnessSpec && this.deps.scopedSecretsFor
          ? await this.deps.scopedSecretsFor(input.tenant, input.submittedBy)
          : undefined;
      const jobToRun =
        secrets && job.harnessSpec ? { ...job, harnessSpec: resolveHarnessSecrets(job.harnessSpec, secrets) } : job;
      // Pure execution is handled by executeCase (token resolve+attach → dispatch), shared with scorecard. The "after" (settle/offload/notify)
      // is this orchestrator's job. admit was already counted synchronously in submit, so don't double-count.
      // onStarted flips the run queued→running the moment compute actually begins (managed dispatch / self-hosted lease)
      // — so a single run parked behind a busy runner reads as "waiting", not "running", exactly like a batch child.
      // M2 live-anomaly fact: the dispatch layer already computed "this cannot start right now" (blocked
      // placement / all capable runners offline) — announce it ONCE per run so subscriptions/agents can react
      // while the run is alive, instead of a person polling the placement read.
      let waitingAnnounced = false;
      const result = await executeCase(this.deps, input.submittedBy ?? input.tenant, jobToRun, {
        signal: abort.signal,
        onStarted: () => void this.markRunning(id),
        // ── THE ATTEMPT THAT RAN, NOT THE ONE THIS DISPATCH OPENED (arch-review 41 P0-evidence) ────────
        // A self-hosted requeue hands the job to a second runner, and that re-lease is its own physical
        // attempt. Everything downstream reads these maps — the seal, the snapshot's artifact key, the
        // receipt's attemptId — so leaving them on the parked coordinate would seal an abandoned attempt's
        // row and name it as the execution that produced the result.
        //
        // The ref NAMES the attempt (arch-review 52), so the row coordinate no longer has to be re-derived
        // from a fence that may not exist. And when it does not exist the fence is DROPPED rather than kept:
        // an unisolated re-lease owns no recording, so the generation still in this map is the PREDECESSOR's,
        // and sealing under it would publish the abandoned attempt's frames as this result's replay.
        onAttempt: (attempt) => {
          const executionId = `evd-run-${id}`;
          if (attempt.recording) this.attempt.set(executionId, attempt.recording.generation);
          else this.attempt.delete(executionId);
          this.rememberAttempt(executionId, { attemptId: attempt.attemptId });
        },
        // ── WHERE THE COMPUTE IS, WRITTEN DOWN WHILE IT EXISTS (arch-review 52, Wave 2) ───────────────
        // The backend just created the external object and this is the only moment its exact name is in
        // memory. Persist it on the attempt row so a teardown that outlives this process — a cancel after a
        // restart, a supersede from another replica — can stop THAT job instead of every job of this case.
        // Awaited — a run whose handle cannot be recorded must not place compute (arch-review 53, Wave A).
        // ONE capability, because two optional hooks is what let the activation half die in the Scheduler's
        // forwarding allowlist while every piece of it existed (arch-review 58 W2). A caller holds the
        // authority to place managed work, or it does not.
        authority: {
          reserve: (work) => this.reserveWork(id, work),
          // …and the proof is re-presented at the seam where the object is actually created (arch-review 57
          // P0). Supplying it is what makes the activation transition a protocol rather than an optional hook
          // nobody passes — the state machine existed for a wave with no producer, so every managed dispatch
          // still spent a reservation that nothing had re-checked (arch-review 58).
          activate: (work) => this.activateWork(id, work),
        },
        onWaiting: (reason) => {
          if (waitingAnnounced) return;
          waitingAnnounced = true;
          void this.deps.events
            ?.emit({
              workspace: input.tenant,
              kind: "run.placement_blocked",
              subject: { type: "run", id },
              payload: { reason, ...(input.runtime ? { runtime: input.runtime } : {}) },
              message: `Run ${id} cannot start — ${reason}`,
            })
            ?.catch?.(() => {});
        },
      });
      // Cost attribution, itemized per model: managed = the job's tenant · workspace-shared runner = that workspace ·
      // personal runner = own-pays, EXCEPT calls that used a workspace-billed model (the team's key paid) → the
      // workspace. The same lines feed the meter (usage display) + the enforcement budget.
      let caseUsd = 0;
      for (const c of billingCharges(result, input.tenant)) {
        this.deps.budget?.settle(c.tenant, c.cost);
        this.deps.usage?.record(c.tenant, c.source, c.model, c.cost, c.evaluations);
        caseUsd += c.cost.usd;
      }
      // Envelope draw-down (§5.2 O7 meter): the full caused cost charges the delegating envelope.
      if (envelopeId && caseUsd > 0) void this.deps.envelopes?.settle(envelopeId, input.tenant, caseUsd);
      // Offload os-use screenshots (embedded base64) to object storage → the record keeps only the URL (slim). On failure the run still succeeds (fallback: keep base64).
      if (this.deps.artifacts && result.snapshot) {
        try {
          // ── KEYED BY THE ATTEMPT, NOT BY THE RUN (review 39 P0-6) ────────────────────────────────
          //
          // `runs/<id>` is the same key for every attempt of a run, and this write happens BEFORE the
          // terminal CAS. So a displaced attempt that loses the row still writes its bytes there — an object
          // store has no compare-and-set — and the ledger ends up holding the winner's result beside the
          // loser's screenshot. The batch path already keys per attempt; this one did not, which is the same
          // defect wearing the standalone lane's clothes.
          // The ATTEMPT's own coordinate (attemptRow), never `?? 0`: with the sentinel every unisolated
          // attempt of every run shared one `…#g0` object key — and an object store has no CAS, so the
          // exact overwrite this key exists to prevent came back through the fallback (arch-review 46).
          // No known attempt coordinate → keep the snapshot inline rather than stage it under a lie.
          const attemptKey =
            this.attemptRow.get(`evd-run-${id}`) ??
            (this.attempt.get(`evd-run-${id}`) !== undefined
              ? attemptIdOf(`evd-run-${id}`, this.attempt.get(`evd-run-${id}`) as number)
              : undefined);
          if (attemptKey !== undefined)
            result.snapshot = await offloadSnapshot(result.snapshot, this.deps.artifacts, `attempts/${attemptKey}`);
        } catch {}
      }
      // ── PREPARE THE EVIDENCE, THEN COMMIT — the batch lane's order, here too (arch-review 41 P1) ─────
      //
      // The recording used to seal AFTER the terminal settle, with `recordingRef` attached in a follow-up
      // patch. Two defects fell out of that order: a crash between the settle and the patch published a
      // SUCCEEDED run (completion fact and all) whose evidence set was not final — consumers reacting to the
      // fact saw a run with no recordingRef, forever — and the follow-up patch amended a terminal result
      // under a weaker guard (`expectNotCancelled`, no epoch), with its failure swallowed.
      //
      // The seal is attempt-generation-fenced (mig 0173), so sealing BEFORE the terminal CAS cannot poison a
      // winner: a displaced attempt seals ITS OWN generation's row, and when its settle is then refused the
      // sealed recording is an orphan attempt's evidence — referenced by nothing, overwriting nothing. The
      // TRAJECTORY seal stays downstream of the committed settle (arch-review 32 P0): that store keeps the
      // FIRST segment per emitter, so only the settle's winner may plant it.
      // …and only for an attempt that OWNS its buffer (arch-review 46, the batch lane's own rule): with no
      // known generation the recording claim was refused — sealing would publish an earlier attempt's frames
      // as this result's replay, which is worse than having none. Unknown is absent, never generation 0.
      const sealGeneration = this.attempt.get(`evd-run-${id}`);
      if (this.deps.recordingStore && sealGeneration !== undefined) {
        try {
          const generation = sealGeneration;
          await foldEnvDeltas(this.deps.recordingStore, `evd-run-${id}`, result, generation);
          const ref = await this.deps.recordingStore.seal(
            `evd-run-${id}`,
            {
              envKind: input.case.env.kind,
              dispatch: dispatchManifest(result.harness, input.case.fixtures),
            },
            generation,
          );
          // Attached to the RESULT the terminal write itself carries — the row is born final, no post-terminal
          // amendment, and the completion fact vouches for an evidence set that actually exists.
          if (ref) result.recordingRef = ref;
        } catch {}
      }
      // …and the physical attempt reaches its terminal state with it (arch-review 42 · 45): the stamp rides
      // the settlement where the store has the seam for it, and follows it — awaited — where it does not.
      committed =
        (await this.finalize(id, (run) => run.succeed(result, this.now()), { committed: "committed" })) !== undefined;
      // P5 dual-write: seal the trajectory in the OWNED store (best-effort, idempotent — evidence, not lifecycle).
      // The producer's declared clock anchor (CaseResult.traceT0) rides along as the execution segment's t0 —
      // without it, a trace whose events carry only relative `t` can never join the placement plane's axis.
      if (committed && result.trace.length > 0)
        void this.sealPlanes(id, input.tenant, result.trace, {
          ...(result.traceT0 !== undefined ? { t0: result.traceT0 } : {}),
          ...this.attemptIdentity(id),
        });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      // The single-run ledger keeps the SAME post-mortem the batch path does: the classified CaseFailure with the
      // evidence the backend captured at throw time (placement identity + log tail, gone from the cluster right
      // after settlement) plus the evidence trace. Live-caught gap — error {code,message} alone left a failed
      // single run with no "why" once the orchestrator job was GC'd.
      const failed = failedCaseResult(job, err);
      committed =
        (await this.finalize(id, (run) => run.fail(error, this.now(), failed), { committed: "failed", error })) !==
        undefined;
      // Dual-write parity with the success path, including the part that matters: a settle that lost publishes
      // no evidence either, so the winner's trajectory is the one the run keeps.
      if (committed && failed.trace.length > 0)
        void this.sealPlanes(id, input.tenant, failed.trace, {
          ...(failed.traceT0 !== undefined ? { t0: failed.traceT0 } : {}),
          ...this.attemptIdentity(id),
        });
    }
    this.attempt.delete(`evd-run-${id}`); // this process is done recording for this run
    this.attemptRow.delete(`evd-run-${id}`); // …and its attempt has reached a terminal state above
    this.inFlight.delete(id); // …and there is nothing left for a cancel to abort in this process
    // Completion notification (Mattermost etc.) — with the latest record, and only for the writer whose
    // settlement COMMITTED. Failure is independent of the run result (swallow). Independent of the webhook.
    if (committed && this.deps.onComplete) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(input.tenant, rec).catch(() => {});
    }
    // THE CALLBACK IS NOT FIRED HERE AT ALL ANY MORE (arch-review 33). It is recorded on the run at submit
    // and delivered off the terminal FACT by `runWebhookConsumer`, which the settlement wrote in the same
    // transaction — so a refused settle calls nobody, and a callback survives the process that started the
    // run. See that consumer for the three ways the inline version failed.
  }

  // Flip the run queued→running when compute actually begins (the onStarted hook: managed dispatch / self-hosted
  // lease). Best-effort and idempotent — acts only on a still-queued record (a terminal/already-running run is a
  // no-op), and a store error never disturbs the run itself.
  // ── THE PHYSICAL ATTEMPT'S STATE, IN THE STANDALONE LANE (arch-review 42) ──────────────────────────
  //
  // Addressed by (executionId, generation), the same coordinate the receipt and the sealed trajectory spell —
  // which is what lets a self-hosted RE-LEASE join up without threading anything: the hub opened its ledger
  // row under this run's execution id and its own generation, `onAttempt` moved this map onto that number,
  // and the stamp below therefore lands on the row the second runner actually opened.
  //
  // WHAT IS LEFT ON THIS PATH, now that the TERMINAL stamp rides the settlement (arch-review 45, see
  // `finalize`): every stamp that has no settlement to ride — `executing` (nothing is being committed), a
  // loser's `superseded` (its write never landed), and both endings on a store without the atomic seam. Those
  // are diagnostics: nothing reads them to decide anything, which is why a failure here costs an audit row and
  // never an outcome. What they still owe is the ORDER — awaited immediately after the settle whose answer
  // they record, so a process that exits after settling has already written the row it is about to be asked
  // about (arch-review 44).
  //
  // The coordinate is the ATTEMPT's, not the recording fence's (see `attemptRow`) — an attempt that ran
  // unisolated has a row and no generation, and it is exactly the execution whose ending matters most.
  // Stamp the placement handle onto the attempt row this dispatch opened — from `onReserved`, before the
  // backend creates anything (arch-review 53, Wave A). NOT swallowed: the asymmetry that justified swallowing
  // it disappeared with the reordering. A rejection now aborts a dispatch that has placed no compute, instead
  // of leaving compute nobody can address.
  // …and it RETURNS THE PROOF (arch-review 54, Phase 1). The early return covered two situations that look
  // alike from here and are not: a lane with no ledger (which must not be placing managed work at all) and a
  // run whose attempt row was never opened. Both resolved, and a resolved reservation is what licenses the
  // cluster object. Both are refusals now.
  // The reservation, re-presented. Answers a DECISION rather than throwing: a refusal is the ordinary
  // outcome when a cancellation got there first, and the lane turns it into an aborted dispatch. A run with
  // no ledger answers `activate` — there is no reservation to re-check, and refusing would make the ledger a
  // prerequisite for dispatching rather than a record of it.
  private async activateWork(id: string, work: RuntimeWorkRef): Promise<ActivationDecision> {
    const attempts = this.deps.attempts;
    const attemptId = this.attemptRow.get(`evd-run-${id}`);
    if (!attempts || attemptId === undefined) return { kind: "activate" };
    return await attempts.activateWork(attemptId, work);
  }

  private async reserveWork(id: string, work: RuntimeWorkRef): Promise<PersistedWorkIntent> {
    const attempts = this.deps.attempts;
    const attemptId = this.attemptRow.get(`evd-run-${id}`);
    if (!attempts || attemptId === undefined)
      throw new InternalError(
        "NOT_CONFIGURED",
        { run: id, externalJobId: work.externalJobId },
        "this run has no attempt row to record its placement on — the work about to be created could not be addressed afterwards.",
      );
    return await attempts.reserveWork(attemptId, { ...work, attemptId });
  }

  private async stampAttempt(
    id: string,
    to: ExecutionAttemptState,
    patch?: { error?: { code: string; message: string } },
  ): Promise<void> {
    const attempts = this.deps.attempts;
    const attemptId = this.attemptRow.get(`evd-run-${id}`);
    if (!attempts || attemptId === undefined) return;
    await attempts.transition(attemptId, to, { childRunId: id, ...patch }).catch(() => {});
  }

  // WHOSE EVIDENCE THIS IS, spelled the way the ledger spells it (arch-review 44). The seal used to derive
  // `attemptIdOf(runId, …)` from the RECORD id, so a standalone run's trajectory claimed to come from
  // `<recordId>#g0` — a coordinate no ledger, receipt or artifact key has ever used (they are all keyed on
  // the EXECUTION id, `evd-run-<recordId>`). A reader holding that trajectory beside the attempt ledger could
  // not join the two, which is the only thing the field is for. Absent when this dispatch opened no attempt:
  // "not stated" is a fact, an invented coordinate is not.
  private attemptIdentity(id: string): { attemptId?: string } {
    const attemptId = this.attemptRow.get(`evd-run-${id}`);
    return attemptId === undefined ? {} : { attemptId };
  }

  private async markRunning(id: string): Promise<void> {
    // Compute actually began — the ledger's `executing`, stamped beside the run's own queued→running flip.
    // Awaited: the caller already fires this hook with `void`, so nothing is blocked by ordering the two
    // writes, and an un-awaited stamp could land after the terminal one (where the state machine refuses it
    // and the row silently loses the fact that this attempt ever started).
    await this.stampAttempt(id, "executing");
    try {
      const rec = await this.deps.store.get(id);
      if (!rec || rec.status !== "queued") return;
      await this.deps.store.update(id, Run.from(rec).start(this.now()).patch, undefined, {
        expectNonTerminal: true,
      });
    } catch {
      // Best-effort visibility flip.
    }
  }

  // Terminal writes go through the domain guard: read the current record and skip when it is already settled
  // (first terminal write wins — a raced boot-recovery adoption must not be overwritten by a late tracker).
  // ── Agent activations on the universal ledger (execution-model.md P3, decision O4: the CP owns the
  // record, the agent service reports transitions over the internal bridge it already uses). Record-only —
  // nothing dispatches here, and the ledger writes carry NO outbox facts in this slice: the agent.run.*
  // family still announces the lifecycle (the run.* emit flip needs the subject-aware matcher guard first —
  // see Run.settleAgent). Reports are at-least-once → both writes are idempotent. ──
  async recordAgentRun(input: {
    id: string;
    tenant: string;
    agentId: string;
    agentVersion?: string;
    sessionId: string;
    eventKind: string;
    eventId?: string;
    createdBy?: string;
    budgetUsd?: number; // the delegated slice (A7/§5.2) — stamped as this run's envelope
  }): Promise<void> {
    const existing = await this.deps.store.get(input.id);
    if (existing) return; // a retried started-report — the first write stands
    await this.deps.store.create(Run.newAgentRun({ ...input, now: this.now() }));
  }

  // The same ledger for the turns a MEMBER types (decision O1: chat turns are runs, grouped under the
  // conversation). Idempotent like the activation twin, and settled through the same `settleAgentRun` — the
  // only difference is the record the domain mints (member cause, interactive class).
  async recordChatTurn(input: {
    id: string;
    tenant: string;
    agentId: string;
    agentVersion?: string;
    sessionId: string;
    actor: string;
  }): Promise<void> {
    const existing = await this.deps.store.get(input.id);
    if (existing) return;
    await this.deps.store.create(Run.newChatTurn({ ...input, now: this.now() }));
  }

  async settleAgentRun(
    id: string,
    outcome: "completed" | "failed" | "cancelled" | "suspended",
    message: string,
    trace?: TraceEvent[],
    // The turn's own spans, when the agent recorded them live (N6). Preferred over `trace`: the recorder saw
    // the model call's latency, the retries and the subagents, none of which a transcript projection holds.
    spans?: TraceSpan[],
  ): Promise<void> {
    const current = await this.deps.store.get(id);
    if (!current || current.kind !== "agent") return; // never settle an eval run through the agent bridge
    // O2 (transcripts are traces): the terminal report carries the turn's transcript projected as TraceEvent —
    // seal it as the run's OWN trajectory (source "run", first write wins). Offered BEFORE the terminal guard:
    // at-least-once reports re-offer harmlessly (idempotent seal) and a retry can heal a seal the first report
    // lost. Best-effort like every dual-write — the settle below is the durable half.
    // The turn's evidence inherits the turn's audience (a member's transcript stays that member's), and its
    // relative clock is anchored at the run's own start — the turn opened when the record was created, so the
    // trajectory can be laid on a wall-clock axis without the agent service having to ship one.
    //
    // …but only from the driver that still HOLDS this run (arch-review 32 P0). The healing case is the same
    // driver re-reporting its own turn; a DIFFERENT driver — one displaced by a takeover, whose settle below
    // is about to be refused — sealing here would leave the run's outcome and the trajectory every judgment
    // reads describing two different executions, with the store's first-write-wins keeping the wrong one.
    // Holding the row's current epoch is what tells those two apart.
    const held = this.driverEpoch.get(id);
    const owns = held === undefined || held === (current.ownerEpoch ?? 0);
    if (owns) {
      if (spans && spans.length > 0) void this.sealRecordedSpans(id, current.tenant, spans, current);
      else if (trace && trace.length > 0)
        void this.sealPlanes(id, current.tenant, pricedTrace(trace), { record: current, t0: current.createdAt });
    }
    const run = Run.from(current);
    if (run.isTerminal()) return; // first terminal write wins (a retried terminal report)
    const { patch } = run.settleAgent(outcome, message, this.now());
    // The settle CAS: `isTerminal()` above answers for THIS process, and an agent turn's settle races the
    // session sweep and the cancel path in others.
    const settled = await settleRun(this.deps.store, id, patch, undefined, this.fence(id));
    // Cascade cancel (§5.5, O8): a member stopping the agent run revokes its whole caused tree — one
    // cancel, not a hunt across N batches.
    //
    // DOWNSTREAM OF THE COMMITTED SETTLEMENT, not of the attempt (arch-review 28 P1). A cancel that lost the
    // race to the agent's own success used to cascade anyway, leaving a ledger where the parent SUCCEEDED
    // and its children were cancelled "because the parent was cancelled" — a reason that never happened.
    // Same shape as the live-push leak a review ago; the side effect here is real work being revoked.
    if (settled !== undefined && outcome === "cancelled")
      void this.deps.onAgentRunCancelled?.(current.tenant, id)?.catch?.(() => {});
  }

  // ── USER STOP FOR A STANDALONE RUN (the batch protocol, at run scale) ────────────────────────────────
  //
  // TERMINAL FIRST, then teardown — the order the scorecard lane settled on: the decision is committed under
  // the first-terminal-wins CAS, and only a settlement that COMMITTED earns the right to stop work. A cancel
  // that lost to the run's own completion tears nothing down (stopping the work of a run that finished is a
  // cancellation of something that no longer exists) and simply serves the record that won.
  //
  // WHAT IT SETTLES AS: `failed{code:"CANCELLED"}` — the run lifecycle's cancellation shape (the same one
  // `settleAgent("cancelled")` and the batch's child settles write). The status union is deliberately NOT
  // widened: "cancelled" is a REASON on a failed run here, and every reader already knows that spelling.
  //
  // WHY THERE IS NO RUN-LEVEL CANCELLATION LEDGER: the batch teardown owns N children, a Temporal workflow and
  // a fan-out loop, so a crashed teardown there needs a reconciler to converge it. A run's teardown is three
  // idempotent commands against ONE job identity, and the convergent retry below (a cancel of an
  // already-cancelled run re-runs the teardown and returns the record, never a conflict) gives every one of
  // them an owner the caller can invoke. If this ever grows a durable operation row, it grows one for the same
  // reason the batch did — a teardown no caller is left to retry — not because the shape looks similar.
  //
  // `viewer` is the member asking, and the audience rule answers it exactly as the read does: another
  // member's agent turn or shell session is NOT FOUND, never a 403 (no existence leak, `runAudience`).
  async cancel(input: { tenant: string; id: string; viewer?: string }): Promise<RunRecord> {
    const rec = await this.deps.store.get(input.id);
    if (!rec || rec.tenant !== input.tenant || (input.viewer !== undefined && !canReadRun(rec, input.viewer)))
      throw new NotFoundError("NOT_FOUND", { run: input.id }, "Run not found.");
    // A batch child is not independently stoppable: its parent's loop would keep dispatching and its receipt
    // ledger would be told about an outcome nobody asked for. Cancel the SCORECARD — that teardown settles
    // every child, this one included.
    if (rec.parentScorecardId !== undefined)
      throw new ConflictError(
        "CONFLICT",
        { run: rec.id, scorecard: rec.parentScorecardId },
        "This run is a scorecard's child — stop the scorecard instead (its teardown settles every child).",
      );
    const run = Run.from(rec);
    if (run.isTerminal()) {
      // ── A CANCEL RETRY CONVERGES, IT DOES NOT CONFLICT (the batch lane's rule) ──────────────────────
      // The DECISION is already durable; what a retry owes is the TEARDOWN, which is idempotent end to end.
      // Bouncing off the terminal guard here would leave a killed-nothing run whose compute is still burning
      // and no caller with a way to try again. Succeeded / failed-for-another-reason / suspended keep the
      // conflict: cancelling finished work is a cancellation of something that no longer exists.
      if (rec.status === "failed" && rec.error?.code === "CANCELLED") {
        await this.tearDownDurably(rec);
        return (await this.get(rec.id)) ?? rec;
      }
      throw new ConflictError(
        "CONFLICT",
        { run: rec.id, status: rec.status },
        `Run is already ${rec.status} — cancel rejected.`,
      );
    }
    const message = `Run ${rec.id} was stopped.`;
    // An AGENT run settles through its own verb: the agent lane maps `cancelled` onto the same
    // failed{CANCELLED} row but emits no run.* fact (the agent.run.* family still carries that lifecycle —
    // see Run.settleAgent), and stopping one revokes the whole tree it caused.
    const isAgentRun = rec.kind === "agent";
    const { patch, facts } = isAgentRun
      ? run.settleAgent("cancelled", message, this.now())
      : run.fail({ code: "CANCELLED", message }, this.now());
    const stamped = this.stampFacts(rec.tenant, facts);
    // UNFENCED on purpose: the epoch proves "I am still the driver", and a cancel is not the driver — it is
    // an outside decision about the driver's work. The terminal CAS (`expectNonTerminal`) is the whole guard
    // it needs, and it is the same one the batch's child settles use.
    //
    // …and the DECISION carries its OWED TEARDOWN in the same statement (arch-review 52, Wave 3). Before
    // this, the standalone lane committed the cancel and then ran the teardown with no durable record that
    // it was owed — the method's own comment named the caller's retry as the owner, which is true of a 5xx
    // and false of a crash. The instruction rides the settle for the same reason the outbox facts do: two
    // commits have a window, and the window is exactly the crash this row exists to survive.
    const settled = await settleRun(
      this.deps.store,
      rec.id,
      patch,
      stamped.map((f) => f.record),
      this.deps.cancellations ? { requestCancellation: true as const } : undefined,
    );
    if (settled === undefined) return (await this.get(rec.id)) ?? rec; // the run finished first — nothing to stop
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    // The physical attempt was abandoned before it could claim the case — `superseded` is the ledger's word
    // for exactly that. Best-effort (a diagnostic row, never an outcome), and awaited so a process that exits
    // after cancelling has already written the row it is about to be asked about.
    await this.stampAttempt(rec.id, "superseded");
    // The decision has committed — from here the teardown is owed. A failure still surfaces as this call's
    // failure (the caller's retry re-runs it), and it is ALSO recorded, so the reconciler converges the run
    // whose caller never came back.
    await this.tearDownDurably(settled);
    return (await this.get(rec.id)) ?? settled;
  }

  // Stop a cancelled run's live work. Every arm is idempotent (that is what makes the convergent retry above
  // safe): (1) the cooperative abort of a dispatch THIS replica is awaiting, (2) drop a still-queued scheduler
  // entry, (3) revoke a self-hosted lease — awaited, because a fire-and-forget revocation let the API report
  // the cancel done while the runner kept going, (4) force-kill an already-dispatched managed backend job.
  // A kill that failed means compute may still be burning, so it is reported rather than swallowed: the
  // record is already terminal, so the retry costs nothing and re-runs the whole teardown.
  private async stopRun(rec: RunRecord): Promise<CancellationCertificate> {
    this.inFlight.get(rec.id)?.abort();
    // …through the ONE owner of this derivation. Spelled inline, a child row's teardown would look under
    // `evd-run-<row id>` while its attempts live under `evd-<batch>-<case>` — the same coordinate confusion
    // the brand exists to surface (rule `protocol` L3).
    const executionId = RunService.runIdFor(rec);
    this.deps.cancelQueued?.((j) => j.runId === executionId);
    const leasesSignalled = (await Promise.resolve(this.deps.cancelLeased?.((j) => j.runId === executionId))) ?? 0;
    // UNCONDITIONAL, not gated on `status === "running"`. Two reasons, and the second is the one that bites:
    // the status is a snapshot (a run read as queued may have been dispatched a millisecond later), and by
    // the time a RETRY gets here the record is already terminal — so a status gate would make the convergent
    // retry, the one path that exists to finish an unfinished teardown, the one path that never kills. A kill
    // of a case with no job is a no-op at the backend.
    // ── STOP THE WORK, NOT THE CASE (arch-review 52, Wave 2) ─────────────────────────────────────────
    //
    // Every attempt this run opened recorded the exact external object its dispatch created, so the stop is
    // addressed by THAT: this job, in this namespace, on this cluster. The case-id kill below is what it
    // replaces — a selector that says nothing about which run placed the job, so cancelling one run stopped
    // every concurrent execution of the same case, and the batch that owned one read an infra failure it
    // never caused.
    //
    // The fallback is CONDITIONAL ON HAVING NO HANDLE, never a belt-and-braces second call: firing both would
    // reintroduce the blast radius the handles exist to remove. Runs with no handle are the legacy ones
    // (attempts opened before this column existed) and the lanes that mint none (self-hosted leases, which
    // arm (3) above already revoked).
    // ── ONE READ, SO THE TWO ARMS CANNOT BE ABOUT DIFFERENT ROWS (arch-review 62 P1) ─────────────────
    //
    // The handles this teardown kills and the reservations it revokes are the SAME attempt rows, and they
    // were fetched by two calls taking a coordinate nothing types. One got `executionId`, the other got
    // `rec.id` — four lines apart — so `attempts.list("r1")` matched nothing, the revocation loop never had
    // a body, and the arm arch-review 57 added to stop a paused submitter placing after a certified zero was
    // inert for every standalone run while looking present at a glance.
    //
    // Read once and derive both. A coordinate used twice is a coordinate that can differ; used once, it
    // cannot (rule `protocol` L3, a predicate written twice has already diverged).
    const rowsRead = await this.attemptRows(executionId);
    const works = rowsRead.kind === "read" ? rowsRead.value.flatMap((a) => (a.runtimeWork ? [a.runtimeWork] : [])) : [];
    const worksRead: ReadResult<RuntimeWorkRef[]> = rowsRead.kind === "read" ? readOk(works) : rowsRead;
    // ── A STOP THAT COULD NOT BE CONFIRMED IS NOT A STOP (arch-review 52, Wave 3) ────────────────────
    //
    // Both arms used to be `.catch(failure)` over a `Promise<void>`, and the seam underneath swallowed the
    // backend's rejection — so the only way this method could learn of a failed teardown was an exception
    // that the composition root had already eaten. The arms answer now, and the answer is read: `stopped`
    // and `absent` are convergence, `unknown` and `failed` are not, and only the second pair keeps the
    // operation owed.
    const outcomes: KillOutcome[] = [];
    const attempted = async (call: Promise<KillOutcome>, what: string): Promise<void> => {
      outcomes.push(
        await call.catch(
          (err: unknown): KillOutcome => ({
            status: "failed",
            reason: `${what}: ${err instanceof Error ? err.message : String(err)}`,
          }),
        ),
      );
    };
    // ── TAKE THE RESERVATIONS BACK BEFORE STOPPING ANYTHING (arch-review 57 P0) ─────────────────────
    //
    // Killing what exists cannot stop what has not been created yet. A driver holding a reservation and
    // paused mid-dispatch is invisible to every probe here — its job does not exist — and it would create one
    // the moment it woke, after this teardown had verified zero live work and completed. Revoking first means
    // that driver fails at its activation seam instead of placing.
    //
    // Best-effort and idempotent per attempt: a settled attempt is left alone, and an unreadable ledger has
    // already made `worksRead` unknown, which keeps the whole cancellation owed anyway.
    const attemptsStore = this.deps.attempts;
    if (attemptsStore && rowsRead.kind === "read")
      // A revocation that FAILED leaves a reservation somebody may still spend, so it is an `unknown`
      // outcome and not a swallowed error: the cancellation stays owed and the reconciler comes back. It
      // joins the same outcome list the kills use, because it is the same question — is there anything
      // that could still be running for this run?
      for (const { attemptId } of rowsRead.value.filter((a) => !isTerminalAttemptState(a.state)))
        await attemptsStore.revokeReservation(attemptId).catch((err: unknown) => {
          outcomes.push({
            status: "unknown",
            reason: `revoke ${attemptId}: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    if (worksRead.kind === "unknown") {
      // UNKNOWN NEVER WIDENS SCOPE (arch-review 53, Wave A.5). Whether this run placed managed work is
      // unestablished, so neither arm is available: the exact kill has no handle to use, and the case-id
      // fallback would stop compute belonging to runs this cancel says nothing about. The operation stays
      // owed with the reason recorded, and the reconciler converges it once the ledger answers.
      outcomes.push({ status: "unknown", reason: worksRead.reason });
    } else if (works.length > 0 && this.deps.killWork) {
      for (const work of works)
        await attempted(this.deps.killWork(rec.tenant, rec.runtime, work), `kill ${work.externalJobId}`);
    } else if (this.deps.killUnhandled) {
      await attempted(this.deps.killUnhandled(rec.tenant, rec.runtime), `stop ${rec.id} (no handle)`);
    }
    // THE CAUSAL TREE IS PART OF THIS TEARDOWN (arch-review 52, Wave 3). Stopping an agent run revokes every
    // batch it caused, and that cascade used to be fired into the void beside the terminal write — so a
    // crash in between left the descendants running with nothing recording that they were owed. Awaited
    // here, it is inside the operation the reconciler sweeps, and it is idempotent for the same reason the
    // rest of this method is (re-cancelling an already-terminal batch is skipped by `cancelCausedBy`).
    const cascade = rec.kind === "agent" ? await this.deps.onAgentRunCancelled?.(rec.tenant, rec.id) : undefined;
    const failures = [
      ...outcomes.filter((o) => !killConverged(o)).map((o) => o.reason ?? o.status),
      ...(cascade?.failures ?? []),
    ];
    if (failures.length > 0) {
      const worst = worstKillOutcome(outcomes);
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: rec.id, caseId: rec.caseId, kill: worst.status, failures: failures.length },
        `Run ${rec.id} is cancelled but its teardown has not converged: ${failures.slice(0, 3).join("; ")}${
          failures.length > 3 ? "; …" : ""
        }. The cancellation stays owed and the reconciler retries.`,
      );
    }
    // ── AND NOW THE READBACK (arch-review 53, Wave E) ─────────────────────────────────────────────
    //
    // Everything above is an account of the CALLS this teardown made. This is the world it left behind: each
    // handle asked whether its object is actually gone. A `live` reading means the stop was accepted and the
    // compute has not stopped yet; an `unknown` one means nobody could ask. Either keeps the operation owed
    // — the caller's throw below is what leaves it that way, and the reconciler converges it.
    let activeManagedWork = 0;
    let unverifiable = 0;
    if (this.deps.probeWork && works.length > 0)
      for (const work of works) {
        const seen = await this.deps.probeWork(rec.tenant, rec.runtime, work).catch(
          (err: unknown): WorkPresence => ({
            kind: "unknown",
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        if (seen.kind === "live") activeManagedWork += 1;
        else if (seen.kind === "unknown") unverifiable += 1;
      }
    if (activeManagedWork > 0 || unverifiable > 0)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: rec.id, activeManagedWork, unverifiable },
        `Run ${rec.id} is cancelled and its compute is not confirmed freed: ${activeManagedWork} job(s) still live, ${unverifiable} unreadable. The cancellation stays owed and the reconciler retries.`,
      );
    return {
      at: this.now(),
      kills: {
        stopped: outcomes.filter((o) => o.status === "stopped").length,
        absent: outcomes.filter((o) => o.status === "absent").length,
      },
      leasesSignalled,
      // The zeroes this completion is standing on — stated only where a reading was actually taken, because
      // an absent probe is not a quiet cluster.
      ...(this.deps.probeWork && works.length > 0 ? { activeManagedWork: 0, unverifiable: 0 } : {}),
      ...(cascade ? { cascadeCancelled: cascade.cancelled } : {}),
    };
  }

  // The run lane's half of the durable cancellation protocol — the same wrapper the batch lane runs, over
  // the same ledger, so the two cannot drift into two protocols.
  private async tearDownDurably(rec: RunRecord): Promise<void> {
    await runDurableTeardown(
      { ...(this.deps.cancellations ? { cancellations: this.deps.cancellations } : {}), now: () => this.now() },
      { kind: "run", id: rec.id } satisfies CancellationTarget,
      () => this.stopRun(rec),
    );
  }

  // The teardown the coordinator re-runs for an owed `run` operation, on this replica or another. Re-reads
  // the record rather than trusting the row: the process that decided the cancel may be long gone, and a
  // run that is no longer cancelled (deleted, or a stale row naming a live run) has no teardown this
  // operation is entitled to run — tearing it down would be the reconciler cancelling work nobody cancelled.
  cancellationTeardown(): (runId: string) => Promise<CancellationTeardownResult> {
    return async (runId) => {
      const rec = await this.deps.store.get(runId);
      if (!rec) return { kind: "unactionable", reason: `run ${runId} no longer exists` };
      if (!(rec.status === "failed" && rec.error?.code === "CANCELLED"))
        return { kind: "unactionable", reason: `run ${runId} is ${rec.status}, not cancelled` };
      return { kind: "converged", certificate: await this.stopRun(rec) };
    };
  }

  // The exact work this execution placed, oldest attempt first.
  //
  // THREE-VALUED (arch-review 53, Wave A.5). The previous version caught the ledger error and answered `[]`,
  // with the reasoning written down beside it: "an unreadable ledger is the same situation as an empty one,
  // and both mean address it the old way". They are not the same situation. An empty ledger means this
  // execution placed no managed work; an unreadable one means nobody knows what it placed — and "address it
  // the old way" is the case-id kill, which stops every concurrent run of the same case. So a database blip
  // during a cancel widened one run's teardown into everyone's.
  // The one handle a display lane addresses — the newest this execution placed. `undefined` when the ledger
  // holds none or could not be read: a display read then falls back to the case-id resolution, which is a
  // possibly-wrong panel rather than a possibly-wrong record (arch-review 53, Wave B). Decisions do not use
  // this; they use `workHandles`, which reports `unknown` instead of guessing.
  private async displayWork(executionId: ExecutionId): Promise<RuntimeWorkRef | undefined> {
    const read = await this.workHandles(executionId);
    return read.kind === "read" ? read.value.at(-1) : undefined;
  }

  // This execution's physical attempt rows — the ONE ledger read a teardown works from. Both of the things
  // a cancellation needs are derived from it (which external objects to stop, which reservations to take
  // back), because two reads meant two coordinates and the two drifted (arch-review 62 P1).
  private async attemptRows(executionId: ExecutionId): Promise<ReadResult<ExecutionAttemptRecord[]>> {
    const attempts = this.deps.attempts;
    if (!attempts) return readOk([]); // no ledger wired at all — this deployment records no handles, established
    return readOrUnknown(() => attempts.list(executionId), `attempt ledger for ${executionId}`);
  }

  private async workHandles(executionId: ExecutionId): Promise<ReadResult<RuntimeWorkRef[]>> {
    const read = await this.attemptRows(executionId);
    if (read.kind !== "read") return read;
    return readOk(read.value.flatMap((a) => (a.runtimeWork ? [a.runtimeWork] : [])));
  }

  // The OWNED trajectory (P5): workspace-scoped read — a foreign/missing run reads undefined (the route
  // maps it to 404, no existence leak). The run row's embed stays the fallback during the dual-read window.
  // `viewer` applies the audience rule over the same record: evidence is exactly as private as the execution
  // that produced it, so another member's chat transcript is not readable through the trajectory door.
  async trajectory(
    tenant: string,
    runId: string,
    viewer: string,
  ): Promise<
    | {
        meta: { source: string; eventCount: number; sealedAt: string };
        events: unknown[];
        segments: TrajectorySegmentWire[];
      }
    | undefined
  > {
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== tenant || !canReadRun(record, viewer)) return undefined;
    // …asked for BY THE ATTEMPT THE RECEIPT VOUCHES FOR, when this run is a batch's child and the ledger
    // named one (arch-review 52, Wave 7). The receipt is the canonical-outcome authority; the trajectory
    // store is evidence. Without the identity the store falls back to its own clock, which is the writer's
    // and therefore not an authority on which execution answered the case. A missing receipt (never
    // committed, legacy row, no store wired) reads exactly as before.
    // WHICH attempt this child's verdict rests on, from the receipt ledger that decided it.
    //
    // A ledger that cannot be READ is not a ledger with no receipt (arch-review 53, Wave A.5). The previous
    // version caught the error into `[]`, which produced `undefined` here and sent the read down the
    // clock-resolved path — the exact substitution Wave 7's identity read exists to refuse, reached by a
    // database blip instead of by a decision. The read is refused instead: a caller asking for a child's
    // evidence gets nothing rather than possibly-another-attempt's bytes.
    const receipts =
      record.parentScorecardId !== undefined && this.deps.caseReceipts !== undefined
        ? await this.deps.caseReceipts.read(record.parentScorecardId)
        : readOk([]);
    if (receipts.kind === "unknown")
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: runId, reason: receipts.reason },
        `Cannot establish which attempt's evidence run ${runId} rests on: ${receipts.reason}`,
      );
    const canonicalAttemptId =
      receipts.kind === "read"
        ? receipts.value.find((receipt) => receipt.childRunId === record.id)?.attemptId
        : undefined;
    const sealed = await this.deps.trajectories?.get(
      tenant,
      runId,
      canonicalAttemptId !== undefined ? { attemptId: canonicalAttemptId } : undefined,
    );
    if (sealed) {
      const { runId: _r, tenant: _t, ...meta } = sealed.meta;
      // The run page reads the whole SYSTEM, not just the agent: every emitter that contributed (the
      // execution plus each service that pushed its own spans) travels in the same shape the ledger's
      // own detail read serves.
      return { meta, events: sealed.events, segments: trajectorySegmentsWire(sealed) };
    }
    // Dual-read fallback: the pre-P5 embed — served in the same shape so consumers never care which copy.
    if (record.result && record.result.trace.length > 0)
      return {
        meta: { source: "embed", eventCount: record.result.trace.length, sealedAt: record.updatedAt },
        events: record.result.trace,
        segments: [
          {
            emitter: "embed",
            source: "run",
            eventCount: record.result.trace.length,
            sealedAt: record.updatedAt,
            // The pre-ledger embed is a point-event stream by construction — it predates the record.
            format: "events",
          },
        ],
      };
    return undefined;
  }

  // Read-then-update is not atomic, but the tracker and boot recovery share one control-plane process.
  // Evidence, never lifecycle: a seal failure must not touch the run's outcome. Splits the raw stream into the
  // agent's plane and the orchestrator's (docs/architecture/native-observability.md) so the judged `events`
  // carry no placement noise and each plane keeps its own clock anchor.
  // `owned` is the run whose audience the evidence inherits (`runAudience`): a chat turn's transcript is as
  // private as the turn. Passing the RECORD rather than a subject keeps the rule in one place — a caller
  // cannot seal personal evidence as the workspace's by forgetting a field. `t0` anchors the plane in
  // absolute time when the caller knows where its relative clock starts.
  // Spans the agent RECORDED — sealed as the record, no assembly. The audience rule is the same one the
  // projection path applies: a member's turn stays that member's evidence.
  private async sealRecordedSpans(runId: string, tenant: string, spans: TraceSpan[], record: RunRecord): Promise<void> {
    const store = this.deps.trajectories;
    if (!store) return;
    const audience = runAudience(record);
    await store
      .seal({
        runId,
        tenant,
        source: "run",
        spans,
        ...(audience.scope === "member" ? { owner: audience.subject } : {}),
        ...runEvidenceIdentity(record),
      })
      .catch(() => {});
  }

  private async sealPlanes(
    runId: string,
    tenant: string,
    events: TraceEvent[],
    // WHOSE evidence this is (review 39 P1, corrected in arch-review 44). A re-driven run keeps its
    // correlation id on purpose, so the seal has to say which physical attempt produced the plane — and the
    // caller is the one that knows: an eval run passes its dispatch's attempt (see `attemptIdentity`), an
    // agent turn has no physical attempt and passes none.
    owned?: { record?: RunRecord; t0?: string; attemptId?: string },
  ): Promise<void> {
    const store = this.deps.trajectories;
    if (!store) return;
    const audience = owned?.record !== undefined ? runAudience(owned.record) : undefined;
    await sealExecutionPlanes(store, {
      runId,
      tenant,
      events,
      ...(owned?.attemptId !== undefined ? { attemptId: owned.attemptId } : {}),
      ...(audience?.scope === "member" ? { owner: audience.subject } : {}),
      ...(owned?.record !== undefined ? runEvidenceIdentity(owned.record) : {}),
      ...(owned?.t0 !== undefined ? { t0: owned.t0 } : {}),
    }).catch(() => {});
  }

  // Returns the record it SETTLED, or undefined when the fence refused — the caller's licence to do anything
  // downstream (arch-review 31 P2). A run's completion notification used to fire whether or not this write
  // landed, so a driver whose settle lost still announced a settlement it had no part in: one outcome, two
  // notifications, the second from the process that was told it had been replaced.
  private async finalize(
    id: string,
    outcome: (run: Run) => RunTransition,
    // What the physical attempt becomes IF this settlement commits (arch-review 45). A settlement that is
    // REFUSED stamps `superseded` instead — that attempt lost, and a write that never landed owes no
    // transaction to anything.
    stamp?: { committed: ExecutionAttemptState; error?: { code: string; message: string } },
  ): Promise<RunRecord | undefined> {
    const current = await this.deps.store.get(id);
    if (!current) return undefined;
    const run = Run.from(current);
    if (run.isTerminal()) return undefined;
    // E0 outbox: the terminal fact the transition computed persists atomically with the terminal write —
    // a crash between "run settled" and "the world was told" is no longer expressible.
    const { patch, facts } = outcome(run);
    const stamped = this.stampFacts(current.tenant, facts);
    // ── THE ATTEMPT'S TERMINAL STAMP RIDES THE SETTLEMENT (arch-review 45) ───────────────────────────
    //
    // The batch lane got this a review ago (`commitCase`); the standalone lane kept a dual-write because it
    // has no receipt to claim — and the window was the same one: a crash between the fenced settle and the
    // awaited stamp left a succeeded run whose attempt row said `created` forever. The run row IS this
    // lane's outcome record, so the commit point is the terminal write itself.
    // ── …AND SO DOES THE VERIFIER'S, WHEN THE CASE HAD TWO HALVES (arch-review 64 P1-high) ──────────
    //
    // A private-verifier case is two physical executions under one execution id, and only one of them was
    // being settled here. The verifier's row stops at `verdict_produced` — bytes exist, nobody has said
    // whether the case took them — and THIS write is the moment it learns: the run is settling with a result
    // whose `verifier` receipt is that invocation, so the same transaction adopts both attempts or neither.
    //
    // Read off the receipt rather than remembered: the receipt is what the settlement is actually committing,
    // so an attempt id taken from it cannot name a verdict the run did not adopt (rule `protocol` L3).
    const verifierAttempt = patch.result?.verifier?.work?.attemptId;
    const riding =
      stamp !== undefined ? this.attemptStamp(id, stamp.committed, stamp.error, verifierAttempt) : undefined;
    // ── AND THE INTERMEDIATES ARE OWED NO LONGER (arch-review 64 P1-high) ────────────────────────────
    //
    // The staged half and the staged verdict exist for exactly one window: from the agent's container being
    // reaped to this write. `discardAgentHalf` had ONE production caller — the standalone RECOVERY — and the
    // ordinary path that completes without crashing never discarded anything, so every private-verifier case
    // left a full intermediate `CaseResult` in object storage forever. `recoverVerifiedCase`'s own comment
    // said "the settlement owns the discard"; this is the settlement, and it did not.
    const stagedDigest = patch.result !== undefined ? stagedHalfDigestOf(patch.result) : undefined;
    let settled: RunRecord | undefined;
    let faulted = false;
    try {
      settled = await settleRun(
        this.deps.store,
        id,
        patch,
        stamped.map((f) => f.record),
        {
          ...this.fence(id),
          ...(riding !== undefined ? { stamp: riding } : {}),
        },
      );
    } catch (err) {
      // Reachable through the atomic seam only: `update` reports a refused fence as `undefined` and throws
      // only on a store fault, and on the two-step path a fault has always propagated to the caller (which
      // settles the run failed) — so that path keeps rethrowing, byte for byte.
      if (riding === undefined) throw err;
      // The stamp (or the write it rode) faulted, and the transaction took the terminal write with it. The
      // run is still OPEN, which is the honest state and the one boot recovery re-drives — settling it
      // FAILED here would publish a failure for an execution that succeeded, on the strength of an audit
      // row we could not write.
      faulted = true;
    }
    this.driverEpoch.delete(id);
    // A CAS loser publishes nothing — the guarded write inserted no durable event, and this bus feeds agent
    // activation rather than a UI toast.
    if (settled !== undefined && stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    if (stamp !== undefined && !faulted) {
      // A settle that LOST did not supersede itself — somebody else's attempt owns the run now, and
      // `superseded` is the ledger's word for exactly that. Best-effort either way: the loser has no
      // transaction to ride (its write never landed), and neither does a deployment without the seam.
      if (settled === undefined) await this.stampAttempt(id, "superseded");
      else if (riding === undefined)
        await this.stampAttempt(id, stamp.committed, stamp.error !== undefined ? { error: stamp.error } : undefined);
    }
    // …and only a settlement that LANDED ends the window. A refused fence means somebody else owns this run
    // and their settlement will discard; a fault means the run is still open and the halves are still owed.
    if (settled !== undefined && !faulted && stagedDigest !== undefined)
      await discardIntermediates(
        this.deps.agentHalves,
        this.deps.verdicts,
        settled.tenant,
        runExecutionId(id),
        stagedDigest,
      );
    return settled;
  }

  // The atomic seam AS THIS DEPLOYMENT ACTUALLY HAS IT — three conditions asking three different questions:
  // a ledger is wired at all, this dispatch can NAME its attempt (see `attemptRow`), and the store can make
  // the terminal write and the stamp one decision. Missing any one of them, the lane keeps the two-step it
  // has always had, which is why the stamp's failure is swallowed there and fatal here.
  private attemptStamp(
    id: string,
    to: ExecutionAttemptState,
    error?: { code: string; message: string },
    // The verifier's attempt, when this case had a judging half. Settled in the SAME `apply`, so a case whose
    // verdict the run adopted cannot leave that verdict's row saying nobody decided (arch-review 64).
    verifierAttemptId?: string,
  ): AttemptStamp | undefined {
    const attempts = this.deps.attempts;
    const attemptId = this.attemptRow.get(runExecutionId(id));
    if (!attempts || attemptId === undefined || this.deps.store.settleWith === undefined) return undefined;
    return {
      attempts,
      attemptId,
      apply: async (bound) => {
        // The transition's own answer is deliberately unread: a refusal is a silent no-op by contract (an
        // already-terminal row meeting a late stamp is ordinary), and only a throw aborts the settlement.
        await bound.transition(attemptId, to, { childRunId: id, ...(error !== undefined ? { error } : {}) });
        // …and the verdict's own row, to the SAME terminal. `verdict_produced → committed` is exactly the
        // adoption this settlement is performing, and it happens here or the phase has no reader — which is
        // the leak an inert phase becomes (rule `protocol`, the phase-readers law).
        if (verifierAttemptId !== undefined) await bound.transition(verifierAttemptId, to);
      },
    };
  }

  // Stamp identity (id/tenant/createdAt) onto domain facts. The store persists the rows in the same
  // transaction as the write; the SAME ids then travel the push path, so dedup holds on either route.
  private stampFacts(tenant: string, facts: DomainFact[]): StampedFact[] {
    return stampFacts(tenant, facts, { newId: this.newId, now: this.now });
  }
}

// Structured WHY for a standalone submit (execution-model.md P0) — the free-string trigger's successor; both
// are stamped during the transition window. web|mcp = a member acted through a UI; ci = the CI federation;
// anything else (direct API, unset) = api. Scorecard children carry group instead (their WHY is the batch's).
function standaloneRunOrigin(
  trigger: string | undefined,
  submittedBy: string | undefined,
  causedByRunId?: string,
): RunOrigin {
  // An agent-run-caused submit outranks the source mapping — the causedBy edge is the demand graph (P3).
  if (causedByRunId !== undefined)
    return { cause: "run", causedByRunId, ...(submittedBy ? { actor: submittedBy } : {}) };
  const cause = trigger === "web" || trigger === "mcp" ? "member" : trigger === "ci" ? "ci" : "api";
  return { cause, ...(submittedBy ? { actor: submittedBy } : {}) };
}

// The legacy-row half of the attach rule (see RunService.get): a record minted before executions declared
// their channels still answers "what can I attach to" — from the domain's one rule, never a per-surface guess.
function withAttachChannels(record: RunRecord): RunRecord {
  if (record.attach !== undefined) return record;
  const channels = attachChannelsFor({
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    ...(record.placement?.target !== undefined ? { target: record.placement.target } : {}),
  });
  return channels.length > 0 ? { ...record, attach: channels } : record;
}
