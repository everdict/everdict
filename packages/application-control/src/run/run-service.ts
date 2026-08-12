import {
  AppError,
  BadRequestError,
  type CaseFsFilePayload,
  type CaseFsTreePayload,
  type CaseJob,
  type CaseRecording,
  type CaseResult,
  type DomainFact,
  type EvalCase,
  type HarnessSpec,
  type JudgeRunConfig,
  type RegistryAuth,
  type RunOrigin,
  type RunRecord,
  type TraceEvent,
  type TraceSource,
  type TraceSourceConfig,
  type TraceSpan,
  isPulledCommandTrace,
} from "@everdict/contracts";
// Type-only wire reuse (same package's DTO subpath): the placement/topology read models the backends produce.
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
import { type ExecuteCaseDeps, executeCase } from "../execution/execute-case.js";
import type { DriverAuthority } from "../ops/startup-recovery.js";
import { type StampedFact, stampFacts } from "../platform-event/outbox.js";
import { type ArtifactStore, offloadSnapshot, refreshSnapshotRefs } from "../ports/artifact-store.js";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { EnvelopeStore } from "../ports/envelope-store.js";
import type { ExecStreamHandle } from "../ports/exec-stream.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RecordingStore } from "../ports/recording-store.js";
import type { RunStore } from "../ports/run-store.js";
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
  // 이 실행을 소유한 팀 — 자산과 같은 축(라우트가 결정해 넘긴다).
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
  onAgentRunCancelled?: (tenant: string, runId: string) => Promise<unknown>;
  // The OWNED trajectory store (P5 rung 1) — dual-write: the run row keeps its embed for now, and the
  // trajectory ALSO seals here (first write wins). Reads that want the owned copy go through this store.
  trajectories?: TrajectoryStore;
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
  ) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  // Case-scoped placement read (runtime debugging): where the case's orchestrator job stands INSIDE the cluster —
  // queued/blocked (capacity verdict)/starting/running/dead, node, and the orchestrator event feed. Resolves the
  // run's runtime lane to a CaseInspectable backend. Best-effort — absent/miss = no placement info, never an error.
  inspectCasePlacement?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
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
  | { kind: "unresumable" };

const UNRESUMABLE: ResumeResult = { kind: "unresumable" };

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
    return this.withLiveTrace(withAttachChannels(await this.withTrajectoryUsage(await this.withVerdict(record))));
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
      ? await this.deps.execInSandbox(record.tenant, record.runtime, record.caseId, command).catch(() => undefined)
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
      ? await this.deps.inspectCasePlacement(record.tenant, record.runtime, record.caseId).catch(() => undefined)
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
      ? await this.deps.readCaseLogs(record.tenant, record.runtime, record.caseId, stream).catch(() => undefined)
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
      ? ((await this.deps.readCaseEvents(record.tenant, record.runtime, record.caseId).catch(() => undefined)) ?? [])
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
    // Sealed recording first; while the run still executes, fall back to the live tail (peek) — live is a replay
    // that has not finished, so the player can scrub back mid-run off the same read. docs/architecture/replay.md.
    const runId = RunService.runIdFor(record);
    const recording = this.deps.recordingStore
      ? ((await this.deps.recordingStore.get(runId)) ?? (await this.deps.recordingStore.peek(runId)))
      : undefined;
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
  private static runIdFor(record: RunRecord): string {
    return record.parentScorecardId ? `evd-${record.parentScorecardId}-${record.caseId}` : `evd-run-${record.id}`;
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
  async resume(record: RunRecord, adopted?: CaseResult, authority?: DriverAuthority): Promise<ResumeResult> {
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
      const claimed = await settleRun(this.deps.store, record.id, run.adopt(adopted, this.now()).patch, undefined, {
        epoch,
      });
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
    await this.deps.recordingStore?.reset(RunService.runIdFor(record)).catch(() => {});
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
    return this.withVerdicts(await this.deps.store.list(tenant, opts));
  }

  // THE EPOCH THIS PROCESS IS DRIVING UNDER (arch-review 31 P1, mig 0170). Captured when the dispatch starts
  // and proved on the settle, because a settle that re-READ the epoch would read the value its usurper just
  // wrote and sail straight through — the displaced driver has to be measured against the number it held,
  // not against the world as it now is.
  private readonly driverEpoch = new Map<string, number>();

  // The settle's authority, as this process holds it. Absent = a run this process never dispatched (a
  // self-hosted lease reporting in, a legacy row) — unfenced exactly as before, never invented.
  private fence(id: string): { epoch?: number } | undefined {
    const epoch = this.driverEpoch.get(id);
    return epoch === undefined ? undefined : { epoch };
  }

  private async track(id: string, input: SubmitInput, envelopeId?: string, epoch?: number): Promise<void> {
    if (epoch !== undefined) this.driverEpoch.set(id, epoch);
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
        onStarted: () => void this.markRunning(id),
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
          result.snapshot = await offloadSnapshot(result.snapshot, this.deps.artifacts, `runs/${id}`);
        } catch {}
      }
      // SETTLEMENT AUTHORITY GOVERNS EVIDENCE PUBLICATION, NOT ONLY THE ROW (arch-review 32 P0). Notification
      // and metrics already hung off the committed settle; the trajectory and the replay recording did not,
      // and they are the two artifacts every later judgment stands on. The trajectory store keeps the FIRST
      // seal (immutable evidence, a re-offer never rewrites it), so a displaced driver that lost the row and
      // sealed anyway left the run reading `result = B, trajectory = A`: one artifact, two executions, and
      // nothing on the record to say so.
      //
      // So the settle happens FIRST and everything downstream of it derives from the answer. The ordering is
      // the fix — the loser now seals nothing, which leaves the winner's own seal the first and only one.
      committed = (await this.finalize(id, (run) => run.succeed(result, this.now()))) !== undefined;
      // Seal the replay recording (frames/logs teed during the run under job.runId) → attach the ref. Best-effort:
      // a recording failure never fails the run, and an empty recording seals to undefined (no ref). replay.md D3.
      //
      // KNOWN, BOUNDED, AND NOT FIXED HERE (arch-review 33 P1): the SEAL is winner-gated, the buffer is not.
      // Frames, logs and resource samples are appended DURING execution under `job.runId`, which is derived
      // from the record alone (`evd-run-<id>`) so a live observer needs no lookup — and a re-driven run keeps
      // that same key. Two attempts of one run therefore append into one row, and the winner seals a
      // recording that also contains the loser's frames. The trajectory (what judgments read) is clean; the
      // replay artifact is not.
      //
      // Fixing it means giving the ATTEMPT its own identity on the wire — a recording key distinct from the
      // live-correlation id, threaded through the dispatcher, the self-hosted recorder and the managed
      // sampler, with the read following the sealed `recordingRef` rather than re-deriving a key. That is a
      // contract change across three producers and is not something to slip into a fix for something else.
      if (committed && this.deps.recordingStore) {
        try {
          // Fold the in-run repo git-diff checkpoints (CaseResult.envDeltas) into the recording before sealing.
          await foldEnvDeltas(this.deps.recordingStore, `evd-run-${id}`, result);
          const ref = await this.deps.recordingStore.seal(`evd-run-${id}`, {
            envKind: input.case.env.kind,
            dispatch: dispatchManifest(result.harness, input.case.fixtures),
          });
          // The ref is attached to the settled row in a follow-up patch: the settle above is what earned the
          // right to publish this recording, so the reference to it lands after, on the row this driver owns.
          if (ref) {
            result.recordingRef = ref;
            await this.deps.store.update(id, { result }, undefined, { expectNotCancelled: true }).catch(() => {});
          }
        } catch {}
      }
      // P5 dual-write: seal the trajectory in the OWNED store (best-effort, idempotent — evidence, not lifecycle).
      // The producer's declared clock anchor (CaseResult.traceT0) rides along as the execution segment's t0 —
      // without it, a trace whose events carry only relative `t` can never join the placement plane's axis.
      if (committed && result.trace.length > 0)
        void this.sealPlanes(id, input.tenant, result.trace, {
          ...(result.traceT0 !== undefined ? { t0: result.traceT0 } : {}),
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
      committed = (await this.finalize(id, (run) => run.fail(error, this.now(), failed))) !== undefined;
      // Dual-write parity with the success path, including the part that matters: a settle that lost publishes
      // no evidence either, so the winner's trajectory is the one the run keeps.
      if (committed && failed.trace.length > 0)
        void this.sealPlanes(id, input.tenant, failed.trace, {
          ...(failed.traceT0 !== undefined ? { t0: failed.traceT0 } : {}),
        });
    }
    // Completion notification (Mattermost etc.) — with the latest record, and only for the writer whose
    // settlement COMMITTED. Failure is independent of the run result (swallow). Independent of the webhook.
    if (committed && this.deps.onComplete) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(input.tenant, rec).catch(() => {});
    }
    // …and so is the webhook (arch-review 33 P1). A driver whose settle was refused would otherwise POST a
    // completion callback for a run it no longer owns — reading the row back first, so it either announces
    // the WINNER's outcome a second time or, if the winner has not finished, announces a run that is still
    // going as if it were done.
    //
    // The durable shape is a delivery intent written in the same transaction as the settlement, so the
    // callback survives a takeover instead of living only in the request that started it — the URL is not on
    // the record today, which means a new driver could not fire it at all. Named here rather than left to be
    // rediscovered; what is fixed now is that the loser stays quiet.
    if (committed && input.webhookUrl) await this.fireWebhook(input.webhookUrl, id);
  }

  // Flip the run queued→running when compute actually begins (the onStarted hook: managed dispatch / self-hosted
  // lease). Best-effort and idempotent — acts only on a still-queued record (a terminal/already-running run is a
  // no-op), and a store error never disturbs the run itself.
  private async markRunning(id: string): Promise<void> {
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
    const sealed = await this.deps.trajectories?.get(tenant, runId);
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
    owned?: { record?: RunRecord; t0?: string },
  ): Promise<void> {
    const store = this.deps.trajectories;
    if (!store) return;
    const audience = owned?.record !== undefined ? runAudience(owned.record) : undefined;
    await sealExecutionPlanes(store, {
      runId,
      tenant,
      events,
      ...(audience?.scope === "member" ? { owner: audience.subject } : {}),
      ...(owned?.record !== undefined ? runEvidenceIdentity(owned.record) : {}),
      ...(owned?.t0 !== undefined ? { t0: owned.t0 } : {}),
    }).catch(() => {});
  }

  // Returns the record it SETTLED, or undefined when the fence refused — the caller's licence to do anything
  // downstream (arch-review 31 P2). A run's completion notification used to fire whether or not this write
  // landed, so a driver whose settle lost still announced a settlement it had no part in: one outcome, two
  // notifications, the second from the process that was told it had been replaced.
  private async finalize(id: string, outcome: (run: Run) => RunTransition): Promise<RunRecord | undefined> {
    const current = await this.deps.store.get(id);
    if (!current) return undefined;
    const run = Run.from(current);
    if (run.isTerminal()) return undefined;
    // E0 outbox: the terminal fact the transition computed persists atomically with the terminal write —
    // a crash between "run settled" and "the world was told" is no longer expressible.
    const { patch, facts } = outcome(run);
    const stamped = this.stampFacts(current.tenant, facts);
    const settled = await settleRun(
      this.deps.store,
      id,
      patch,
      stamped.map((f) => f.record),
      this.fence(id),
    );
    this.driverEpoch.delete(id);
    // A CAS loser publishes nothing — the guarded write inserted no durable event, and this bus feeds agent
    // activation rather than a UI toast.
    if (settled !== undefined && stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return settled;
  }

  // Stamp identity (id/tenant/createdAt) onto domain facts. The store persists the rows in the same
  // transaction as the write; the SAME ids then travel the push path, so dedup holds on either route.
  private stampFacts(tenant: string, facts: DomainFact[]): StampedFact[] {
    return stampFacts(tenant, facts, { newId: this.newId, now: this.now });
  }

  private async fireWebhook(url: string, id: string): Promise<void> {
    const record = await this.deps.store.get(id);
    try {
      await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch {
      // A webhook failure does not affect the run result (the store is the source of truth; also queryable by polling).
    }
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
