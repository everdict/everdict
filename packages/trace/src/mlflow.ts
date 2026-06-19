import { type TraceEvent, UpstreamError } from "@assay/core";
import { type Span, type TraceSource, spansToTraceEvents } from "./trace-source.js";

// MLflow 3.x 트레이스 REST 의 스팬 속성은 OTLP-스타일 AnyValue(snake_case) 배열 — OTel(camelCase)과 별개 포맷.
// 중첩 kvlist/array 도 지원(spanInputs/Outputs 등이 kvlist 로 온다).
interface MlflowAnyValue {
  string_value?: string;
  int_value?: string | number;
  long_value?: string | number;
  double_value?: number;
  bool_value?: boolean;
  kvlist_value?: { values?: MlflowKeyValue[] };
  array_value?: { values?: MlflowAnyValue[] };
}
interface MlflowKeyValue {
  key: string;
  value?: MlflowAnyValue;
}
// MLflow 3.x span: 시간은 ns(number|string), attributes 는 OTLP keyvalue 배열.
interface MlflowSpan {
  name?: string;
  start_time_unix_nano?: number | string;
  end_time_unix_nano?: number | string;
  attributes?: MlflowKeyValue[];
}
interface MlflowTrace {
  spans?: MlflowSpan[];
}

function anyValue(v: MlflowAnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.string_value !== undefined) return v.string_value;
  if (v.int_value !== undefined) return typeof v.int_value === "string" ? Number(v.int_value) : v.int_value;
  if (v.long_value !== undefined) return typeof v.long_value === "string" ? Number(v.long_value) : v.long_value;
  if (v.double_value !== undefined) return v.double_value;
  if (v.bool_value !== undefined) return v.bool_value;
  if (v.kvlist_value) {
    const o: Record<string, unknown> = {};
    for (const kv of v.kvlist_value.values ?? []) o[kv.key] = anyValue(kv.value);
    return o;
  }
  if (v.array_value) return (v.array_value.values ?? []).map(anyValue);
  return undefined;
}

function nanoToMs(v: number | string | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Math.floor(n / 1e6);
}

export function parseMlflowTrace(trace: MlflowTrace): Span[] {
  return (trace.spans ?? []).map((s) => {
    const attrs: Record<string, unknown> = {};
    for (const at of s.attributes ?? []) attrs[at.key] = anyValue(at.value);
    return {
      name: s.name ?? "",
      startMs: nanoToMs(s.start_time_unix_nano),
      endMs: nanoToMs(s.end_time_unix_nano),
      attrs,
    };
  });
}

export interface MlflowTraceSourceOptions {
  endpoint: string;
  headers?: Record<string, string>; // 테넌트 자격증명 등(예: Authorization). SecretStore 에서 주입.
  fetchImpl?: typeof fetch; // 테스트 주입
}

// MLflow 3.x tracing REST(`GET /api/3.0/mlflow/traces/get?trace_id=`)에서 trace 를 가져와 TraceEvent 로 정규화.
export class MlflowTraceSource implements TraceSource {
  constructor(private readonly opts: MlflowTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/3.0/mlflow/traces/get?trace_id=${encodeURIComponent(runId)}`, {
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    if (res.status === 404) return []; // 트레이스가 아직 없으면 0건으로 degrade(서비스 하니스 경로)
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `MLflow 트레이스 조회 ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    let body: { trace?: MlflowTrace };
    try {
      body = (await res.json()) as { trace?: MlflowTrace };
    } catch {
      return [];
    }
    return spansToTraceEvents(parseMlflowTrace(body.trace ?? {}));
  }
}
