import type { TraceSink, TraceSinkConfig } from "@everdict/contracts";
import { LangfuseTraceSink } from "./langfuse-sink.js";
import { LangsmithTraceSink } from "./langsmith-sink.js";
import { MlflowTraceSink } from "./mlflow-sink.js";
import { PhoenixTraceSink } from "./phoenix-sink.js";

// Config → TraceSink adapter. The control plane builds the workspace sink after scorecard grading completes (credentials via the auth value).
// Symmetric with buildTraceSource (inbound) — only kind differs, the assembly is identical.
export function buildTraceSink(cfg: TraceSinkConfig): TraceSink {
  const opts = {
    endpoint: cfg.endpoint,
    ...(cfg.auth ? { auth: cfg.auth } : {}),
    ...(cfg.project ? { project: cfg.project } : {}),
    ...(cfg.webUrl ? { webUrl: cfg.webUrl } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };
  switch (cfg.kind) {
    case "mlflow":
      return new MlflowTraceSink(opts);
    case "langfuse":
      return new LangfuseTraceSink(opts);
    case "langsmith":
      return new LangsmithTraceSink(opts);
    case "phoenix":
      return new PhoenixTraceSink(opts);
  }
}
