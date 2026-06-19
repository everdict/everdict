import { type TraceEvent, UpstreamError } from "@assay/core";
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

export interface OtelTraceSourceOptions {
  endpoint: string;
  headers?: Record<string, string>; // 테넌트 자격증명 등(예: Authorization). SecretStore 에서 주입.
  fetchImpl?: typeof fetch; // 테스트 주입
}

// OTLP/Jaeger 호환 HTTP 에서 runId(=trace id)로 스팬을 가져와 TraceEvent 로 정규화.
export class OtelTraceSource implements TraceSource {
  constructor(private readonly opts: OtelTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/traces/${encodeURIComponent(runId)}`, {
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
    const body = (await res.json()) as { spans?: OtlpSpan[] };
    return spansToTraceEvents(parseOtlpSpans(body.spans ?? []));
  }
}
