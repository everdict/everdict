import type { TraceSource, TraceSourceConfig } from "@everdict/contracts";
import { LangfuseTraceSource } from "./langfuse-source.js";
import { LangsmithTraceSource } from "./langsmith-source.js";
import { MlflowTraceSource } from "./mlflow.js";
import { OtelTraceSource } from "./otel.js";
import { PhoenixTraceSource } from "./phoenix-source.js";

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
        ...(cfg.mapping ? { mapping: cfg.mapping } : {}),
      });
    case "mlflow":
      return new MlflowTraceSource({
        ...opts,
        ...(cfg.correlate ? { correlate: cfg.correlate } : {}),
        ...(cfg.project ? { experimentIds: [cfg.project] } : {}),
        ...(cfg.mapping ? { mapping: cfg.mapping } : {}),
      });
    case "langfuse":
      return new LangfuseTraceSource(authOpts);
    case "langsmith":
      return new LangsmithTraceSource(authOpts);
    case "phoenix":
      return new PhoenixTraceSource({ ...authOpts, ...(cfg.project ? { project: cfg.project } : {}) });
  }
}
