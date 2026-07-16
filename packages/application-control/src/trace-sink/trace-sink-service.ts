import { BadRequestError, type CaseResult } from "@everdict/contracts";
import type {
  ScorecardExport,
  TraceProbeConfig,
  TraceProbeResult,
  TraceSink,
  TraceSinkCase,
  TraceSinkConfig,
  WorkspaceSettings,
} from "@everdict/contracts";
import { createLimiter } from "../concurrency/limiter.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace trace-sink integration — outbound config to export judged scorecard detail results to the team's observability
// platform (MLflow/Langfuse/LangSmith/Phoenix). Sinks are registered as a plural roster keyed by name (a team may have several
// platforms), and which sink to export to is chosen per-harness (traceSinkByHarness: harness id → sink name; a harness with no
// selection is not exported — opt-in). No secrets: authSecretName is a SecretStore name reference, not a value, so it is safe to return. The HTTP route and MCP tool share this core.
// Design: docs/architecture/trace-sink.md

// A single sink's status (no secrets — all name references/URLs).
export interface TraceSinkConfigView {
  name: string;
  kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  authSecretName?: string;
  project?: string;
  webUrl?: string;
}

type TraceSinkEntry = NonNullable<WorkspaceSettings["traceSinks"]>[number];

export interface TraceSinkServiceDeps {
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // authSecretName → value resolve (workspace SecretStore)
  buildSink?: (cfg: TraceSinkConfig) => TraceSink; // config → adapter (@everdict/trace buildTraceSink). If not injected, export is disabled
  // Connection-test + scope-discovery engine (@everdict/trace probeTraceConnection), injected so application-control
  // stays free of @everdict/trace. Absent = the probe route/tool is feature-disabled.
  probeConnection?: (cfg: TraceProbeConfig) => Promise<TraceProbeResult>;
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

const toView = (s: TraceSinkEntry): TraceSinkConfigView => ({
  name: s.name,
  kind: s.kind,
  endpoint: s.endpoint,
  ...(s.authSecretName ? { authSecretName: s.authSecretName } : {}),
  ...(s.project ? { project: s.project } : {}),
  ...(s.webUrl ? { webUrl: s.webUrl } : {}),
});

export class TraceSinkService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly deps: TraceSinkServiceDeps = {},
  ) {}

  // The list of registered sinks + the per-harness selection state.
  async list(workspace: string): Promise<{ sinks: TraceSinkConfigView[]; assignments: Record<string, string> }> {
    const s = await this.settings.get(workspace);
    return {
      sinks: (s?.traceSinks ?? []).map(toView),
      assignments: s?.traceSinkByHarness ?? {},
    };
  }

  // Register/update (admin, name-keyed upsert — declarative full replace). Put the auth token (value) in the SecretStore first and specify only its name.
  async upsert(
    workspace: string,
    input: {
      name: string;
      kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
      endpoint: string;
      authSecretName?: string;
      project?: string;
      webUrl?: string;
    },
  ): Promise<TraceSinkConfigView> {
    const entry: TraceSinkEntry = {
      name: input.name,
      kind: input.kind,
      endpoint: input.endpoint,
      ...(input.authSecretName ? { authSecretName: input.authSecretName } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.webUrl ? { webUrl: input.webUrl } : {}),
    };
    const existing = (await this.settings.get(workspace))?.traceSinks ?? [];
    const next = [...existing.filter((s) => s.name !== input.name), entry];
    await this.settings.set(workspace, { traceSinks: next });
    return toView(entry);
  }

  // Remove (admin). Also cleans up harness selections that pointed at that sink (prevents dangling references).
  async remove(workspace: string, name: string): Promise<void> {
    const s = await this.settings.get(workspace);
    const next = (s?.traceSinks ?? []).filter((e) => e.name !== name);
    const assignments = Object.fromEntries(
      Object.entries(s?.traceSinkByHarness ?? {}).filter(([, sink]) => sink !== name),
    );
    await this.settings.set(workspace, { traceSinks: next, traceSinkByHarness: assignments });
  }

  // Per-harness sink selection (member+ — part of the harness config). sink=null clears the selection (turns export off).
  // An unknown sink name is 400 — never silently create a dangling reference.
  async assign(workspace: string, harnessId: string, sink: string | null): Promise<Record<string, string>> {
    const s = await this.settings.get(workspace);
    const known = new Set((s?.traceSinks ?? []).map((e) => e.name));
    if (sink !== null && !known.has(sink))
      throw new BadRequestError("BAD_REQUEST", { sink }, `Unregistered sink: ${sink}`);
    const assignments = { ...(s?.traceSinkByHarness ?? {}) };
    if (sink === null) delete assignments[harnessId];
    else assignments[harnessId] = sink;
    await this.settings.set(workspace, { traceSinkByHarness: assignments });
    return assignments;
  }

  // Connection test + scope discovery BEFORE registering (the web form gates Save on this). Resolves authSecretName to
  // a value like exportStream does, but a missing secret is a friendly {reachable:false, reason:"auth"} result rather
  // than a stream init-error. project isn't needed here — the probe discovers the platform's selectable scopes.
  async probe(
    workspace: string,
    input: { kind: "mlflow" | "langfuse" | "langsmith" | "phoenix"; endpoint: string; authSecretName?: string },
  ): Promise<TraceProbeResult> {
    if (!this.deps.probeConnection)
      throw new BadRequestError("BAD_REQUEST", {}, "Connection testing is not configured.");
    let auth: string | undefined;
    if (input.authSecretName) {
      const secrets = await (this.deps.secretsFor?.(workspace) ?? Promise.resolve<Record<string, string>>({}));
      auth = secrets[input.authSecretName];
      if (!auth)
        return {
          kind: input.kind,
          reachable: false,
          reason: "auth",
          detail: `No value for '${input.authSecretName}' in the SecretStore — save the secret first.`,
        };
    }
    return this.deps.probeConnection({ kind: input.kind, endpoint: input.endpoint, ...(auth ? { auth } : {}) });
  }

  // Case streaming export — the batch pushes each case as soon as it completes (after judging) so cases appear on the team's
  // platform one at a time (no waiting for the whole batch — live visibility + partial preservation on failure). Setup
  // (config/selection/secret/builder) happens once at stream creation. No selection / no builder → undefined (no-op, the current opt-in semantics). Never throws.
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
    // ctx.harness = "id@version" — sink selection is per harness id (version-independent).
    const harnessId = ctx.harness.split("@")[0] ?? ctx.harness;
    const sinkName = ctx.sinkOverride ?? s?.traceSinkByHarness?.[harnessId];
    const sink = sinkName ? (s?.traceSinks ?? []).find((e) => e.name === sinkName) : undefined;
    const buildSink = this.deps.buildSink;
    if (!sink || !buildSink) return undefined;
    const exportedAt = (this.deps.now ?? (() => new Date().toISOString()))();

    // A setup failure (e.g. secret not registered) makes the stream "failure-outcome-only" — pushes are ignored and settle returns the reason.
    let impl: TraceSink | undefined;
    let initError: string | undefined;
    try {
      let auth: string | undefined;
      if (sink.authSecretName) {
        const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
        auth = secrets[sink.authSecretName];
        if (!auth) initError = `No value for '${sink.authSecretName}' in the SecretStore — register the secret first.`;
      }
      if (!initError) {
        impl = buildSink({
          kind: sink.kind,
          endpoint: sink.endpoint,
          ...(auth ? { auth } : {}),
          ...(sink.project ? { project: sink.project } : {}),
          ...(sink.webUrl ? { webUrl: sink.webUrl } : {}),
        });
      }
    } catch (err) {
      initError = err instanceof Error ? err.message : String(err);
    }
    const ids = attach && attach.sourceKind === sink.kind ? attach.externalIdByCase : undefined;
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
        if (initError) return { sink: sink.kind, name: sink.name, status: "failed", message: initError, exportedAt };
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
          sink: sink.kind,
          name: sink.name,
          status,
          ...(url ? { url } : {}),
          ...(message ? { message } : {}),
          exportedAt,
          cases: outcomes,
        };
      },
    };
  }

  // Export scored case results (trace+scores) to the sink 'the harness selected' — the batch-consumer form (paths where
  // the results already exist, e.g. ingest). Internally pushes everything to the stream, then joins (the core is a single exportStream).
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
