import {
  BadRequestError,
  type BrowsableTraceSource,
  type ListTracesOptions,
  NotFoundError,
  type SpanAttrMapping,
  type TraceInspectResult,
  type TraceProbeConfig,
  type TraceProbeResult,
  type TraceSourceConfig,
  type TraceSummary,
  type WorkspaceSettings,
} from "@everdict/contracts";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Workspace trace-source integration — the INBOUND mirror of TraceSinkService. A trace source is a dev-cluster
// observability endpoint (OTel/MLflow/Langfuse/LangSmith/Phoenix) registered as a plural roster keyed by name (a team
// may have several platforms), and which source to PULL from is chosen per-harness (traceSourceByHarness: harness id →
// source name; a harness with no selection falls back to its inline spec.traceSource — opt-in). No secrets are
// returned: authSecretName is a SecretStore name reference, resolved to a value only inside resolve() at pull time.
// The HTTP route and MCP tool share this core. Design: docs/architecture/trace-sink.md (inbound) + docs/service-harness.md.

// A single source's status (no secrets — all name references/URLs).
export interface TraceSourceConfigView {
  name: string;
  kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  authSecretName?: string;
  correlate: "id" | "tag";
  service?: string;
  project?: string;
}

type TraceSourceEntry = NonNullable<WorkspaceSettings["traceSources"]>[number];

export interface TraceSourceServiceDeps {
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // authSecretName → value resolve (workspace SecretStore) — used in resolve()/probe()
  // Connection-test + scope-discovery engine (@everdict/trace probeTraceConnection), injected so application-control
  // stays free of @everdict/trace. Absent = the probe route/tool is feature-disabled.
  probeConnection?: (cfg: TraceProbeConfig) => Promise<TraceProbeResult>;
  // Config → BrowsableTraceSource adapter (@everdict/trace buildTraceSource), injected so application-control stays free
  // of @everdict/trace. Powers listTraces()/inspect() (the observability browser + judge-wizard sampling). Absent =
  // those routes/tools are feature-disabled.
  buildSource?: (cfg: TraceSourceConfig) => BrowsableTraceSource;
}

const toView = (s: TraceSourceEntry): TraceSourceConfigView => ({
  name: s.name,
  kind: s.kind,
  endpoint: s.endpoint,
  ...(s.authSecretName ? { authSecretName: s.authSecretName } : {}),
  correlate: s.correlate,
  ...(s.service ? { service: s.service } : {}),
  ...(s.project ? { project: s.project } : {}),
});

export class TraceSourceService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly deps: TraceSourceServiceDeps = {},
  ) {}

  // The list of registered sources + the per-harness selection state.
  async list(workspace: string): Promise<{ sources: TraceSourceConfigView[]; assignments: Record<string, string> }> {
    const s = await this.settings.get(workspace);
    return {
      sources: (s?.traceSources ?? []).map(toView),
      assignments: s?.traceSourceByHarness ?? {},
    };
  }

  // Register/update (admin, name-keyed upsert — declarative full replace). Put the auth token (value) in the SecretStore
  // first and specify only its name. correlate defaults to "id" (the runId is the trace id). "tag" needs the agent to
  // tag its own trace with everdict.run_id; otel "tag" additionally needs `service`, mlflow/phoenix `project`.
  async upsert(
    workspace: string,
    input: {
      name: string;
      kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
      endpoint: string;
      authSecretName?: string;
      correlate?: "id" | "tag";
      service?: string;
      project?: string;
    },
  ): Promise<TraceSourceConfigView> {
    const correlate = input.correlate ?? "id";
    // Fail-fast on an incoherent tag-correlation config rather than a runtime pull error later.
    if (correlate === "tag" && input.kind === "otel" && !input.service)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name: input.name },
        "otel correlate:'tag' requires `service` (the agent's service.name for the Jaeger search).",
      );
    if (correlate === "tag" && (input.kind === "mlflow" || input.kind === "phoenix") && !input.project)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name: input.name, kind: input.kind },
        `${input.kind} correlate:'tag' requires \`project\` (the search scope).`,
      );
    const entry: TraceSourceEntry = {
      name: input.name,
      kind: input.kind,
      endpoint: input.endpoint,
      ...(input.authSecretName ? { authSecretName: input.authSecretName } : {}),
      correlate,
      ...(input.service ? { service: input.service } : {}),
      ...(input.project ? { project: input.project } : {}),
    };
    const existing = (await this.settings.get(workspace))?.traceSources ?? [];
    const next = [...existing.filter((s) => s.name !== input.name), entry];
    await this.settings.set(workspace, { traceSources: next });
    return toView(entry);
  }

  // Remove (admin). Also cleans up harness selections that pointed at that source (prevents dangling references).
  async remove(workspace: string, name: string): Promise<void> {
    const s = await this.settings.get(workspace);
    const next = (s?.traceSources ?? []).filter((e) => e.name !== name);
    const assignments = Object.fromEntries(
      Object.entries(s?.traceSourceByHarness ?? {}).filter(([, source]) => source !== name),
    );
    await this.settings.set(workspace, { traceSources: next, traceSourceByHarness: assignments });
  }

  // Per-harness source selection (member+ — part of the harness config). source=null clears the selection (pull falls
  // back to the inline spec.traceSource / none). An unknown source name is 400 — never a silent dangling reference.
  async assign(workspace: string, harnessId: string, source: string | null): Promise<Record<string, string>> {
    const s = await this.settings.get(workspace);
    const known = new Set((s?.traceSources ?? []).map((e) => e.name));
    if (source !== null && !known.has(source))
      throw new BadRequestError("BAD_REQUEST", { source }, `Unregistered source: ${source}`);
    const assignments = { ...(s?.traceSourceByHarness ?? {}) };
    if (source === null) delete assignments[harnessId];
    else assignments[harnessId] = source;
    await this.settings.set(workspace, { traceSourceByHarness: assignments });
    return assignments;
  }

  // Connection test + scope discovery BEFORE registering (the web form gates Save on this). Resolves authSecretName
  // to a value like resolve() does, but a missing secret is a friendly {reachable:false, reason:"auth"} result rather
  // than a throw (a probe classifies, it doesn't error). correlate/service/project aren't needed here — the probe
  // discovers them. The API upsert stays pure; only the web flow requires a successful probe.
  async probe(
    workspace: string,
    input: {
      kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
      endpoint: string;
      authSecretName?: string;
    },
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

  // A registered source entry → a fully-built TraceSourceConfig (auth value pulled from the SecretStore). The auth
  // VALUE lives only here, transiently. otel/mlflow read it from headers.authorization; langfuse/langsmith/phoenix
  // inherit it as `auth` (buildTraceSource). So the single headers.authorization mapping covers all five kinds.
  private async buildConfig(tenant: string, source: TraceSourceEntry): Promise<TraceSourceConfig> {
    let auth: string | undefined;
    if (source.authSecretName) {
      const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
      auth = secrets[source.authSecretName];
      if (!auth)
        throw new BadRequestError(
          "BAD_REQUEST",
          { source: source.name, secret: source.authSecretName },
          `No value for '${source.authSecretName}' in the SecretStore — register the secret first.`,
        );
    }
    return {
      kind: source.kind,
      endpoint: source.endpoint,
      ...(auth ? { headers: { authorization: auth } } : {}),
      correlate: source.correlate,
      ...(source.service ? { service: source.service } : {}),
      ...(source.project ? { project: source.project } : {}),
    };
  }

  // Resolve the source a harness selected → a fully-built TraceSourceConfig, for the dispatch path to build a
  // TraceSource and pull the case's trace after the run. undefined = no selection (the caller falls back to the
  // harness's inline spec.traceSource or no pull). The per-harness span-attribute mapping overlay (judge-wizard-
  // authored) is merged in here so the dispatch-after-judge collect normalizes the harness/judge's way — the same
  // conversion the pull-eval path applies.
  async resolve(tenant: string, harnessId: string): Promise<TraceSourceConfig | undefined> {
    const s = await this.settings.get(tenant);
    const name = s?.traceSourceByHarness?.[harnessId];
    const source = name ? (s?.traceSources ?? []).find((e) => e.name === name) : undefined;
    if (!source) return undefined;
    const config = await this.buildConfig(tenant, source);
    const mapping = s?.spanAttrMappingByHarness?.[harnessId];
    return mapping ? { ...config, mapping } : config;
  }

  // Build a browsable source for a registered source name (observability browser + judge-wizard sampling). 404 if the
  // name isn't registered; 400 if the browse engine isn't configured (buildSource dep absent).
  private async browsableFor(tenant: string, name: string): Promise<BrowsableTraceSource> {
    if (!this.deps.buildSource) throw new BadRequestError("BAD_REQUEST", {}, "Trace browsing is not configured.");
    const s = await this.settings.get(tenant);
    const source = (s?.traceSources ?? []).find((e) => e.name === name);
    if (!source) throw new NotFoundError("NOT_FOUND", { name }, `Unregistered trace source: ${name}`);
    return this.deps.buildSource(await this.buildConfig(tenant, source));
  }

  // Enumerate a registered source's recent traces (the browser/wizard list). scope defaults to the source's configured
  // scope (experiment/project/service) when omitted.
  async listTraces(tenant: string, name: string, opts?: ListTracesOptions): Promise<TraceSummary[]> {
    return (await this.browsableFor(tenant, name)).listTraces(opts);
  }

  // Inspect one trace by id — raw span attributes (span-based kinds) + the events normalized with the SUPPLIED mapping.
  // Powers the wizard's live mapping-authoring loop against a real picked trace.
  async inspect(tenant: string, name: string, traceId: string, mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    return (await this.browsableFor(tenant, name)).inspect(traceId, mapping);
  }
}
