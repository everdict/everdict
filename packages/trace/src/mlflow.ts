import type { TraceEvent } from "@assay/core";
import { type Span, type TraceSource, spansToTraceEvents } from "./trace-source.js";

// MLflow tracing span (간략화): attributes 는 dict, 시간은 ns.
interface MlflowSpan {
  name?: string;
  start_time_unix_nano?: number | string;
  end_time_unix_nano?: number | string;
  attributes?: Record<string, unknown>;
}
interface MlflowTrace {
  spans?: MlflowSpan[];
}

function nanoToMs(v: number | string | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Math.floor(n / 1e6);
}

export function parseMlflowTrace(trace: MlflowTrace): Span[] {
  return (trace.spans ?? []).map((s) => ({
    name: s.name ?? "",
    startMs: nanoToMs(s.start_time_unix_nano),
    endMs: nanoToMs(s.end_time_unix_nano),
    attrs: s.attributes ?? {},
  }));
}

export interface MlflowTraceSourceOptions {
  endpoint: string;
  headers?: Record<string, string>; // 테넌트 자격증명 등(예: Authorization). SecretStore 에서 주입.
  fetchImpl?: typeof fetch; // 테스트 주입
}

// MLflow tracing REST 에서 trace(runId)를 가져와 TraceEvent 로 정규화.
export class MlflowTraceSource implements TraceSource {
  constructor(private readonly opts: MlflowTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/2.0/mlflow/traces/${encodeURIComponent(runId)}`, {
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    // 트레이스가 아직 없거나(404) 인증·서버 오류면 빈 트레이스로 degrade — 그레이더는 0건으로 평가.
    if (!res.ok) return [];
    let body: { trace?: MlflowTrace };
    try {
      body = (await res.json()) as { trace?: MlflowTrace };
    } catch {
      return [];
    }
    return spansToTraceEvents(parseMlflowTrace(body.trace ?? {}));
  }
}
