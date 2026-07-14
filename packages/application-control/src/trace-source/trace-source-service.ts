import { BadRequestError, type TraceSourceConfig, type WorkspaceSettings } from "@everdict/contracts";
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
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // authSecretName → value resolve (workspace SecretStore) — used only in resolve()
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

  // Resolve the source a harness selected → a fully-built TraceSourceConfig (auth value pulled from the SecretStore),
  // for the dispatch path to build a TraceSource and pull the case's trace after the run. undefined = no selection (the
  // caller falls back to the harness's inline spec.traceSource or no pull). The auth VALUE lives only here, transiently.
  async resolve(tenant: string, harnessId: string): Promise<TraceSourceConfig | undefined> {
    const s = await this.settings.get(tenant);
    const name = s?.traceSourceByHarness?.[harnessId];
    const source = name ? (s?.traceSources ?? []).find((e) => e.name === name) : undefined;
    if (!source) return undefined;
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
    // otel/mlflow read auth from headers.authorization; langfuse/langsmith/phoenix inherit it as `auth` (buildTraceSource).
    // So the single headers.authorization mapping covers all five kinds (the adapter owns the actual header name).
    return {
      kind: source.kind,
      endpoint: source.endpoint,
      ...(auth ? { headers: { authorization: auth } } : {}),
      correlate: source.correlate,
      ...(source.service ? { service: source.service } : {}),
      ...(source.project ? { project: source.project } : {}),
    };
  }
}
