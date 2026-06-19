import { MlflowTraceSource } from "./mlflow.js";
import { OtelTraceSource } from "./otel.js";
import type { TraceSource } from "./trace-source.js";

export interface TraceSourceConfig {
  kind: "otel" | "mlflow";
  endpoint: string;
  headers?: Record<string, string>; // 테넌트 자격증명(예: Authorization: Bearer ...). SecretStore 에서 주입.
  fetchImpl?: typeof fetch;
}

// 설정 → TraceSource 어댑터. 컨트롤플레인이 pull-ingest 시 테넌트의 trace source 를 만든다(자격증명은 headers 로).
export function buildTraceSource(cfg: TraceSourceConfig): TraceSource {
  const opts = {
    endpoint: cfg.endpoint,
    ...(cfg.headers ? { headers: cfg.headers } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };
  return cfg.kind === "mlflow" ? new MlflowTraceSource(opts) : new OtelTraceSource(opts);
}
