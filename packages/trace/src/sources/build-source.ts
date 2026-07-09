import { LangfuseTraceSource } from "./langfuse-source.js";
import { LangsmithTraceSource } from "./langsmith-source.js";
import { MlflowTraceSource } from "./mlflow.js";
import { OtelTraceSource } from "./otel.js";
import { PhoenixTraceSource } from "./phoenix-source.js";
import type { TraceSource } from "./trace-source.js";

export interface TraceSourceConfig {
  kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  headers?: Record<string, string>; // tenant credentials (e.g. Authorization: Bearer ...). Injected from the SecretStore.
  // The credential 'value' (resolved from the SecretStore) — the header name is owned by the adapter per platform convention
  // (langfuse/phoenix: Authorization verbatim, langsmith: x-api-key). otel/mlflow keep the existing headers path.
  auth?: string;
  project?: string; // required for phoenix's span-query path (project name/ID) · experiment id for mlflow tag correlation. Ignored by other kinds.
  correlate?: "id" | "tag"; // mlflow/otel — "tag" finds the trace by searching the everdict.run_id tag (resource attribute) (default "id").
  service?: string; // search scope for otel tag correlation (the Jaeger service parameter). Ignored by other kinds.
  fetchImpl?: typeof fetch;
}

// Config → TraceSource adapter. The control plane builds the tenant's trace source on pull-ingest (credentials via headers/auth).
export function buildTraceSource(cfg: TraceSourceConfig): TraceSource {
  const opts = {
    endpoint: cfg.endpoint,
    ...(cfg.headers ? { headers: cfg.headers } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };
  // Newer sources take the auth value (the adapter owns the header name). A headers.authorization-only case is inherited as the value too.
  const auth = cfg.auth ?? cfg.headers?.authorization;
  const authOpts = {
    endpoint: cfg.endpoint,
    ...(auth ? { auth } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };
  switch (cfg.kind) {
    case "otel":
      return new OtelTraceSource({
        ...opts,
        ...(cfg.correlate ? { correlate: cfg.correlate } : {}),
        ...(cfg.service ? { service: cfg.service } : {}),
      });
    case "mlflow":
      return new MlflowTraceSource({
        ...opts,
        ...(cfg.correlate ? { correlate: cfg.correlate } : {}),
        ...(cfg.project ? { experimentIds: [cfg.project] } : {}),
      });
    case "langfuse":
      return new LangfuseTraceSource(authOpts);
    case "langsmith":
      return new LangsmithTraceSource(authOpts);
    case "phoenix":
      return new PhoenixTraceSource({ ...authOpts, ...(cfg.project ? { project: cfg.project } : {}) });
  }
}
