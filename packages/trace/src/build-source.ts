import { LangfuseTraceSource } from "./langfuse-source.js";
import { LangsmithTraceSource } from "./langsmith-source.js";
import { MlflowTraceSource } from "./mlflow.js";
import { OtelTraceSource } from "./otel.js";
import { PhoenixTraceSource } from "./phoenix-source.js";
import type { TraceSource } from "./trace-source.js";

export interface TraceSourceConfig {
  kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  headers?: Record<string, string>; // 테넌트 자격증명(예: Authorization: Bearer ...). SecretStore 에서 주입.
  // 자격증명 '값'(SecretStore 에서 resolve) — 헤더 이름은 어댑터가 플랫폼 관례대로 소유
  // (langfuse/phoenix: Authorization 그대로, langsmith: x-api-key). otel/mlflow 는 기존 headers 경로 유지.
  auth?: string;
  project?: string; // phoenix 스팬 조회 경로에 필수(프로젝트 이름/ID). 그 외 kind 는 무시.
  fetchImpl?: typeof fetch;
}

// 설정 → TraceSource 어댑터. 컨트롤플레인이 pull-ingest 시 테넌트의 trace source 를 만든다(자격증명은 headers/auth 로).
export function buildTraceSource(cfg: TraceSourceConfig): TraceSource {
  const opts = {
    endpoint: cfg.endpoint,
    ...(cfg.headers ? { headers: cfg.headers } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };
  // 신형 소스는 auth 값 주입(어댑터가 헤더 이름 소유). headers.authorization 만 온 경우도 값으로 승계한다.
  const auth = cfg.auth ?? cfg.headers?.authorization;
  const authOpts = {
    endpoint: cfg.endpoint,
    ...(auth ? { auth } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };
  switch (cfg.kind) {
    case "otel":
      return new OtelTraceSource(opts);
    case "mlflow":
      return new MlflowTraceSource(opts);
    case "langfuse":
      return new LangfuseTraceSource(authOpts);
    case "langsmith":
      return new LangsmithTraceSource(authOpts);
    case "phoenix":
      return new PhoenixTraceSource({ ...authOpts, ...(cfg.project ? { project: cfg.project } : {}) });
  }
}
