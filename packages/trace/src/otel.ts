import { type TraceEvent, UpstreamError } from "@everdict/core";
import { type Span, type TraceSource, spansToTraceEvents } from "./trace-source.js";

// OTLP 스팬(속성은 {key,value} 배열) → 정규화 Span.
interface OtlpAttr {
  key: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
}
interface OtlpSpan {
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpAttr[];
}

function attrValue(v: OtlpAttr["value"]): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}
function nanoToMs(v: string | number | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Math.floor(n / 1e6);
}

export function parseOtlpSpans(spans: OtlpSpan[]): Span[] {
  return spans.map((s) => {
    const attrs: Record<string, unknown> = {};
    for (const at of s.attributes ?? []) attrs[at.key] = attrValue(at.value);
    return { name: s.name ?? "", startMs: nanoToMs(s.startTimeUnixNano), endMs: nanoToMs(s.endTimeUnixNano), attrs };
  });
}

// Jaeger query API(`GET /api/traces/{id}`) 형식: data[].spans[] {operationName, startTime/duration(μs), tags:[{key,value}]}.
// 태그 value 는 이미 타입 디코딩됨(string/number/bool) — OTLP 의 {stringValue/intValue} 와 다름.
interface JaegerTag {
  key: string;
  value?: unknown;
}
interface JaegerSpan {
  operationName?: string;
  startTime?: number; // microseconds
  duration?: number; // microseconds
  tags?: JaegerTag[];
}
function microToMs(v: number | undefined): number {
  return Math.floor((v ?? 0) / 1000);
}
export function parseJaegerSpans(spans: JaegerSpan[]): Span[] {
  return spans.map((s) => {
    const attrs: Record<string, unknown> = {};
    for (const t of s.tags ?? []) attrs[t.key] = t.value;
    return {
      name: s.operationName ?? "",
      startMs: microToMs(s.startTime),
      endMs: microToMs((s.startTime ?? 0) + (s.duration ?? 0)),
      attrs,
    };
  });
}

export interface OtelTraceSourceOptions {
  endpoint: string;
  headers?: Record<string, string>; // 테넌트 자격증명 등(예: Authorization). SecretStore 에서 주입.
  fetchImpl?: typeof fetch; // 테스트 주입
  // 상관 방식: "id"(기본) = fetch(runId) 의 runId 가 곧 trace id(pull-ingest 관례).
  // "tag" = 계측 에이전트의 리소스 속성 `everdict.run_id`(주입 env OTEL_RESOURCE_ATTRIBUTES 그대로)로 검색 —
  // Jaeger query API 전용(`GET /api/traces?service=…&tags=…`, 실 1.62 검증: 리소스 속성=process 태그 매칭,
  // service 필수). OTLP-네이티브 백엔드(검색 API 없음)는 id 상관 유지.
  correlate?: "id" | "tag";
  service?: string; // tag 상관의 검색 범위(Jaeger 는 service 파라미터 필수) — 에이전트의 service.name
}

const RUN_ID_ATTR = "everdict.run_id"; // 계측 에이전트가 남기는 상관 리소스 속성(주입 env 와 동일 값)

// OTLP/Jaeger 호환 HTTP 에서 runId(=trace id)로 스팬을 가져와 TraceEvent 로 정규화.
// correlate="tag" 면 Jaeger 검색(service+tags)으로 찾는다 — 검색 응답이 스팬을 동봉하므로 요청 1회.
export class OtelTraceSource implements TraceSource {
  constructor(private readonly opts: OtelTraceSourceOptions) {}

  private url(runId: string): string {
    const base = this.opts.endpoint.replace(/\/$/, "");
    if (this.opts.correlate !== "tag") return `${base}/api/traces/${encodeURIComponent(runId)}`;
    if (!this.opts.service) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { correlate: "tag" },
        "OTel tag 상관에는 service 범위가 필요합니다(Jaeger 검색의 service 파라미터 필수).",
      );
    }
    const qs = new URLSearchParams({
      service: this.opts.service,
      tags: JSON.stringify({ [RUN_ID_ATTR]: runId }),
      limit: "1",
    });
    return `${base}/api/traces?${qs.toString()}`;
  }

  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.url(runId), {
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `OTel 트레이스 조회 ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    // 응답 형식 자동 감지: Jaeger query(`{data:[{spans}]}`) vs OTLP-네이티브(`{spans:[...]}`).
    // tag 검색 미발견은 data=[] → 0건 degrade(플러시 지연 — 재시도는 호출부 몫).
    const body = (await res.json()) as { spans?: OtlpSpan[]; data?: Array<{ spans?: JaegerSpan[] }> };
    if (Array.isArray(body.data)) {
      return spansToTraceEvents(parseJaegerSpans(body.data.flatMap((t) => t.spans ?? [])));
    }
    return spansToTraceEvents(parseOtlpSpans(body.spans ?? []));
  }
}
