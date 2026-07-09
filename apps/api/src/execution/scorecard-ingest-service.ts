import {
  AppError,
  BadRequestError,
  type CaseResult,
  type Dataset,
  type GradeContext,
  type Scorecard,
} from "@everdict/core";
import type { ScorecardRecord } from "@everdict/db";
import { costGrader, latencyGrader, stepsGrader } from "@everdict/graders";
import { scorecardModels, summarizeScorecard } from "@everdict/suite";
import {
  type IngestScorecardBody,
  type IngestScorecardInput,
  type PullIngestBody,
  type PullIngestInput,
  type ScorecardServiceDeps,
  offloadResults,
} from "./scorecard-shared.js";
import type { ScoringService } from "./scoring-service.js";

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
}
