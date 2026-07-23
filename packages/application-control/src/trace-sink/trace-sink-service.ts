import type { CaseResult } from "@everdict/contracts";
import type { ScorecardExport, TraceSink, TraceSinkCase, TraceSinkConfig } from "@everdict/contracts";
import { createLimiter } from "../concurrency/limiter.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";
import { traceAuthorizationCredential } from "../trace-source/authorization-credential.js";
import { unifiedTraceSources } from "../trace-source/trace-source-service.js";

// Trace-sink EXPORT executor — the outbound half of the pipeline. Registration is NOT here: a workspace registers ONE
// pool of trace sources (TraceSourceService); "export to X" is a per-harness selection (traceSinkByHarness: harness id →
// trace-source name) over that pool, resolved here after scorecard grading. A sink-capable source (kind ≠ otel) becomes
// a TraceSinkConfig at point of use; the auth VALUE is resolved from the SecretStore transiently. Export failure never
// fails the scorecard (isolated outcome). Design: docs/architecture/trace-sink.md + docs/architecture/streaming-case-pipeline.md D5.

export interface TraceSinkServiceDeps {
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // authSecretName → value resolve (workspace SecretStore)
  buildSink?: (cfg: TraceSinkConfig) => TraceSink; // config → adapter (@everdict/trace buildTraceSink). If not injected, export is disabled
  exportConcurrency?: number; // concurrency cap for the case-axis export (default 2) — protects the sink's rate limit
  now?: () => string;
}

// Case streaming export handle — the batch pushes each case as soon as it completes (after judging), and settle, after joining
// all tasks, aggregates into the same ScorecardExport shape as the existing exportScorecard (record schema/web display unchanged).
// A push task never throws — an export failure lands only in the outcome (isolated from the scorecard).
export interface CaseExportStream {
  push(result: CaseResult): void;
  settle(): Promise<ScorecardExport>;
}

type SinkCaseOutcome = NonNullable<ScorecardExport["cases"]>[number];

export class TraceSinkService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly deps: TraceSinkServiceDeps = {},
  ) {}

  // Case streaming export — the batch pushes each case as soon as it completes (after judging) so cases appear on the team's
  // platform one at a time (no waiting for the whole batch — live visibility + partial preservation on failure). Setup
  // (config/selection/secret/builder) happens once at stream creation. No selection / no builder / an otel source → undefined
  // (no-op, the opt-in semantics). Never throws.
  // attach: the pull ingest's (source.kind, caseId→external runId) — only when source and sink are the same platform, attach
  // scores to the original trace (flow ②, no duplication); otherwise fall back to create mode (same as flow ①).
  // docs/architecture/streaming-case-pipeline.md D5 + docs/architecture/trace-sink.md
  async exportStream(
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string; sinkOverride?: string },
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<CaseExportStream | undefined> {
    // Per-batch override wins over the harness selection; the literal "none" suppresses export for this batch.
    if (ctx.sinkOverride === "none") return undefined;
    const s = await this.settings.get(tenant);
    // ctx.harness = "id@version" — the export selection is per harness id (version-independent).
    const harnessId = ctx.harness.split("@")[0] ?? ctx.harness;
    const sourceName = ctx.sinkOverride ?? s?.traceSinkByHarness?.[harnessId];
    const source = sourceName ? unifiedTraceSources(s).find((e) => e.name === sourceName) : undefined;
    const buildSink = this.deps.buildSink;
    // otel is pull-only — it can never be an export target (assignSink blocks it; guard here too).
    if (!source || source.kind === "otel" || !buildSink) return undefined;
    const sinkKind = source.kind; // narrowed to mlflow|langfuse|langsmith|phoenix
    const exportedAt = (this.deps.now ?? (() => new Date().toISOString()))();

    // A setup failure (e.g. secret not registered) makes the stream "failure-outcome-only" — pushes are ignored and settle returns the reason.
    let impl: TraceSink | undefined;
    let initError: string | undefined;
    try {
      let auth: string | undefined;
      if (source.authSecretName) {
        const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
        const value = secrets[source.authSecretName];
        if (!value)
          initError = `No value for '${source.authSecretName}' in the SecretStore — register the secret first.`;
        else auth = traceAuthorizationCredential(sinkKind, value);
      }
      if (!initError) {
        impl = buildSink({
          kind: sinkKind,
          endpoint: source.endpoint,
          ...(auth ? { auth } : {}),
          ...(source.project ? { project: source.project } : {}),
          ...(source.webUrl ? { webUrl: source.webUrl } : {}),
        });
      }
    } catch (err) {
      initError = err instanceof Error ? err.message : String(err);
    }
    const ids = attach && attach.sourceKind === sinkKind ? attach.externalIdByCase : undefined;
    const toSinkCase = (r: CaseResult): TraceSinkCase => {
      const externalId = ids?.[r.caseId];
      return {
        caseId: r.caseId,
        trace: r.trace,
        scores: r.scores.map((sc) => ({
          name: sc.metric,
          value: sc.value,
          ...(sc.pass !== undefined ? { pass: sc.pass } : {}),
          ...(typeof sc.detail === "string" && sc.detail !== "" ? { comment: sc.detail } : {}),
        })),
        ...(externalId ? { externalId } : {}),
      };
    };

    const limit = createLimiter(this.deps.exportConcurrency ?? 2);
    const tasks: Array<Promise<void>> = [];
    const outcomes: SinkCaseOutcome[] = []; // preserve push order (reserve a slot, then record asynchronously)
    let url: string | undefined;
    return {
      push: (result) => {
        const sinkImpl = impl;
        if (!sinkImpl) return; // prep failed — settle returns the reason (no case fired)
        const slot = outcomes.length;
        outcomes.push({ caseId: result.caseId, error: "incomplete" }); // reserve the slot — the task overwrites it
        tasks.push(
          limit(async () => {
            try {
              const out = await sinkImpl.export(ctx, [toSinkCase(result)]);
              url ??= out.url;
              outcomes[slot] = out.cases[0] ?? { caseId: result.caseId, error: "sink returned no result" };
            } catch (err) {
              // Per-case isolation — one case's upstream failure doesn't block other cases / the scorecard.
              outcomes[slot] = { caseId: result.caseId, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        );
      },
      settle: async () => {
        await Promise.all(tasks);
        if (initError) return { sink: sinkKind, name: source.name, status: "failed", message: initError, exportedAt };
        const failed = outcomes.filter((c) => c.error).length;
        const status = failed === 0 ? "succeeded" : failed === outcomes.length && failed > 0 ? "failed" : "partial";
        // On a total failure, promote the first error reason to the top (per-case calls mean even a wholesale outage is isolated to cases — reason promotion),
        // on a partial failure, a count summary (per-case reasons live in cases[].error).
        const message =
          status === "failed"
            ? outcomes.find((c) => c.error)?.error
            : failed > 0
              ? `${failed}/${outcomes.length} cases failed to export`
              : undefined;
        return {
          sink: sinkKind,
          name: source.name,
          status,
          ...(url ? { url } : {}),
          ...(message ? { message } : {}),
          exportedAt,
          cases: outcomes,
        };
      },
    };
  }

  // Export scored case results (trace+scores) to the source 'the harness selected' for export — the batch-consumer form
  // (paths where the results already exist, e.g. ingest). Internally pushes everything to the stream, then joins.
  async exportScorecard(
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string; sinkOverride?: string },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<ScorecardExport | undefined> {
    const stream = await this.exportStream(tenant, ctx, attach);
    if (!stream) return undefined;
    for (const r of results) stream.push(r);
    return stream.settle();
  }
}
