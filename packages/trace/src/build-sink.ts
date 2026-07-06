import { LangfuseTraceSink } from "./langfuse-sink.js";
import { LangsmithTraceSink } from "./langsmith-sink.js";
import { MlflowTraceSink } from "./mlflow-sink.js";
import { PhoenixTraceSink } from "./phoenix-sink.js";
import type { TraceSink, TraceSinkConfig } from "./trace-sink.js";

// 설정 → TraceSink 어댑터. 컨트롤플레인이 스코어카드 채점 완료 후 워크스페이스 싱크를 만든다(자격증명은 auth 값으로).
// buildTraceSource(인바운드)와 대칭 — kind 만 다르고 조립 방식은 동일.
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
