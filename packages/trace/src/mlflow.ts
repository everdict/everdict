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
  // 상관 방식: "id"(기본) = fetch(runId) 의 runId 가 곧 MLflow trace_id(pull-ingest 관례).
  // "tag" = 계측 에이전트가 자기 trace 에 남긴 `assay.run_id` 태그로 검색(id 는 서버가 mint 하므로
  // assay runId 와 같을 수 없는 실 에이전트 경로) — search 가 locations 를 요구해 experimentIds 필수.
  correlate?: "id" | "tag";
  experimentIds?: string[]; // tag 상관의 검색 범위(MLflow 3.x traces/search 는 locations 필수)
}

const RUN_ID_TAG = "assay.run_id"; // 계측 에이전트가 남기는 상관 태그(주입 env ASSAY_RUN_ID 와 동일 값)

// MLflow 3.x tracing REST(`GET /api/3.0/mlflow/traces/get?trace_id=`)에서 trace 를 가져와 TraceEvent 로 정규화.
// correlate="tag" 면 `POST /api/3.0/mlflow/traces/search`(tags.`assay.run_id` 필터, 실 3.14 검증)로
// trace_id 를 먼저 찾는다 — 미발견은 0건 degrade(id 모드의 404 와 동일).
export class MlflowTraceSource implements TraceSource {
  constructor(private readonly opts: MlflowTraceSourceOptions) {}

  private async traceIdByTag(runId: string): Promise<string | undefined> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const experiments = this.opts.experimentIds ?? [];
    if (experiments.length === 0) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { correlate: "tag" },
        "MLflow tag 상관에는 experiment 범위가 필요합니다(traces/search 의 locations 필수).",
      );
    }
    const res = await f(`${base}/api/3.0/mlflow/traces/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
      body: JSON.stringify({
        locations: experiments.map((id) => ({
          type: "MLFLOW_EXPERIMENT",
          mlflow_experiment: { experiment_id: id },
        })),
        filter: `tags.\`${RUN_ID_TAG}\` = '${runId.replace(/'/g, "''")}'`,
        max_results: 1,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `MLflow 트레이스 검색 ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { traces?: Array<{ trace_id?: string }> };
    return body.traces?.[0]?.trace_id;
  }

  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    let traceId = runId;
    if (this.opts.correlate === "tag") {
      const found = await this.traceIdByTag(runId);
      if (!found) return []; // 태그 미발견 — 아직 미도착/미태그(플러시 지연) → 0건 degrade
      traceId = found;
    }
    const res = await f(`${base}/api/3.0/mlflow/traces/get?trace_id=${encodeURIComponent(traceId)}`, {
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
