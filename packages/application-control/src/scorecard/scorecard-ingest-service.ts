import {
  AppError,
  BadRequestError,
  type CaseResult,
  type Dataset,
  type EnvSnapshot,
  type GradeContext,
  type Scorecard,
  type ScorecardRecord,
  type TraceEvidence,
  type TraceSourceConfig,
  toScores,
} from "@everdict/contracts";
import { ScorecardBatch, type ScorecardTransition, scorecardModels, summarizeScorecard } from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import {
  type IngestScorecardBody,
  type IngestScorecardInput,
  type PullIngestBody,
  type PullIngestInput,
  type ScorecardServiceDeps,
  offloadResults,
} from "./scorecard-shared.js";

// Evidence extracted from a pulled trace → the browser snapshot a judge reads (dom/screenshot/VLM), the pull-path
// substitute for the EnvSnapshot a live run produces. No browser evidence → undefined (finishIngest keeps its
// synthetic repo snapshot; the final answer rides the trace itself as an assistant message).
function snapshotFromEvidence(evidence: TraceEvidence | undefined): EnvSnapshot | undefined {
  if (!evidence) return undefined;
  if (evidence.dom === undefined && evidence.screenshot === undefined && evidence.screenshotRef === undefined)
    return undefined;
  return {
    kind: "browser",
    url: "",
    dom: evidence.dom ?? "",
    ...(evidence.screenshot ? { screenshot: evidence.screenshot } : {}),
    ...(evidence.screenshotRef ? { screenshotRef: evidence.screenshotRef } : {}),
    console: [],
  };
}

// Ingest collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md R2-b):
// the push (uploaded TraceEvent[]) and pull (tenant OTel/MLflow source) ingest lifecycles — score externally-run
// traces with no harness run. Composed only by the facade; shared plumbing (ids/clock/scoring) is handed in.
export class ScorecardIngestService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly scoring: ScoringService;

  constructor(
    private readonly deps: ScorecardServiceDeps,
    shared: { newId: () => string; now: () => string; scoring: ScoringService },
  ) {
    this.newId = shared.newId;
    this.now = shared.now;
    this.scoring = shared.scoring;
  }

  // Trace ingest — create a scorecard from traces already produced externally (harness not run). Resolve dataset (404 if missing) → queued → async scoring.
  async ingest(input: IngestScorecardInput): Promise<ScorecardRecord> {
    const dataset = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
    const harnessVersion = input.harness.version || "latest";
    // Record assembly is the domain's job (ScorecardBatch.newQueuedIngest) — the service only orchestrates.
    const record: ScorecardRecord = ScorecardBatch.newQueuedIngest({
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // the harness that produced the trace (label)
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      now: this.now(),
    });
    await this.deps.store.create(record);
    void this.trackIngest(
      record,
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
    const record: ScorecardRecord = ScorecardBatch.newQueuedIngest({
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // the harness that produced the trace (label)
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      now: this.now(),
    });
    await this.deps.store.create(record);
    void this.trackPull(
      record,
      input.tenant,
      dataset,
      `${input.harness.id}@${harnessVersion}`,
      input.harness.id,
      input.source,
      input.runs,
      input.judges ?? [],
    );
    return record;
  }

  // push ingest: pass the uploaded traces straight to finishIngest.
  private async trackIngest(
    record: ScorecardRecord,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    traces: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(record.id, ScorecardBatch.from(record).start(this.now()));
    try {
      await this.finishIngest(record.id, tenant, dataset, harnessLabel, traces, judges, undefined, record.createdBy);
    } catch (err) {
      await this.failIngest(record.id, err);
    }
  }

  // pull ingest: pull per-runId traces from the tenant's trace source (OTel/MLflow) and pass to finishIngest.
  private async trackPull(
    record: ScorecardRecord,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    harnessId: string,
    source: PullIngestBody["source"],
    runs: PullIngestBody["runs"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    const id = record.id;
    await this.deps.store.update(id, ScorecardBatch.from(record).start(this.now()));
    try {
      if (!this.deps.buildTraceSource)
        throw new BadRequestError("BAD_REQUEST", {}, "trace source builder is not configured (pull disabled).");
      // Source config — EITHER a registered workspace source (by name, "register once, pull by name") whose whole
      // connection (kind/endpoint/credential/scope) is resolved from the pool, OR an inline ad-hoc config.
      let base: TraceSourceConfig;
      if ("name" in source) {
        if (!this.deps.resolveTraceSourceByName)
          throw new BadRequestError(
            "BAD_REQUEST",
            {},
            "Named trace sources are not configured — pass an inline source config.",
          );
        base = await this.deps.resolveTraceSourceByName(tenant, source.name); // resolves auth from the SecretStore; unknown name → 400
      } else {
        // credential: source.authSecret name → inject the tenant SecretStore value verbatim as the Authorization header.
        // The value includes the scheme (e.g. "Bearer <token>" [OTel/Jaeger] or "Basic <base64>" [MLflow]) — don't hardcode the scheme.
        let headers: Record<string, string> | undefined;
        if (source.authSecret) {
          const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
          const token = secrets[source.authSecret];
          if (token) headers = { authorization: token };
        }
        base = {
          kind: source.kind,
          endpoint: source.endpoint,
          ...(headers ? { headers } : {}),
          // credential 'value' for the newer sources (langfuse/langsmith/phoenix) — the adapter owns the header name.
          ...(headers?.authorization ? { auth: headers.authorization } : {}),
          ...(source.project ? { project: source.project } : {}),
        };
      }
      // Per-harness conversion overlay (judge-wizard-authored) — production traces normalize the way this harness/judge
      // expect. This is the periodic-eval consumer of the same SpanAttrMapping the dispatch-after-judge path bakes.
      const mapping = await this.deps.spanMappingFor?.(tenant, harnessId);
      const src = this.deps.buildTraceSource({ ...base, ...(mapping ? { mapping } : {}) });
      const perCase: IngestScorecardBody["traces"] = [];
      for (const r of runs) {
        // fetchDetailed (when the source provides it) also extracts the mapping's evidence slots — an external
        // failure is UpstreamError → catch → failed.
        const detailed = src.fetchDetailed ? await src.fetchDetailed(r.runId) : { events: await src.fetch(r.runId) };
        const snapshot = snapshotFromEvidence(detailed.evidence);
        perCase.push({
          caseId: r.caseId,
          trace: detailed.events,
          ...(snapshot ? { snapshot } : {}),
          ...(detailed.evidence ? { evidence: detailed.evidence } : {}),
        });
      }
      // attach hint: the original trace already lives on the source platform — if the sink is the same platform, attach scores only instead of duplicating (flow ②).
      await this.finishIngest(
        id,
        tenant,
        dataset,
        harnessLabel,
        perCase,
        judges,
        {
          sourceKind: base.kind, // resolved kind (named source or inline) — for same-platform attach-only export
          externalIdByCase: Object.fromEntries(runs.map((r) => [r.caseId, r.runId])),
        },
        record.createdBy,
      );
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
    submittedBy?: string, // the ingest submitter — a code/harness judge with spec.runtime self:<runnerId> needs it to own the wrapper dispatch.
  ): Promise<void> {
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    const results: CaseResult[] = [];
    for (const up of perCase) {
      const evalCase = caseById.get(up.caseId);
      if (!evalCase) continue; // skip caseIds not in the dataset (can't align)
      const snapshot = up.snapshot ?? { kind: "repo", diff: "", changedFiles: [], headSha: "ingested" };
      const ctx: GradeContext = { case: evalCase, trace: up.trace, snapshot };
      // Re-derive trace-only graders (steps/cost/latency) — same metrics as a live run for diff alignment. The
      // grader impls live in @everdict/graders, which the application layer never imports; apps/api injects them
      // as defaultTraceGraders (re-architecture P2 S4). Absent = uploaded scores only (no derived trace metrics).
      const traceGraders = this.deps.defaultTraceGraders?.() ?? [];
      const derived = (await Promise.all(traceGraders.map((g) => g.grade(ctx)))).flatMap(toScores);
      results.push({
        caseId: up.caseId,
        harness: harnessLabel,
        trace: up.trace,
        snapshot,
        ...(up.evidence ? { evidence: up.evidence } : {}),
        scores: [...derived, ...(up.scores ?? [])],
      });
    }
    const scorecard: Scorecard = { suiteId: dataset.id, harness: harnessLabel, results };
    await this.scoring.applyJudges(tenant, dataset, results, judges, undefined, submittedBy); // trace → judge scores (control plane)
    await offloadResults(this.deps, id, results); // os-use screenshots → object storage (slim record)
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
    await this.settleIngest(id, (batch) =>
      batch.succeed(
        {
          scorecard,
          summary,
          models,
          ...(judgeModels.length > 0 ? { judgeModels } : {}),
          ...(exported ? { export: exported } : {}),
        },
        this.now(),
      ),
    );
  }

  private async failIngest(id: string, err: unknown): Promise<void> {
    const error =
      err instanceof AppError
        ? { code: err.code, message: err.message }
        : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
    await this.settleIngest(id, (batch) => batch.fail(error, {}, this.now()));
  }

  // Terminal writes go through the domain guard: read the current record and skip when it is already settled
  // (first terminal write wins — same idiom as RunService.finalize).
  private async settleIngest(id: string, outcome: (batch: ScorecardBatch) => ScorecardTransition): Promise<void> {
    const current = await this.deps.store.get(id);
    if (!current) return;
    const batch = ScorecardBatch.from(current);
    if (batch.isTerminal()) return;
    await this.deps.store.update(id, outcome(batch));
  }
}
