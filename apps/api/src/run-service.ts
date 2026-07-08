import { type BudgetTracker, type Dispatcher, billingTenant, costOf } from "@everdict/backends";
import {
  type AgentJob,
  AppError,
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
import { executeCase } from "./execute-case.js";
import { assertRuntimeTarget } from "./require-runtime.js";

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
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.track(record.id, effective); // fire-and-track
    return record;
  }

  get(id: string): Promise<RunRecord | undefined> {
    return this.deps.store.get(id);
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
