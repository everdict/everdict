import type { Dispatcher } from "@everdict/backends";
import { type BudgetTracker, billingTenant, costOf } from "@everdict/billing";
import {
  type AgentJob,
  AppError,
  type CaseResult,
  type EvalCase,
  type HarnessSecretMaps,
  type HarnessSpec,
  type JudgeRunConfig,
  type RegistryAuth,
  resolveHarnessSecrets,
} from "@everdict/core";
import type { RunRecord, RunStore } from "@everdict/db";
import { type ArtifactStore, offloadSnapshot } from "@everdict/storage";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";
import { assertRuntimeTarget } from "../lib/require-runtime.js";
import { executeCase } from "./execute-case.js";

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
  harness: { id: string; version: string };
  case: EvalCase;
  runtime?: string; // the tenant Runtime id to run on (placement.target). If absent, the default backend (same symmetry as scorecard).
  // this run's origin (activity-view source axis): web|mcp|api|… if unset, unset (direct API). Scorecard children are shown as "scorecard" by the service.
  trigger?: string;
  webhookUrl?: string;
  meterUsage?: boolean; // metering override for this request only (if unset, the workspace policy)
  judge?: JudgeRunConfig; // judge-model override for this request only (if unset, the workspace default)
}

export interface RunServiceDeps {
  dispatcher: Dispatcher; // Scheduler (recommended) or Router — placement/fairness/autoscaling live there
  store: RunStore;
  // Source factory for out-of-job trace collection (collect="control-plane") — used by executeCase to complete a traceRef result.
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  // Auth for the collection pull (re-resolving the traceRef.authSecret name) — the workspace SecretStore's decrypted value. Same as scorecard.
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  // Policy gate: if true, submitting a run with no runtime/self target is 400 (no silent local fallback). The API (main.ts) is always true.
  // Unset (test: a mock dispatcher injected directly) = no gate. Not an env toggle — a fixed deployment policy.
  requireRuntime?: boolean;
  budget?: BudgetTracker; // the API owns the admission gate (402 when exceeded) and cost settle
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
  // The token is carried transiently on the job (AgentJob.repoToken) only and never stored on the record/case.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // Workspace-owned GitHub App token (preferred) — if the case git URL owner matches a workspace installation, issued via that App.
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // Workspace image-registry pull credentials — if the job image is from that registry, attach as job.registryAuth (executeCase).
  registryAuthsFor?: (workspace: string) => Promise<RegistryAuth[]>;
  // Live-progress log read (observability ②): resolve the run's runtime lane to a live backend and read the
  // case job's current stdout (Backend.logs). Best-effort — absent/miss = no logs, never an error.
  readCaseLogs?: (tenant: string, runtimeList: string | undefined, caseId: string) => Promise<string | undefined>;
  // Open an interactive shell stream inside a run's live sandbox (observability ⑥). undefined = no live container.
  openTerminalStream?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
  ) => Promise<import("@everdict/backends").ExecStreamHandle | undefined>;
  // Capture a live browser frame (observability ⑦) — resolves the run's runtime to a topology backend and
  // captures its per-case browser CDP screen by runId. Returns base64 PNG (no data: prefix). undefined = none.
  captureBrowserScreen?: (
    tenant: string,
    runtimeList: string | undefined,
    runId: string,
  ) => Promise<string | undefined>;
  // One-shot exec inside the case's live sandbox (observability ④ web terminal / ⑤ screen capture). Resolves the
  // run's runtime to a live backend and runs `sh -c command`. undefined = no live container.
  execInSandbox?: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    command: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  // Completion callback (succeeded/failed) — completion notifications (Mattermost etc.). Failure is independent of the run result (the service swallows it). Separate from webhook.
  onComplete?: (tenant: string, record: RunRecord) => Promise<void>;
  // Artifact store (when configured): offload os-use screenshots to object storage → the record keeps only the URL (no inline base64).
  artifacts?: ArtifactStore;
  newId?: () => string;
  now?: () => string;
  fetch?: typeof fetch; // for the webhook (test injection)
}

// Manages a run's async lifecycle: accept (202) → delegate to the dispatcher → on completion, update the store + webhook.
// Unit-testable independent of HTTP. AppError is thrown as-is so the caller (server) maps it to a status code.
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
    assertRuntimeTarget(this.deps.requireRuntime, input.runtime ?? input.case.placement?.target);
    this.deps.budget?.admit(input.tenant); // PaymentRequiredError (402) when exceeded — no run created
    // When a runtime is chosen, inject it as the case's placement.target → RuntimeDispatcher routes to the tenant runtime (same symmetry as scorecard).
    const effective: SubmitInput = input.runtime
      ? { ...input, case: { ...input.case, placement: { ...input.case.placement, target: input.runtime } } }
      : input;
    // The placed runtime (work-queue axis) — an explicit runtime or the case's own placement.target. If absent, the default backend (unset).
    const placedRuntime = input.runtime ?? input.case.placement?.target;
    const ts = this.now();
    const record: RunRecord = {
      id: this.newId(),
      tenant: effective.tenant,
      harness: effective.harness,
      caseId: effective.case.id,
      status: "queued",
      ...(effective.trigger ? { trigger: effective.trigger } : {}), // activity-view source axis (web|mcp|api…)
      // Executor stamp — notification-feed recipient (notifications N2). Same pattern as scorecard createdBy (0035).
      ...(effective.submittedBy ? { createdBy: effective.submittedBy } : {}),
      ...(placedRuntime ? { runtime: placedRuntime } : {}),
      // Persist the (placement-injected) case body — boot recovery's re-dispatch basis (mig 0051). Without it a
      // CP restart used to tombstone queued/running standalone runs, since the inline case lived only in memory.
      caseSpec: effective.case,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.track(record.id, effective); // fire-and-track
    return record;
  }

  async get(id: string): Promise<(RunRecord & { liveTrace?: LiveTraceRef }) | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    return this.withLiveTrace(record);
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
      spec?.kind === "command" && spec.trace.kind !== "none"
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

  // Live screen frame (observability ⑤) — captures the case's current screen via an in-sandbox exec and returns a
  // PNG data URL. os-use (desktop): scrot on the case's DISPLAY. Other env kinds have no single-container screen → undefined.
  async screen(
    id: string,
  ): Promise<{ record: RunRecord; dataUrl: string | undefined; supported: boolean } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const env = record.caseSpec?.env;
    // browser (topology) — capture the per-case browser via CDP, keyed by the CP-minted runId derivable from the record.
    if (env?.kind === "browser") {
      if (!this.deps.captureBrowserScreen) return { record, dataUrl: undefined, supported: false };
      const runId = record.parentScorecardId
        ? `evd-${record.parentScorecardId}-${record.caseId}`
        : `evd-run-${record.id}`;
      const b64 = await this.deps.captureBrowserScreen(record.tenant, record.runtime, runId).catch(() => undefined);
      return { record, dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined, supported: true };
    }
    // os-use (desktop) — scrot on the case's DISPLAY via an in-sandbox exec.
    if (env?.kind !== "os-use" || !this.deps.execInSandbox) return { record, dataUrl: undefined, supported: false };
    const display = env.display ?? ":99";
    const shot = "/tmp/.everdict-live.png";
    // Capture then base64 in one shell so nothing is left on disk / no second round-trip. best-effort.
    const command = `DISPLAY=${display} scrot -o ${shot} 2>/dev/null && base64 -w0 ${shot}`;
    const out = await this.deps
      .execInSandbox(record.tenant, record.runtime, record.caseId, command)
      .catch(() => undefined);
    const b64 = out && out.exitCode === 0 ? out.stdout.trim() : "";
    return { record, dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined, supported: true };
  }

  // Open an interactive terminal on a run's live sandbox (observability ⑥). Returns the record (for authz) + a
  // stream handle, or undefined when the record doesn't exist. stream=undefined = no live container to attach to.
  async openTerminal(
    id: string,
  ): Promise<{ record: RunRecord; stream: import("@everdict/backends").ExecStreamHandle | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const stream = this.deps.openTerminalStream
      ? await this.deps.openTerminalStream(record.tenant, record.runtime, record.caseId).catch(() => undefined)
      : undefined;
    return { record, stream };
  }

  // Live-progress logs (observability ②) — the record plus the case job's current raw stdout. text=undefined
  // when there is no job to read (queued, GC'd, or the backend can't tail); the record still scopes/authorizes.
  async logs(id: string): Promise<{ record: RunRecord; text: string | undefined } | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return undefined;
    const text = this.deps.readCaseLogs
      ? await this.deps.readCaseLogs(record.tenant, record.runtime, record.caseId).catch(() => undefined)
      : undefined;
    return { record, text };
  }

  // Boot recovery for an interrupted standalone run. adopted = a result harvested from the still-alive backend
  // job (settle it directly — zero re-run); else re-drive from the persisted caseSpec; legacy records without
  // one return false and keep the tombstone path. docs/architecture/batch-resilience.md
  async resume(record: RunRecord, adopted?: CaseResult): Promise<boolean> {
    if (adopted) {
      await this.deps.store.update(record.id, { status: "succeeded", result: adopted, updatedAt: this.now() });
      return true;
    }
    if (!record.caseSpec) return false;
    await this.deps.store.update(record.id, { status: "running", updatedAt: this.now() });
    void this.track(record.id, {
      tenant: record.tenant,
      harness: record.harness,
      case: record.caseSpec, // placement.target was injected before persisting — routes to the same runtime
      ...(record.createdBy ? { submittedBy: record.createdBy } : {}),
      ...(record.trigger ? { trigger: record.trigger } : {}),
    });
    return true;
  }

  // Default is standalone runs (activity list) — when scorecardId is given, only that batch's child runs (scorecard-detail case drilldown).
  list(tenant?: string, opts?: { scorecardId?: string }): Promise<RunRecord[]> {
    return this.deps.store.list(tenant, opts);
  }

  private async track(id: string, input: SubmitInput): Promise<void> {
    // A declarative harness (command etc.) has its spec resolved from the registry and embedded in the job — the agent interprets it with no code.
    // Built-ins (claude-code/scripted) aren't in the registry, so undefined → fall back to id branching.
    const harnessSpec = this.deps.resolveHarness
      ? await this.deps.resolveHarness(input.tenant, input.harness.id, input.harness.version).catch(() => undefined)
      : undefined;
    // Metering: request override → workspace policy (DB) → off. The control plane is authoritative — carried on the job and sent to the agent.
    const meterUsage =
      input.meterUsage ?? (this.deps.meterUsageFor ? await this.deps.meterUsageFor(input.tenant) : false);
    // Judge model: request override → workspace default (DB) → none (the judge grader is skipped). The key is injected by the backend as secretEnv.
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);
    const job: AgentJob = {
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
      const result = await executeCase(this.deps, input.submittedBy ?? input.tenant, jobToRun);
      // Cost attribution: managed = the job's tenant · workspace-shared runner = that workspace (team resource) · personal runner = own-pays (not charged).
      const bill = billingTenant(result, input.tenant);
      if (bill) this.deps.budget?.settle(bill, costOf(result));
      // Offload os-use screenshots (embedded base64) to object storage → the record keeps only the URL (slim). On failure the run still succeeds (fallback: keep base64).
      if (this.deps.artifacts && result.snapshot) {
        try {
          result.snapshot = await offloadSnapshot(result.snapshot, this.deps.artifacts, `runs/${id}.png`);
        } catch {}
      }
      await this.deps.store.update(id, { status: "succeeded", result, updatedAt: this.now() });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
    }
    // Completion notification (Mattermost etc.) — with the latest record. Failure is independent of the run result (swallow). Independent of the webhook.
    if (this.deps.onComplete) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(input.tenant, rec).catch(() => {});
    }
    if (input.webhookUrl) await this.fireWebhook(input.webhookUrl, id);
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
