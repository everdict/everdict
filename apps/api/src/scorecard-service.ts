import { type BudgetTracker, type Dispatcher, billingTenant, costOf } from "@everdict/backends";
import {
  type AgentJob,
  AppError,
  BadRequestError,
  type CaseResult,
  type EvalCase,
  classifyFailure,
  type Dataset,
  EnvSnapshotSchema,
  type GradeContext,
  type HarnessSecretMaps,
  type HarnessSpec,
  type JudgeRunConfig,
  NotFoundError,
  type RegistryAuth,
  ScoreSchema,
  type Scorecard,
  type Suite,
  TraceEventSchema,
  resolveHarnessSecrets,
} from "@everdict/core";
import type {
  RunStore,
  ScorecardExport,
  ScorecardOrigin,
  ScorecardRecord,
  ScorecardStep,
  ScorecardStore,
  ScorecardSubset,
} from "@everdict/db";
import { costGrader, latencyGrader, stepsGrader } from "@everdict/graders";
import type { DatasetRegistry, HarnessInstanceRegistry, JudgeRegistry } from "@everdict/registry";
import { type ArtifactStore, offloadSnapshot } from "@everdict/storage";
import {
  type Dispatch,
  type Leaderboard,
  type ScorecardDiff,
  type ScorecardTrend,
  caseVerdict,
  diffScorecards,
  leaderboard,
  runSuite,
  scorecardModels,
  summarizeScorecard,
  trendSeries,
} from "@everdict/suite";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";
import { z } from "zod";
import { executeCase } from "./execute-case.js";
import type { JudgeRunner } from "./judge-runner.js";
import { assertRuntimeTarget } from "./require-runtime.js";
import { ScoringService } from "./scoring-service.js";
import type { CaseExportStream } from "./trace-sink-service.js";

// One-line trace-sink export result — for progress-step messages (success/partial/failure + reason).
function exportStepMessage(e: ScorecardExport): string {
  if (e.status === "succeeded") return `Trace sink (${e.sink}) export complete — ${e.cases?.length ?? 0} case(s)`;
  const label = e.status === "partial" ? "partial export" : "export failed";
  return `Trace sink (${e.sink}) ${label}${e.message ? ` — ${e.message}` : ""}`;
}

// One-line case failure/verdict reason — for progress-step messages. Prefer trace error events over a pass:false score.detail. Truncate if long.
function caseReason(r: CaseResult): string | undefined {
  const errEvent = r.trace.find((e) => e.kind === "error");
  const raw =
    errEvent && "message" in errEvent
      ? errEvent.message
      : r.scores.find((s) => s.pass === false && typeof s.detail === "string")?.detail;
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
}

// Trace-ingest body — upload traces already produced externally without running the harness (edge-normalized: TraceEvent[] upload).
// dataset/harness serve as labels and refs (caseId↔task alignment, diff alignment). Validated at the boundary with TraceEventSchema.
export const IngestScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  traces: z
    .array(
      z.object({
        caseId: z.string(),
        trace: z.array(TraceEventSchema),
        snapshot: EnvSnapshotSchema.optional(),
        scores: z.array(ScoreSchema).optional(),
      }),
    )
    .min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type IngestScorecardBody = z.infer<typeof IngestScorecardBodySchema>;
export type IngestScorecardInput = IngestScorecardBody & {
  tenant: string;
  submittedBy?: string; // submitter subject → record createdBy (runner attribution/filter)
  origin?: ScorecardOrigin;
};

// pull-ingest body — pull per-runId traces from the tenant's OTel/MLflow and score them (harness not run).
// source credentials come only via the authSecret name (SecretStore) — no plaintext token in the spec.
export const PullIngestBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  source: z.object({
    kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
    endpoint: z.string().url(),
    // SecretStore key name → its value used as the credential. otel/mlflow use the Authorization header verbatim (scheme included:
    // "Bearer …"|"Basic …"); for langfuse/langsmith/phoenix the adapter places it in the platform's conventional header (langsmith=x-api-key).
    authSecret: z.string().optional(),
    project: z.string().optional(), // required for phoenix span-lookup path (project name/ID). Ignored for other kinds.
  }),
  runs: z.array(z.object({ caseId: z.string(), runId: z.string() })).min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type PullIngestBody = z.infer<typeof PullIngestBodySchema>;
export type PullIngestInput = PullIngestBody & {
  tenant: string;
  submittedBy?: string; // submitter subject → record createdBy (runner attribution/filter)
  origin?: ScorecardOrigin;
};

// principal.via → origin.source mapping — submission-path provenance (where it was fired from).
// oidc=human (web UI token), github-actions=CI OIDC federation, else (api-key/runner)=api. Scheduled fires stamp "schedule" directly.
export function originSource(via: string): string {
  if (via === "oidc") return "web";
  if (via === "github-actions") return "github-actions";
  return "api";
}

// Partial-run selection — apply ids (explicit) → tags (any-match) → limit (first N) in order. Pure function (easy to test).
// A nonexistent id silently yielding an empty result would be a "ran a subset but looks like the whole thing" hazard, so reject immediately with 400.
export function selectSubsetCases(
  dataset: Dataset,
  sel?: { ids?: string[]; tags?: string[]; limit?: number },
): { cases: Dataset["cases"]; subset?: ScorecardSubset } {
  if (!sel || (!sel.ids?.length && !sel.tags?.length && sel.limit === undefined)) return { cases: dataset.cases };
  let cases = dataset.cases;
  if (sel.ids && sel.ids.length > 0) {
    const want = new Set(sel.ids);
    const have = new Set(cases.map((c) => c.id));
    const missing = [...want].filter((id) => !have.has(id));
    if (missing.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { dataset: dataset.id, missing },
        `Case ids not in the dataset: ${missing.join(", ")}`,
      );
    cases = cases.filter((c) => want.has(c.id));
  }
  if (sel.tags && sel.tags.length > 0) {
    const want = new Set(sel.tags);
    cases = cases.filter((c) => (c.tags ?? []).some((t) => want.has(t)));
  }
  if (sel.limit !== undefined) cases = cases.slice(0, sel.limit);
  if (cases.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { dataset: dataset.id, ...sel },
      "No cases match the selection (check tags/limit).",
    );
  return {
    cases,
    subset: {
      total: dataset.cases.length,
      selected: cases.length,
      ...(sel.ids && sel.ids.length > 0 ? { ids: sel.ids } : {}),
      ...(sel.tags && sel.tags.length > 0 ? { tags: sel.tags } : {}),
      ...(sel.limit !== undefined ? { limit: sel.limit } : {}),
    },
  };
}

export interface RunScorecardInput {
  tenant: string;
  // submitter (principal.subject) — the owner used to resolve a private-repo case's personally-owned connection ("clone via my connection").
  // Consequently a private-repo dataset is effectively single-owner (a case's connectionId only resolves when that owner submits).
  submittedBy?: string;
  dataset: { id: string; version: string };
  // pins = submit-time ephemeral pin overrides (slot→image, registry unchanged) — a CI PR fire swaps one service image for evaluation.
  // Recorded in origin.pinOverrides (reproducibility evidence). Durable changes go through POST /harnesses/:id/pins (a new instance version).
  harness: { id: string; version: string; pins?: Record<string, string> };
  origin?: ScorecardOrigin; // trigger origin (provenance) — the route/schedule stamps source
  judges?: Array<{ id: string; version: string }>; // selected Agent Judges — applied to the trace
  runtime?: string; // tenant Runtime id to run on (placement.target). Absent = default backend.
  judge?: JudgeRunConfig; // inline judge-grader scoring-model override (defaults to the workspace default if unset)
  // Number of cases to dispatch concurrently within one batch (runSuite parallelism). Defaults to the service default if unset.
  // On self-hosted runtimes this many jobs park in the lease queue, and the runner must lease that many concurrently for real case-level parallelism.
  concurrency?: number;
  // Partial run — run only a subset of the full dataset (cost/smoke). Applied in order: ids (explicit selection) → tags (any-match) → limit (first N).
  // The result record is stamped with subset{total,selected,…} to mark that it is "not the whole thing".
  cases?: { ids?: string[]; tags?: string[]; limit?: number };
  // Transient dispatch retries per case (a THROWING dispatch only — a failing eval result is never retried).
  // Default 1. docs/architecture/batch-resilience.md
  retries?: number;
}

export interface ScorecardServiceDeps {
  dispatcher: Dispatcher; // dispatch a case as a job (same path as a single run)
  store: ScorecardStore;
  datasets: DatasetRegistry; // dataset resolution (owner/_shared fallback) + case loading
  harnesses?: HarnessInstanceRegistry; // instance resolution (template+pins→resolved HarnessSpec). Built-ins fall back.
  judges?: JudgeRegistry; // judge resolution (owner/_shared fallback)
  judgeRunner?: JudgeRunner; // trace-based judge execution (model call / skip)
  // Workspace default judge model (for inline judge-grader scoring). A per-request override (RunScorecardInput.judge) takes precedence.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
  budget?: BudgetTracker; // admit/settle per case
  // Batch-on-Temporal driver (docs/architecture/temporal-batch-orchestration.md). When set, submit starts a durable
  // workflow that drives the batch through the internal routes instead of the in-process track loop.
  temporalBatches?: {
    workflowIdFor(scorecardId: string): string;
    start(scorecardId: string): Promise<void>;
    cancel?(scorecardId: string): Promise<void>; // supersede → cooperative workflow cancellation (best-effort)
  };
  // Registered runtime ids for this tenant — powers runtime:"auto" (expand to every registered runtime and shard).
  runtimesFor?: (tenant: string) => Promise<string[]>;
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource; // trace source factory for pull-ingest (@everdict/trace)
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // tenant SecretStore values (inject judge-model keys)
  // For resolving {secretRef} in harness env — two tiers: shared + submitter (owner) personal secrets. Injected by scope.
  scopedSecretsFor?: (tenant: string, subject?: string) => Promise<HarnessSecretMaps>;
  // Resolve a token for seeding a private repo — case env.source.connectionId → external-account connection token. Same as a single run (RunService.repoTokenFor).
  // The connection is personally owned, so resolve by owner (=submitter subject). Applied to every case in the dataset → private-repo dataset batch eval. The token is transient, only on the job (repoToken).
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // Workspace-owned GitHub App token (preferred) — if the case git URL owner matches the workspace installation, issue via that App (same as a single run).
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // Workspace image-registry pull credentials — if the job image belongs to that registry, attach via job.registryAuth (executeCase, same as a single run).
  registryAuthsFor?: (workspace: string) => Promise<RegistryAuth[]>;
  // Completion callback (succeeded/failed) — completion notification (Mattermost etc.). A failure here is independent of the scorecard result (the service swallows it).
  onComplete?: (tenant: string, record: ScorecardRecord) => Promise<void>;
  // Trace-sink export (when configured) — send scored results (trace+scores) to the workspace observability platform (TraceSinkService).
  // The returned outcome is recorded in record.export; a failure is isolated from the scorecard result (surfaced via outcome.status only). docs/architecture/trace-sink.md
  // attach: the pull-ingest (source.kind, caseId→external runId) — if source=sink platform, attach scores to the existing trace instead of duplicating.
  exportResults?: (
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ) => Promise<ScorecardExport | undefined>;
  // Case-streaming sink export (D5) — build a stream so a live batch pushes each case the moment it completes (after judging).
  // If unset, a live batch falls back to exportResults (batched, after the run) (no regression). ingest always uses exportResults (batched).
  exportStreamFor?: (
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string },
  ) => Promise<CaseExportStream | undefined>;
  artifacts?: ArtifactStore; // when set, offload os-use screenshots to object storage (record keeps only the URL)
  // When set, fan out a child run (RunRecord) per case so each case becomes an addressable run (trace/usage/provenance).
  // When unset, keep the current behavior: an embedded scorecard only, no child runs (shares the same RunStore as a single run). Children are hidden from the activity list by default.
  runStore?: RunStore;
  concurrency?: number;
  // Policy gate: if true, a batch without a runtime is rejected 400 at submit (no local fallback). The API (main.ts) always sets true.
  // Unset (tests: inject a mock dispatcher directly) = no gate. Not an env toggle — a deployment's fixed policy.
  requireRuntime?: boolean;
  newId?: () => string;
  now?: () => string;
}

// A scorecard run's async lifecycle: dataset resolution (404 if missing) → create record (202) → batch run (runSuite) → aggregate and persist.
// Unit-testable independently of HTTP. AppError is thrown as-is so the caller (server) maps it to a status code.
export class ScorecardService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly concurrency: number;
  // Scoring concern is split into a separate service — live batch and ingest share the same scoring logic (independent of execution).
  private readonly scoring: ScoringService;
  // Cooperative-cancellation handles for in-flight batches (for supersede) — assumes a single control-plane process (same as the in-process rendezvous).
  // abort only goes as far as "don't fire the remaining cases": force-killing already-fired backend jobs is a separate problem (follow-up).
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: ScorecardServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.concurrency = deps.concurrency ?? 4;
    this.scoring = new ScoringService({
      ...(deps.judges ? { judges: deps.judges } : {}),
      ...(deps.judgeRunner ? { judgeRunner: deps.judgeRunner } : {}),
    });
  }

  // Resolve the dataset synchronously (NotFound→404), resolve the harness version/spec, create the record, then run the batch asynchronously.
  async submit(input: RunScorecardInput): Promise<ScorecardRecord> {
    // Deployment policy: the batch's execution target (a registered runtime or self:<runner>) must be specified — 400 if absent (blocks a silent local fallback).
    assertRuntimeTarget(this.deps.requireRuntime, input.runtime);
    // runtime:"auto" — expand to EVERY runtime the tenant has registered and shard across them (same comma-list
    // round-robin; each backend's capacity still admission-controls actual placement via the Scheduler).
    if (input.runtime === "auto") {
      const ids = this.deps.runtimesFor ? await this.deps.runtimesFor(input.tenant) : [];
      if (ids.length === 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { tenant: input.tenant },
          'runtime:"auto" needs at least one registered runtime in this workspace.',
        );
      input = { ...input, runtime: ids.join(",") };
    }
    const resolved = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
    // Partial run — the rest of the pipeline (batch/judge/aggregate) operates on a dataset containing only the selected cases. Marked via record.subset.
    const { cases: selectedCases, subset } = selectSubsetCases(resolved, input.cases);
    const dataset: Dataset = subset ? { ...resolved, cases: selectedCases } : resolved;

    // Resolve the harness version (latest→concrete) + embed the declarative spec. Built-ins (scripted/claude-code) aren't in the registry → as-given.
    // If submit-time ephemeral pins are present, use resolveWithPins with no fallback — evaluation must not pass while silently ignoring the pins.
    const pins = input.harness.pins && Object.keys(input.harness.pins).length > 0 ? input.harness.pins : undefined;
    let harnessVersion = input.harness.version || "latest";
    let harnessSpec: HarnessSpec | undefined;
    if (pins) {
      if (!this.deps.harnesses)
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          "Pin overrides (pins) are only allowed on harnesses registered in the registry.",
        );
      const spec = await this.deps.harnesses.resolveWithPins(input.tenant, input.harness.id, harnessVersion, pins);
      harnessVersion = spec.version; // the base instance's concrete version (an ephemeral pin does not create a version)
      harnessSpec = spec;
    } else if (this.deps.harnesses) {
      try {
        const spec = await this.deps.harnesses.get(input.tenant, input.harness.id, harnessVersion);
        harnessVersion = spec.version;
        harnessSpec = spec;
      } catch {
        // unregistered/built-in → as-given, no spec embedded
      }
    }

    // provenance: overlay the ephemeral-pin record onto the caller-provided origin. Even if only pins exist (no origin), still record them (reproducibility evidence).
    const origin: ScorecardOrigin | undefined =
      input.origin || pins
        ? { source: input.origin?.source ?? "api", ...(input.origin ?? {}), ...(pins ? { pinOverrides: pins } : {}) }
        : undefined;

    // judge model: request override → workspace default (DB) → none (the inline judge grader is skipped in the agent).
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);
    const concurrency = input.concurrency ?? this.concurrency;
    const retries = input.retries ?? 1; // transient dispatch retry (throw-only) — default one extra attempt

    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // resolved concrete version (never "latest")
      status: "queued",
      ...(origin ? { origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}), // the runner — the "who" paired with origin (the "where")
      ...(input.runtime ? { runtime: input.runtime } : {}), // placed runtime (work-queue axis) — unset = default backend
      ...(subset ? { subset } : {}), // partial-run marker — consumers know it's "not the whole thing"
      // Everything a re-drive needs (restart resume / retry-failed) — persisted at submit so the batch can be
      // reconstructed after a control-plane restart. docs/architecture/batch-resilience.md
      orchestration: { judges: input.judges ?? [], ...(judge ? { judge } : {}), concurrency, retries },
      createdAt: ts,
      updatedAt: ts,
    };

    await this.deps.store.create(record);
    // Server-side supersede — reclaim any in-flight batch for the same PR (origin.repo+prNumber) × same (harness, dataset) and
    // replace it with this fire. GitHub-side concurrency only cancels the "workflow" while an already-submitted batch keeps running on the server
    // (preventing an orphaned eval from tying up environments/budget/runner queue). merge/dev fires (no prNumber) are out of scope.
    if (origin?.repo && origin.prNumber !== undefined) {
      await this.supersedeInFlight(input.tenant, origin.repo, origin.prNumber, input.harness.id, dataset.id, record.id);
    }
    // Batch-on-Temporal: when the driver is configured, a durable workflow owns the driver loop (the record is
    // stamped with its workflowId so boot recovery leaves it alone). A failed START degrades gracefully to the
    // in-process loop — the batch must never silently hang on a Temporal outage.
    if (this.deps.temporalBatches) {
      const workflowId = this.deps.temporalBatches.workflowIdFor(record.id);
      await this.deps.store.update(record.id, {
        orchestration: { ...(record.orchestration ?? { judges: [], concurrency, retries }), workflowId },
        updatedAt: this.now(),
      });
      try {
        await this.deps.temporalBatches.start(record.id);
        return (await this.deps.store.get(record.id)) ?? record;
      } catch {
        // Strip the workflow claim and fall through to the in-process loop.
        await this.deps.store.update(record.id, {
          orchestration: record.orchestration ?? { judges: [], concurrency, retries },
          updatedAt: this.now(),
        });
      }
    }
    void this.track(
      record.id,
      input.tenant,
      input.submittedBy ?? input.tenant, // owner — clone a private-repo case via the submitter's personal connection
      dataset,
      input.harness.id,
      harnessVersion,
      harnessSpec,
      input.judges ?? [],
      input.runtime,
      judge,
      // Request parallelism takes precedence, else the service default. Positive integers only (the boundary is enforced by the route/MCP via Zod).
      concurrency,
      { retries },
    );
    return record;
  }

  // Terminate any queued/running batch under the same (repo, PR, harness, dataset) key as superseded and send an abort signal.
  // Mark status/error first (track's termination respects the aborted guard) + stop firing remaining cases. Already-fired cases
  // complete naturally and are recorded on their child run (not a force-kill). superseded is not succeeded, so baseline/leaderboard stay clean.
  // Cancel a superseded batch's Temporal workflow (cooperative, best-effort — the record is already marked).
  private async cancelWorkflowIfAny(rec: ScorecardRecord | undefined): Promise<void> {
    if (!rec?.orchestration?.workflowId || !this.deps.temporalBatches?.cancel) return;
    await this.deps.temporalBatches.cancel(rec.id).catch(() => {});
  }

  private async supersedeInFlight(
    tenant: string,
    repo: string,
    prNumber: number,
    harnessId: string,
    datasetId: string,
    newId: string,
  ): Promise<void> {
    const candidates: ScorecardRecord[] = [];
    for (const status of ["queued", "running"] as const) {
      candidates.push(...(await this.deps.store.list(tenant, { status, dataset: datasetId, harness: harnessId })));
    }
    for (const r of candidates) {
      if (r.id === newId) continue;
      if (r.origin?.repo?.toLowerCase() !== repo.toLowerCase() || r.origin?.prNumber !== prNumber) continue;
      await this.deps.store.update(r.id, {
        status: "superseded",
        error: { code: "SUPERSEDED", message: `Replaced by a newer fire of the same PR (${newId})` },
        updatedAt: this.now(),
      });
      this.inFlight.get(r.id)?.abort(); // don't fire remaining cases (cooperative) — track attaches partial results and terminates
      await this.cancelWorkflowIfAny(r); // temporal-owned batch → cancel the workflow too (best-effort)
    }
  }

  // A dispatched scorecard doesn't embed the heavy scorecard (case results), storing only runIds (storage dedup) →
  // get hydrates the scorecard from the child runs' final results (response shape/web/diff identical to the embed era).
  // If an embed already exists (no-runStore / ingest / old record), return it as-is. Without a runStore, hydration is impossible → as-is.
  async get(id: string): Promise<ScorecardRecord | undefined> {
    const record = await this.deps.store.get(id);
    if (!record || record.scorecard || !record.runIds?.length || !this.deps.runStore) return record;
    const children = await this.deps.runStore.list(record.tenant, { scorecardId: id });
    const results = children.map((c) => c.result).filter((r): r is CaseResult => r !== undefined);
    if (results.length === 0) return record;
    const harness = `${record.harness.id}@${record.harness.version}`;
    return { ...record, scorecard: { suiteId: record.dataset.id, harness, results } };
  }

  list(tenant?: string): Promise<ScorecardRecord[]> {
    return this.deps.store.list(tenant);
  }

  // Restart resume — re-drive an interrupted (queued/running) batch from where it stopped: keep the child runs that
  // finished (status=succeeded with a stored result), re-dispatch everything else. Boot recovery calls this instead of
  // tombstoning the batch. Returns false when the record can't be faithfully resumed (no orchestration field — pre-mig
  // records — or the dataset/subset no longer resolves); the caller falls back to the old INTERRUPTED tombstone.
  // docs/architecture/batch-resilience.md
  async resume(id: string): Promise<boolean> {
    const rec = await this.deps.store.get(id);
    if (!rec || (rec.status !== "queued" && rec.status !== "running") || !rec.orchestration) return false;
    // A Temporal-owned batch owns itself: the workflow's activity retries ride out a control-plane restart, so
    // boot recovery must neither tombstone nor double-drive it.
    if (rec.orchestration.workflowId) return true;
    let dataset: Dataset;
    let seed: CaseResult[] = [];
    const seedRunIds: string[] = [];
    try {
      const resolved = await this.deps.datasets.get(rec.tenant, rec.dataset.id, rec.dataset.version);
      // Re-apply the recorded selection — ids/tags/limit selection is deterministic, so the same knobs give the same cases.
      const { cases } = selectSubsetCases(
        resolved,
        rec.subset ? { ids: rec.subset.ids, tags: rec.subset.tags, limit: rec.subset.limit } : undefined,
      );
      dataset = { ...resolved, cases };
      if (this.deps.runStore) {
        const children = await this.deps.runStore.list(rec.tenant, { scorecardId: id });
        // Latest child per case wins (a batch resumed more than once has several children for a re-run case).
        const latestByCase = new Map<string, (typeof children)[number]>();
        for (const c of children) {
          const prev = latestByCase.get(c.caseId);
          if (!prev || c.updatedAt > prev.updatedAt) latestByCase.set(c.caseId, c);
        }
        for (const c of latestByCase.values()) {
          if (c.status === "succeeded" && c.result) {
            seed.push(c.result);
            seedRunIds.push(c.id);
          } else if (c.status === "running" || c.status === "queued") {
            // Mid-flight when the process died — superseded by the re-dispatch below.
            await this.deps.runStore.update(c.id, {
              status: "failed",
              error: {
                code: "INTERRUPTED",
                message: "Interrupted by a control-plane restart — re-dispatched on resume.",
              },
              updatedAt: this.now(),
            });
          }
        }
        // Only seed cases that are still in the selection (dataset edits between runs shrink, never corrupt).
        const selected = new Set(dataset.cases.map((c) => c.id));
        const keep = seed.map((r, i) => [r, seedRunIds[i]] as const).filter(([r]) => selected.has(r.caseId));
        seed = keep.map(([r]) => r);
        seedRunIds.length = 0;
        seedRunIds.push(...keep.map(([, rid]) => rid).filter((x): x is string => x !== undefined));
      }
    } catch {
      return false; // dataset/subset no longer resolves — not faithfully resumable
    }
    // Harness spec re-resolve at the recorded concrete version (+ the recorded ephemeral pins, if any).
    let harnessSpec: HarnessSpec | undefined;
    const pins = rec.origin?.pinOverrides;
    if (this.deps.harnesses) {
      try {
        harnessSpec =
          pins && Object.keys(pins).length > 0
            ? await this.deps.harnesses.resolveWithPins(rec.tenant, rec.harness.id, rec.harness.version, pins)
            : await this.deps.harnesses.get(rec.tenant, rec.harness.id, rec.harness.version);
      } catch {
        // unregistered/built-in → no spec embedded (same as submit)
      }
    }
    const remaining = dataset.cases.length - seed.length;
    void this.track(
      id,
      rec.tenant,
      rec.createdBy ?? rec.tenant,
      dataset,
      rec.harness.id,
      rec.harness.version,
      harnessSpec,
      rec.orchestration.judges,
      rec.runtime,
      rec.orchestration.judge,
      rec.orchestration.concurrency,
      {
        seed,
        seedRunIds,
        retries: rec.orchestration.retries,
        resumeNote: `Resumed after a control-plane restart — ${seed.length} finished case(s) kept, ${remaining} re-dispatched`,
      },
    );
    return true;
  }

  // --- Batch-on-Temporal internals (called by the workflow via the internal routes; the CP owns execution/
  // scoring/streaming, the workflow owns driver-loop durability — docs/architecture/temporal-batch-orchestration.md).
  // Per-batch resolved context, built by planBatch and reused per case (601 registry hits otherwise). Rebuilt
  // lazily after a CP restart; stepChain serializes progress-timeline appends across concurrent case calls.
  private readonly batchContexts = new Map<
    string,
    {
      tenant: string;
      owner: string;
      dataset: Dataset;
      harnessId: string;
      harnessVersion: string;
      harnessSpec?: HarnessSpec;
      judges: Array<{ id: string; version: string }>;
      judge?: JudgeRunConfig;
      retries: number;
      concurrency: number;
      secretMap?: HarnessSecretMaps;
      caseIndex: Map<string, EvalCase>; // placement target already assigned (stable round-robin by selected index)
      doneIds: Set<string>;
      stepChain: Promise<void>;
    }
  >();

  private async buildBatchContext(id: string): Promise<NonNullable<ReturnType<typeof this.batchContexts.get>>> {
    const rec = await this.deps.store.get(id);
    if (!rec) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const orch = rec.orchestration;
    if (!orch) throw new BadRequestError("BAD_REQUEST", { scorecard: id }, "This batch has no orchestration inputs.");
    const resolved = await this.deps.datasets.get(rec.tenant, rec.dataset.id, rec.dataset.version);
    const { cases } = selectSubsetCases(
      resolved,
      rec.subset ? { ids: rec.subset.ids, tags: rec.subset.tags, limit: rec.subset.limit } : undefined,
    );
    // Sharding: same comma-list round-robin as the in-process loop, keyed by the SELECTED index so a re-plan after
    // a restart assigns every case the same target it had before.
    const targets = (rec.runtime ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const caseIndex = new Map<string, EvalCase>();
    cases.forEach((c, i) => {
      const target = targets.length > 0 ? targets[i % targets.length] : undefined;
      caseIndex.set(c.id, target ? { ...c, placement: { ...c.placement, target } } : c);
    });
    let harnessSpec: HarnessSpec | undefined;
    const pins = rec.origin?.pinOverrides;
    if (this.deps.harnesses) {
      try {
        harnessSpec =
          pins && Object.keys(pins).length > 0
            ? await this.deps.harnesses.resolveWithPins(rec.tenant, rec.harness.id, rec.harness.version, pins)
            : await this.deps.harnesses.get(rec.tenant, rec.harness.id, rec.harness.version);
      } catch {
        // unregistered/built-in → no spec embedded (same as submit)
      }
    }
    const owner = rec.createdBy ?? rec.tenant;
    const secretMap =
      harnessSpec && this.deps.scopedSecretsFor ? await this.deps.scopedSecretsFor(rec.tenant, owner) : undefined;
    const doneIds = new Set<string>();
    if (this.deps.runStore) {
      const children = await this.deps.runStore.list(rec.tenant, { scorecardId: id });
      const latest = new Map<string, (typeof children)[number]>();
      for (const c of children) {
        const prev = latest.get(c.caseId);
        if (!prev || c.updatedAt > prev.updatedAt) latest.set(c.caseId, c);
      }
      for (const c of latest.values()) if (c.status === "succeeded" && c.result) doneIds.add(c.caseId);
    }
    const ctx = {
      tenant: rec.tenant,
      owner,
      dataset: { ...resolved, cases } as Dataset,
      harnessId: rec.harness.id,
      harnessVersion: rec.harness.version,
      ...(harnessSpec ? { harnessSpec } : {}),
      judges: orch.judges,
      ...(orch.judge ? { judge: orch.judge } : {}),
      retries: orch.retries,
      concurrency: orch.concurrency,
      ...(secretMap ? { secretMap } : {}),
      caseIndex,
      doneIds,
      stepChain: Promise.resolve(),
    };
    this.batchContexts.set(id, ctx);
    return ctx;
  }

  // Serialized progress-step append (read-modify-write on record.steps is racy across concurrent case calls).
  private appendBatchStep(id: string, step: Omit<ScorecardStep, "ts">): Promise<void> {
    const ctx = this.batchContexts.get(id);
    const doAppend = async (): Promise<void> => {
      const rec = await this.deps.store.get(id);
      if (!rec) return;
      await this.deps.store.update(id, {
        steps: [...(rec.steps ?? []), { ts: this.now(), ...step }],
        updatedAt: this.now(),
      });
    };
    if (!ctx) return doAppend();
    ctx.stepChain = ctx.stepChain.then(doAppend, doAppend);
    return ctx.stepChain;
  }

  // planBatch — resolve the remaining work (idempotent: a re-attached workflow gets only unfinished cases).
  async planBatch(id: string): Promise<{ caseIds: string[]; concurrency: number }> {
    const ctx = await this.buildBatchContext(id);
    const remaining = [...ctx.caseIndex.keys()].filter((cid) => !ctx.doneIds.has(cid));
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    await this.appendBatchStep(id, {
      phase: "dispatch",
      status: "started",
      message: `Running ${remaining.length} case(s) via Temporal workflow${ctx.doneIds.size > 0 ? ` (${ctx.doneIds.size} finished case(s) kept)` : ""}`,
    });
    return { caseIds: remaining, concurrency: ctx.concurrency };
  }

  // runBatchCase — execute + settle exactly one case (idempotent). Mirrors the in-process track dispatch closure:
  // budget admit → child run → secret resolve → executeCase (CP-side transient retry by failure class) → settle →
  // per-case judges → progress step. Kept deliberately parallel to track() — the two drivers share every primitive
  // (executeCase, classifyFailure, applyJudges, billing), only the loop ownership differs.
  async runBatchCase(id: string, caseId: string): Promise<{ settled: boolean; skipped?: boolean }> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    // Superseded mid-flight (a newer fire reclaimed this batch) — don't spend more compute/LLM on it. The workflow
    // is cancelled cooperatively by supersede; this guard covers activities already in the queue.
    if ((await this.deps.store.get(id))?.status === "superseded") return { settled: true, skipped: true };
    if (ctx.doneIds.has(caseId)) return { settled: true, skipped: true };
    const evalCase = ctx.caseIndex.get(caseId);
    if (!evalCase) throw new NotFoundError("NOT_FOUND", { scorecard: id, caseId }, "case not in this batch.");

    this.deps.budget?.admit(ctx.tenant);
    const runStore = this.deps.runStore;
    let childId: string | undefined;
    if (runStore) {
      childId = this.newId();
      const ts = this.now();
      await runStore.create({
        id: childId,
        tenant: ctx.tenant,
        harness: { id: ctx.harnessId, version: ctx.harnessVersion },
        caseId,
        status: "running",
        parentScorecardId: id,
        trigger: "scorecard",
        ...(evalCase.placement?.target ? { runtime: evalCase.placement.target } : {}),
        createdAt: ts,
        updatedAt: ts,
      });
    }
    const baseJob: AgentJob = {
      evalCase,
      harness: { id: ctx.harnessId, version: ctx.harnessVersion },
      tenant: ctx.tenant,
      ...(ctx.owner ? { submittedBy: ctx.owner } : {}),
      ...(ctx.harnessSpec ? { harnessSpec: ctx.harnessSpec } : {}),
      ...(ctx.judge ? { judge: ctx.judge } : {}),
    };
    let result: CaseResult | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const jobToRun =
          ctx.secretMap && baseJob.harnessSpec
            ? { ...baseJob, harnessSpec: resolveHarnessSecrets(baseJob.harnessSpec, ctx.secretMap) }
            : baseJob;
        result = await executeCase(this.deps, ctx.owner, jobToRun);
        break;
      } catch (err) {
        const failure = classifyFailure(err, "dispatch");
        if (attempt >= ctx.retries || !failure.retryable) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            caseId,
            harness: `${ctx.harnessId}@${ctx.harnessVersion}`,
            trace: [{ t: 0, kind: "error", message }],
            snapshot: { kind: "prompt", output: "" },
            scores: [
              { graderId: "dispatch", metric: "error", value: 0, pass: false, detail: `[${failure.class}] ${message}` },
            ],
            failure,
          };
          break;
        }
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
    }
    const bill = billingTenant(result, ctx.tenant);
    if (bill) this.deps.budget?.settle(bill, costOf(result));
    // Per-case judge scoring — the same "judge the moment the case lands" semantics as the in-process judge stream.
    if (ctx.judges.length > 0) {
      await this.scoring.applyJudges(ctx.tenant, ctx.dataset, [result], ctx.judges).catch(() => {});
    }
    if (runStore && childId) await runStore.update(childId, { status: "succeeded", result, updatedAt: this.now() });
    ctx.doneIds.add(caseId);
    const v = caseVerdict(result);
    const reason = caseReason(result);
    const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
    await this.appendBatchStep(id, {
      phase: "case",
      status: v === false ? "failed" : "ok",
      message: `${caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
      caseId,
    });
    return { settled: true };
  }

  // finalizeBatch — aggregate the children into the final record (summary/models/judges/export) and notify.
  async finalizeBatch(id: string): Promise<void> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    const rec = await this.deps.store.get(id);
    if (!rec) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const children = this.deps.runStore ? await this.deps.runStore.list(ctx.tenant, { scorecardId: id }) : [];
    const latest = new Map<string, (typeof children)[number]>();
    for (const c of children) {
      const prev = latest.get(c.caseId);
      if (!prev || c.updatedAt > prev.updatedAt) latest.set(c.caseId, c);
    }
    const order = new Map([...ctx.caseIndex.keys()].map((cid, i) => [cid, i] as const));
    const results = [...latest.values()]
      .map((c) => c.result)
      .filter((r): r is CaseResult => r !== undefined)
      .sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));
    const scorecard: Scorecard = {
      suiteId: rec.dataset.id,
      harness: `${ctx.harnessId}@${ctx.harnessVersion}`,
      results,
    };
    await this.offloadResults(id, results);
    // Trace-sink export (batched at finalize on the Temporal path — per-case export streaming stays in-process-only).
    const exported = this.deps.exportResults
      ? await this.deps
          .exportResults(
            ctx.tenant,
            { scorecardId: id, dataset: `${rec.dataset.id}@${rec.dataset.version}`, harness: scorecard.harness },
            results,
          )
          .catch(() => undefined)
      : undefined;
    const declared = ctx.harnessSpec?.kind === "command" ? ctx.harnessSpec.model : undefined;
    const judgeModels = await this.scoring.collectJudgeModels(ctx.tenant, ctx.judges, ctx.judge);
    const runIds = [...latest.values()].map((c) => c.id);
    await this.appendBatchStep(id, { phase: "persist", status: "ok", message: "aggregated and persisted (temporal)" });
    const final = await this.deps.store.get(id);
    await this.deps.store.update(id, {
      status: "succeeded",
      summary: summarizeScorecard(scorecard),
      models: scorecardModels(scorecard, declared),
      ...(judgeModels.length > 0 ? { judgeModels } : {}),
      ...(exported ? { export: exported } : {}),
      steps: final?.steps ?? [],
      ...(runIds.length > 0 ? { runIds } : { scorecard }),
      updatedAt: this.now(),
    });
    this.batchContexts.delete(id);
    if (this.deps.onComplete) {
      const done = await this.deps.store.get(id);
      if (done) await this.deps.onComplete(ctx.tenant, done).catch(() => {});
    }
  }

  // Retry-failed — a NEW scorecard that re-runs only the failed cases of a terminal batch and carries the passing
  // results over verbatim (full, directly comparable case set; origin.retryOf keeps the lineage). The source record
  // is never mutated — eval history stays immutable. docs/architecture/batch-resilience.md
  async retryFailed(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    // Failure-class filter — re-run only the cases that died in that class (e.g. "infra" after a cluster incident:
    // agent FAILs are legitimate results and stay carried over). Unset = every non-passing case (previous behavior).
    failureClass?: "infra" | "config" | "harness" | "agent";
  }): Promise<ScorecardRecord> {
    const src = await this.get(input.id); // hydrated (results from child runs when stored as references)
    if (!src || src.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "scorecard not found.");
    if (src.status !== "succeeded" && src.status !== "failed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: input.id, status: src.status },
        "Only a finished batch can be retried — wait for it to finish (or resume handles interruptions).",
      );
    const results = src.scorecard?.results ?? [];
    if (results.length === 0)
      throw new BadRequestError("BAD_REQUEST", { scorecard: input.id }, "This batch has no per-case results to retry.");
    // Class selection: a result with a classified failure matches its class; a plain grader FAIL (no failure field)
    // is the agent's own outcome → class "agent". Unset = every non-passing case.
    const classOf = (r: CaseResult): string | undefined =>
      caseVerdict(r) === true ? undefined : (r.failure?.class ?? "agent");
    const failed = results.filter((r) =>
      input.failureClass ? classOf(r) === input.failureClass : caseVerdict(r) !== true,
    );
    if (failed.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: input.id, ...(input.failureClass ? { failureClass: input.failureClass } : {}) },
        input.failureClass
          ? `Nothing to retry — no ${input.failureClass}-class failures in this batch.`
          : "Nothing to retry — every case passed.",
      );
    const retryIds = new Set(failed.map((r) => r.caseId));
    const seed = results.filter((r) => !retryIds.has(r.caseId));

    const resolved = await this.deps.datasets.get(input.tenant, src.dataset.id, src.dataset.version);
    const { cases } = selectSubsetCases(
      resolved,
      src.subset ? { ids: src.subset.ids, tags: src.subset.tags, limit: src.subset.limit } : undefined,
    );
    const dataset: Dataset = { ...resolved, cases };

    let harnessSpec: HarnessSpec | undefined;
    const pins = src.origin?.pinOverrides;
    if (this.deps.harnesses) {
      try {
        harnessSpec =
          pins && Object.keys(pins).length > 0
            ? await this.deps.harnesses.resolveWithPins(input.tenant, src.harness.id, src.harness.version, pins)
            : await this.deps.harnesses.get(input.tenant, src.harness.id, src.harness.version);
      } catch {
        // unregistered/built-in → no spec embedded (same as submit)
      }
    }

    // Pre-orchestration source records still retry — with no judges/judge on file, re-run cases get grader scores only.
    const orch = src.orchestration ?? { judges: [], concurrency: this.concurrency, retries: 1 };
    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: src.harness,
      status: "queued",
      origin: { source: "api", ...(src.origin ?? {}), retryOf: src.id },
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(src.runtime ? { runtime: src.runtime } : {}),
      ...(src.subset ? { subset: src.subset } : {}),
      orchestration: orch,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.track(
      record.id,
      input.tenant,
      input.submittedBy ?? input.tenant,
      dataset,
      src.harness.id,
      src.harness.version,
      harnessSpec,
      orch.judges,
      src.runtime,
      orch.judge,
      orch.concurrency,
      {
        seed,
        retries: orch.retries,
        resumeNote: `Retry of ${src.id} — re-running ${failed.length} failed case(s), ${seed.length} passing result(s) carried over`,
      },
    );
    return record;
  }

  // Trace ingest — create a scorecard from traces already produced externally (harness not run). Resolve dataset (404 if missing) → queued → async scoring.
  async ingest(input: IngestScorecardInput): Promise<ScorecardRecord> {
    const dataset = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
    const harnessVersion = input.harness.version || "latest";
    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // the harness that produced the trace (label)
      status: "queued",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.trackIngest(
      record.id,
      input.tenant,
      dataset,
      `${input.harness.id}@${harnessVersion}`,
      input.traces,
      input.judges ?? [],
    );
    return record;
  }

  // pull ingest — pull per-runId traces from the tenant's OTel/MLflow and create a scorecard. Resolve dataset (404 if missing) → queued → async.
  async ingestPull(input: PullIngestInput): Promise<ScorecardRecord> {
    const dataset = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
    const harnessVersion = input.harness.version || "latest";
    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // the harness that produced the trace (label)
      status: "queued",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.trackPull(
      record.id,
      input.tenant,
      dataset,
      `${input.harness.id}@${harnessVersion}`,
      input.source,
      input.runs,
      input.judges ?? [],
    );
    return record;
  }

  // baseline vs candidate comparison — metric deltas over the same cases + pass transitions (regression/improvement). Both must be owned by this workspace and complete.
  async diff(tenant: string, baselineId: string, candidateId: string): Promise<ScorecardDiff> {
    const baseline = await this.requireSucceeded(tenant, baselineId);
    const candidate = await this.requireSucceeded(tenant, candidateId);
    return diffScorecards(baseline, candidate);
  }

  // Time-range trend / regression-over-time — line up a (dataset, metric)'s scorecards chronologically and flag regressions vs the baseline.
  // Computed from the list (lightweight summary) alone — no heavy traces needed. ScorecardRecord structurally satisfies TrendCard.
  async trend(
    tenant: string,
    opts: { datasetId: string; metric: string; harnessId?: string; from?: string; to?: string; baseline?: string },
  ): Promise<ScorecardTrend> {
    // Narrow at the SQL level by dataset (+optional harness)·succeeded — avoid a full workspace scan (suite defensively re-filters).
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return trendSeries(records, opts);
  }

  // Per-benchmark (dataset) leaderboard — group a dataset's scorecards by (harness × model) and rank by metric.
  // Computed from the list (lightweight summary+models) alone — no heavy traces needed. ScorecardRecord structurally satisfies LeaderboardCard.
  async leaderboard(
    tenant: string,
    opts: {
      datasetId: string;
      metric: string;
      harnessId?: string;
      model?: string;
      judgeModel?: string;
      window?: "latest" | "best";
    },
  ): Promise<Leaderboard> {
    // Narrow at the SQL level by dataset (+optional harness)·succeeded — summary-derived axes like model/judgeModel/window are filtered by suite.
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return leaderboard(records, opts);
  }

  // model-axis backfill — derive the observed model from the stored trace of (old) succeeded scorecards that lack models yet, and fill it in.
  // idempotent: skip if models already present. The trace is the source of truth, so observation only (no declared fallback). It's bulk, so get only what's needed.
  async backfillModels(tenant: string): Promise<{ scanned: number; updated: number }> {
    const records = await this.deps.store.list(tenant); // list includes models (lightweight) → can tell whether they already exist
    let updated = 0;
    for (const r of records) {
      if (r.models || r.status !== "succeeded") continue; // already filled, or no output
      const full = await this.deps.store.get(r.id); // the trace lives only inside the heavy scorecard
      if (!full?.scorecard) continue;
      await this.deps.store.update(r.id, { models: scorecardModels(full.scorecard), updatedAt: this.now() });
      updated += 1;
    }
    return { scanned: records.length, updated };
  }

  // Ensure workspace scope + completion (scorecard exists). 404 if missing (no existence leak), 400 if incomplete.
  private async requireSucceeded(tenant: string, id: string): Promise<Scorecard> {
    const record = await this.get(id); // get hydrates dedup storage from child runs — diff works regardless of embed/reference
    if (!record || record.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
    if (!record.scorecard)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, status: record.status },
        `scorecard '${id}' is not complete yet (status=${record.status}).`,
      );
    return record.scorecard;
  }

  // Reflect the case results finalized by batch judge/offload into each child run (since we don't store the embed, get's hydration source must be current).
  // Update each result onto its run via the caseId → childId mapping.
  private async writeBackResults(caseToChild: Map<string, string>, results: CaseResult[]): Promise<void> {
    const store = this.deps.runStore;
    if (!store) return;
    for (const r of results) {
      const childId = caseToChild.get(r.caseId);
      if (childId) await store.update(childId, { result: r, updatedAt: this.now() });
    }
  }

  private async track(
    id: string,
    tenant: string,
    owner: string, // submitter subject — for resolving private-repo case tokens (personally-owned connection)
    dataset: Dataset,
    harnessId: string,
    harnessVersion: string,
    harnessSpec: HarnessSpec | undefined,
    judges: Array<{ id: string; version: string }>,
    runtime: string | undefined,
    judge: JudgeRunConfig | undefined,
    concurrency: number, // number of cases to dispatch concurrently (request override→service default is resolved in submit).
    // Re-drive support (docs/architecture/batch-resilience.md):
    //  seed        — finished CaseResults carried in verbatim (restart resume: done children · retry-failed: source passes).
    //                Seeded cases are NOT re-dispatched, re-judged, or re-exported; they merge into the final scorecard.
    //  seedRunIds  — the child-run ids behind the seeds (kept in record.runIds so get() hydration still sees every case).
    //  retries     — transient dispatch retries per case (throw-only).
    //  resumeNote  — a timeline step explaining why this track run starts mid-way.
    opts: { seed?: CaseResult[]; seedRunIds?: string[]; retries?: number; resumeNote?: string } = {},
  ): Promise<void> {
    // If supersede already reclaimed this batch, don't start (prevents reviving queued→superseded back to running).
    if ((await this.deps.store.get(id))?.status === "superseded") return;
    // Register the cooperative-cancellation handle — when supersedeInFlight aborts, runSuite stops firing remaining cases.
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    // Progress (step) timeline — append as the run proceeds + persist incrementally so the web shows "how far / what" it's doing.
    const steps: ScorecardStep[] = [];
    const pushStep = (p: string, status: ScorecardStep["status"], message: string, caseId?: string): void => {
      steps.push({ ts: this.now(), phase: p, status, message, ...(caseId ? { caseId } : {}) });
    };
    const flushSteps = (): Promise<unknown> => this.deps.store.update(id, { steps: [...steps], updatedAt: this.now() });
    const seed = opts.seed ?? [];
    const seedRunIds = opts.seedRunIds ?? [];
    // Seeds carried WITHOUT child-run backing (retry-failed carries another scorecard's results) can't be
    // hydrated from this batch's children — those batches embed the full scorecard alongside runIds.
    const seedChildBacked = seedRunIds.length >= seed.length;
    const seededIds = new Set(seed.map((r) => r.caseId));
    if (opts.resumeNote) pushStep("resume", "info", opts.resumeNote);
    // Child runs this batch fanned out: caseId → childId (when runStore is set). Used after completion for the final write-back + storing runIds references.
    const caseToChild = new Map<string, string>();
    // Once per batch: shared + submitter (owner) personal secret maps (if any). Just before dispatching a case, resolve {secretRef} in the harness env by scope
    // — no plaintext remains in the registry spec; it's injected only at run time. If a referenced secret is missing, that case fails with a clear reason.
    const secretMap =
      harnessSpec && this.deps.scopedSecretsFor ? await this.deps.scopedSecretsFor(tenant, owner) : undefined;
    // Per-case dispatch (orchestration per case): admit (per-case since it's a batch) → enrich the job → pure executeCase → settle.
    // The pure execution (token resolve+attach → dispatch) is handled by executeCase (shared with a single run); settlement/child-run lifecycle is handled by the orchestration here.
    // When runStore is set, create a child run (RunRecord) per case so each case becomes an addressable run (trace/usage/provenance).
    const dispatch: Dispatch = async (job) => {
      this.deps.budget?.admit(tenant); // throws if over budget → batch fails
      const enriched: AgentJob = {
        ...job,
        tenant,
        // owner (submitter subject) — self-hosted runner dispatch-ownership check + lease-queue key (same as a single run).
        ...(owner ? { submittedBy: owner } : {}),
        ...(harnessSpec ? { harnessSpec } : {}),
        ...(judge ? { judge } : {}),
      };
      const runStore = this.deps.runStore;
      // Child run (if any): create as running. Tagged with parentScorecardId, hidden from the activity list by default.
      let childId: string | undefined;
      if (runStore) {
        childId = this.newId();
        const ts = this.now();
        await runStore.create({
          id: childId,
          tenant,
          harness: { id: harnessId, version: harnessVersion },
          caseId: job.evalCase.id,
          status: "running",
          parentScorecardId: id,
          trigger: "scorecard",
          ...(runtime ? { runtime } : {}), // propagate the batch's runtime to the child too — the queue's runtime-lane axis
          createdAt: ts,
          updatedAt: ts,
        });
        caseToChild.set(job.evalCase.id, childId);
      }
      try {
        // Resolve env secret references (just before dispatch). If a referenced secret is missing, resolveHarnessSecrets throws → this case is isolated as a failure.
        const jobToRun =
          secretMap && enriched.harnessSpec
            ? { ...enriched, harnessSpec: resolveHarnessSecrets(enriched.harnessSpec, secretMap) }
            : enriched;
        const result = await executeCase(this.deps, owner, jobToRun);
        // Cost attribution: managed=batch tenant · workspace-shared runner=that workspace (team resource) · personal runner=own-pays. Same as a single run.
        const bill = billingTenant(result, tenant);
        if (bill) this.deps.budget?.settle(bill, costOf(result));
        if (runStore && childId) await runStore.update(childId, { status: "succeeded", result, updatedAt: this.now() });
        return result;
      } catch (err) {
        if (runStore && childId) {
          const error =
            err instanceof AppError
              ? { code: err.code, message: err.message }
              : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
          await runStore.update(childId, { status: "failed", error, updatedAt: this.now() });
        }
        throw err; // rethrow so runSuite isolates the case (freezing it into a failed CaseResult)
      }
    };
    // On failure, diagnose "in which phase" — track the pipeline phase so catch records it as error.phase.
    let phase = "dispatch";
    let scorecard: Scorecard | undefined;
    try {
      // When a runtime is selected, inject it as each case's placement.target → RuntimeDispatcher routes to the tenant runtime.
      // A comma-separated list SHARDS the batch: cases round-robin across the listed runtimes (per-case placement,
      // per-case failure isolation unchanged) — one 601-case batch can drain a Nomad pool and a K8s pool at once.
      // Seeded cases (already-finished results carried in by resume/retry) are excluded from dispatch entirely.
      const casesToRun = seed.length > 0 ? dataset.cases.filter((c) => !seededIds.has(c.id)) : dataset.cases;
      const targets = runtime
        ? runtime
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      const cases =
        targets.length > 0
          ? casesToRun.map((c, i) => ({
              ...c,
              placement: { ...c.placement, target: targets[i % targets.length] as string },
            }))
          : casesToRun;
      const suite: Suite = { id: dataset.id, harness: { id: harnessId }, cases };
      // judge streaming — fire a case's judge the moment it finishes, without waiting for the whole batch to complete
      // (case-axis parallel·bounded). Removes the barrier where the slowest case blocked judging of the rest.
      // docs/architecture/streaming-case-pipeline.md
      const judgeStream = await this.scoring.createJudgeStream(tenant, dataset, judges, runtime);
      // sink-export streaming (D5) — if the harness selected a sink, export each case to the team platform the moment it completes (after judging)
      // (live visibility + whatever went out survives even if the batch dies midway). If not wired,
      // the success path below falls back to exportResults (batched) (no regression).
      const exportCtx = {
        scorecardId: id,
        dataset: `${dataset.id}@${dataset.version}`,
        harness: `${harnessId}@${harnessVersion}`,
      };
      const exportStream = this.deps.exportStreamFor
        ? await this.deps.exportStreamFor(tenant, exportCtx).catch(() => undefined)
        : undefined;
      pushStep(
        "dispatch",
        "started",
        `Running ${cases.length} case(s)${seed.length > 0 ? ` (${seed.length} finished result(s) carried over)` : ""}`,
      );
      await flushSteps();
      // onResult: as each case finishes (completion order), record PASS/FAIL + reason as a step — the heart of "progress".
      scorecard = await runSuite(suite, harnessVersion, dispatch, {
        concurrency,
        ...(opts.retries !== undefined ? { retries: opts.retries } : {}), // transient dispatch retry (throw-only)
        signal: controller.signal, // on supersede, don't fire remaining cases (already-fired cases complete naturally)
        onResult: (r) => {
          const v = caseVerdict(r);
          const reason = caseReason(r);
          const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
          pushStep(
            "case",
            v === false ? "failed" : "ok",
            `${r.caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
            r.caseId,
          );
          void flushSteps();
          // After supersede, skip firing judges too (don't spend more LLM cost on a reclaimed batch).
          if (!controller.signal.aborted) {
            const judged = judgeStream.push(r);
            // Case-completion chaining: export the case only 'after' its judge score is attached — skip new fires after abort
            // (already-fired exports complete naturally; the supersede path joins them and records a partial outcome).
            if (exportStream) {
              void judged.then(() => {
                if (!controller.signal.aborted) exportStream.push(r);
              });
            }
          }
        },
      });
      // Merge carried-over results back in (dataset case order) — seeds were already judged/exported on their
      // original run, so they bypass the judge/export streams (which only ever saw the re-run cases).
      if (seed.length > 0) {
        const order = new Map(dataset.cases.map((c, i) => [c.id, i] as const));
        scorecard = {
          ...scorecard,
          results: [...seed, ...scorecard.results].sort(
            (a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0),
          ),
        };
      }
      pushStep("dispatch", "ok", `Dispatch complete — ${scorecard.results.length} case(s)`);
      await flushSteps();
      // Superseded — a newer fire reclaimed this batch. Skip the remaining pipeline (judge/offload/notify) and
      // terminate as superseded with only partial results attached (not succeeded, so baseline/leaderboard stay clean).
      if (controller.signal.aborted) {
        // Join already-fired judge tasks before persisting (prevents a race between in-progress scores mutation and write-back).
        // A judge error on a reclaimed batch is noise — swallow it.
        await judgeStream.settle().catch(() => {});
        // Exports already sent via streaming are joined and recorded as a partial outcome (for tracking — superseded ≠ succeeded,
        // so baseline/leaderboard stay clean). If no cases went out, skip recording (an empty outcome is noise).
        const exportedPartial = exportStream ? await exportStream.settle().catch(() => undefined) : undefined;
        pushStep(
          "supersede",
          "info",
          "Replaced by a newer fire of the same PR — remaining cases not fired, only partial results kept",
        );
        const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
        if (hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
        await this.deps.store.update(id, {
          status: "superseded",
          ...(scorecard.results.length > 0 ? { summary: summarizeScorecard(scorecard) } : {}),
          ...(exportedPartial?.cases?.length ? { export: exportedPartial } : {}),
          steps: [...steps],
          ...(hasChildren && seedChildBacked
            ? { runIds: [...seedRunIds, ...caseToChild.values()] }
            : { scorecard, ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}) }),
          updatedAt: this.now(),
        });
        this.inFlight.delete(id);
        return; // completion notification for a replaced batch is noise — skip
      }
      // runtime = the placement of the producing run → co-locate the judge on the same runtime (judge next to the artifacts). The ingest path has no producing run.
      // Since it's streaming, most overlap with dispatch and are already done — this is just joining the remaining tasks.
      // Task errors rethrow here → attributed to error.phase="judges" as before.
      phase = "judges";
      if (judges.length > 0) {
        pushStep("judges", "started", `${judges.length} judge kind(s) — joining remaining streaming tasks`);
        await flushSteps();
      }
      await judgeStream.settle(); // trace → judge scores (control plane, streamed the moment each case completes)
      if (judges.length > 0) {
        pushStep("judges", "ok", "judges applied");
        await flushSteps();
      }
      phase = "offload";
      await this.offloadResults(id, scorecard.results); // os-use screenshots → object storage (slim record)
      // Trace-sink export (when configured) — even if it fails, the scorecard succeeds (recorded via outcome.status only, no error.phase).
      // With streaming (exportStream), cases already went out right after judging — here it's just joining remaining tasks + summing the outcome.
      // If not wired, fall back to the current batched export. TraceSinkService already doesn't throw, but isolate here too just in case.
      const exported = exportStream
        ? await exportStream.settle().catch(() => undefined)
        : this.deps.exportResults
          ? await this.deps.exportResults(tenant, exportCtx, scorecard.results).catch(() => undefined)
          : undefined;
      if (exported) pushStep("export", exported.status === "failed" ? "failed" : "ok", exportStepMessage(exported));
      phase = "persist";
      const summary = summarizeScorecard(scorecard);
      // leaderboard model axis: trace observation preferred + spec declaration (command harness only) fallback.
      const declared = harnessSpec?.kind === "command" ? harnessSpec.model : undefined;
      const models = scorecardModels(scorecard, declared);
      // leaderboard judge axis: the judge model(s) that scored this run — inline config + registered model-judge spec.
      const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, judge);
      pushStep("persist", "ok", "aggregated and persisted");
      // If there are child runs: write back the judge/offload-finalized results to the children, then store only runIds instead of the heavy embed
      //  → get hydrates from the children (storage dedup, response shape unchanged). Without children (no runStore), embed as before.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      if (hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
      await this.deps.store.update(id, {
        // If supersede arrived mid-pipeline (judge/offload), don't revive to succeeded — all results attach, but
        // the newer fire is the answer for this PR, so terminate as superseded (leaderboard/baseline see only the new one).
        status: controller.signal.aborted ? "superseded" : "succeeded",
        summary,
        models,
        ...(judgeModels.length > 0 ? { judgeModels } : {}),
        ...(exported ? { export: exported } : {}),
        steps: [...steps],
        ...(hasChildren && seedChildBacked
          ? { runIds: [...seedRunIds, ...caseToChild.values()] }
          : { scorecard, ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}) }),
        updatedAt: this.now(),
      });
    } catch (err) {
      const base =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      pushStep(phase, "failed", base.message);
      // Preserve partial results — on a post-dispatch (judge/offload) failure, persist the case results already gathered for visibility.
      // With child runs, mirror the success path: runIds references (partial) instead of embed + write back results to the children.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      if (scorecard && hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
      const declared = harnessSpec?.kind === "command" ? harnessSpec.model : undefined;
      await this.deps.store.update(id, {
        // A failure after supersede isn't reported as a failure (a reclaimed batch's leftover errors are noise) — keep superseded.
        status: controller.signal.aborted ? "superseded" : "failed",
        error: { ...base, phase },
        steps: [...steps],
        ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}),
        ...(scorecard
          ? {
              summary: summarizeScorecard(scorecard),
              models: scorecardModels(scorecard, declared),
              ...(hasChildren ? {} : { scorecard }), // with children, skip embed (get hydrates)
            }
          : {}),
        updatedAt: this.now(),
      });
    }
    this.inFlight.delete(id);
    // Completion notification (Mattermost etc.) — using the latest record. A failure is independent of the scorecard result (swallow). Replaced batches skip the notification.
    if (this.deps.onComplete && !controller.signal.aborted) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(tenant, rec).catch(() => {});
    }
  }

  // push ingest: pass the uploaded traces straight to finishIngest.
  private async trackIngest(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    traces: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    try {
      await this.finishIngest(id, tenant, dataset, harnessLabel, traces, judges);
    } catch (err) {
      await this.failIngest(id, err);
    }
  }

  // pull ingest: pull per-runId traces from the tenant's trace source (OTel/MLflow) and pass to finishIngest.
  private async trackPull(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    source: PullIngestBody["source"],
    runs: PullIngestBody["runs"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    try {
      if (!this.deps.buildTraceSource)
        throw new BadRequestError("BAD_REQUEST", {}, "trace source builder is not configured (pull disabled).");
      // credential: source.authSecret name → inject the tenant SecretStore value verbatim as the Authorization header.
      // The value includes the scheme (e.g. "Bearer <token>" [OTel/Jaeger] or "Basic <base64>" [MLflow]) — don't hardcode the scheme.
      let headers: Record<string, string> | undefined;
      if (source.authSecret) {
        const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
        const token = secrets[source.authSecret];
        if (token) headers = { authorization: token };
      }
      const src = this.deps.buildTraceSource({
        kind: source.kind,
        endpoint: source.endpoint,
        ...(headers ? { headers } : {}),
        // credential 'value' for the newer sources (langfuse/langsmith/phoenix) — the adapter owns the header name.
        ...(headers?.authorization ? { auth: headers.authorization } : {}),
        ...(source.project ? { project: source.project } : {}),
      });
      const perCase: IngestScorecardBody["traces"] = [];
      for (const r of runs) {
        const trace = await src.fetch(r.runId); // an external failure is UpstreamError → catch → failed
        perCase.push({ caseId: r.caseId, trace });
      }
      // attach hint: the original trace already lives on the source platform — if the sink is the same platform, attach scores only instead of duplicating (flow ②).
      await this.finishIngest(id, tenant, dataset, harnessLabel, perCase, judges, {
        sourceKind: source.kind,
        externalIdByCase: Object.fromEntries(runs.map((r) => [r.caseId, r.runId])),
      });
    } catch (err) {
      await this.failIngest(id, err);
    }
  }

  // Shared: perCase traces → CaseResult (re-derive trace graders + uploaded scores) → judge → aggregate and persist (succeeded). Failures throw.
  // attach = the pull path's original coordinates (source kind + caseId→external runId) — if the trace sink is the same platform, attach scores only.
  private async finishIngest(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    perCase: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<void> {
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    const results: CaseResult[] = [];
    for (const up of perCase) {
      const evalCase = caseById.get(up.caseId);
      if (!evalCase) continue; // skip caseIds not in the dataset (can't align)
      const snapshot = up.snapshot ?? { kind: "repo", diff: "", changedFiles: [], headSha: "ingested" };
      const ctx: GradeContext = { case: evalCase, trace: up.trace, snapshot };
      // Re-derive trace-only graders (steps/cost/latency) — same metrics as a live run for diff alignment.
      const derived = await Promise.all([stepsGrader, costGrader, latencyGrader].map((g) => g.grade(ctx)));
      results.push({
        caseId: up.caseId,
        harness: harnessLabel,
        trace: up.trace,
        snapshot,
        scores: [...derived, ...(up.scores ?? [])],
      });
    }
    const scorecard: Scorecard = { suiteId: dataset.id, harness: harnessLabel, results };
    await this.scoring.applyJudges(tenant, dataset, results, judges); // trace → judge scores (control plane)
    await this.offloadResults(id, results); // os-use screenshots → object storage (slim record)
    // Trace-sink export (when configured) — same place as the live batch (after scoring). pull attaches scores only to the original trace via attach.
    const exported = this.deps.exportResults
      ? await this.deps
          .exportResults(
            tenant,
            { scorecardId: id, dataset: `${dataset.id}@${dataset.version}`, harness: harnessLabel },
            results,
            attach,
          )
          .catch(() => undefined)
      : undefined;
    const summary = summarizeScorecard(scorecard);
    // ingest doesn't resolve the harness spec → the model axis comes from observation (trace) only.
    const models = scorecardModels(scorecard);
    // judge axis: ingest has no inline judge, so only the models of the applied registered judges.
    const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, undefined);
    await this.deps.store.update(id, {
      status: "succeeded",
      scorecard,
      summary,
      models,
      ...(judgeModels.length > 0 ? { judgeModels } : {}),
      ...(exported ? { export: exported } : {}),
      updatedAt: this.now(),
    });
  }

  private async failIngest(id: string, err: unknown): Promise<void> {
    const error =
      err instanceof AppError
        ? { code: err.code, message: err.message }
        : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
    await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
  }

  // Offload os-use screenshots (inline base64) to object storage → each result snapshot.screenshotRef=URL, screenshot cleared (slim
  // record). best-effort: on failure keep the base64 (no effect on the scorecard itself). Called after applyJudges (once registry judges have used the image).
  private async offloadResults(id: string, results: CaseResult[]): Promise<void> {
    if (!this.deps.artifacts) return;
    for (const r of results) {
      try {
        r.snapshot = await offloadSnapshot(r.snapshot, this.deps.artifacts, `scorecards/${id}/${r.caseId}.png`);
      } catch {}
    }
  }
}
