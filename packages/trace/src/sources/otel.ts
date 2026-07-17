import {
  type BrowsableTraceSource,
  type FetchedTrace,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceSummary,
  UpstreamError,
} from "@everdict/contracts";
import { extractEvidence } from "./evidence-resolve.js";
import {
  type Span,
  spansToRawAttributes,
  spansToSpanNodes,
  spansToTraceEvents,
  summarizeSpans,
  withEvidenceEvents,
} from "./trace-source.js";

// OTLP span (attributes are a {key,value} array) → normalized Span.
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

// Jaeger query API (`GET /api/traces/{id}`) shape: data[].spans[] {operationName, startTime/duration(μs), tags:[{key,value}]}.
// Tag values are already type-decoded (string/number/bool) — unlike OTLP's {stringValue/intValue}.
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

// Jaeger find-traces (`GET /api/traces?service=…`) doc — one entry per trace, spans embedded.
interface JaegerTraceDoc {
  traceID?: string;
  spans?: JaegerSpan[];
}
// Pure: Jaeger trace docs → summaries (metrics derived from the embedded spans). scope = the service listed under.
export function jaegerTracesToSummaries(traces: JaegerTraceDoc[], scope?: string): TraceSummary[] {
  const out: TraceSummary[] = [];
  for (const tr of traces) {
    if (!tr.traceID) continue;
    const spans = parseJaegerSpans(tr.spans ?? []);
    out.push({ id: tr.traceID, ...summarizeSpans(spans), ...(scope ? { scope } : {}) });
  }
  return out;
}

export interface OtelTraceSourceOptions {
  endpoint: string;
  headers?: Record<string, string>; // tenant credentials etc. (e.g. Authorization). Injected from the SecretStore.
  fetchImpl?: typeof fetch; // test injection
  // Correlation mode: "id" (default) = the runId in fetch(runId) is the trace id (the pull-ingest convention).
  // "tag" = search by the instrumented agent's resource attribute `everdict.run_id` (the injected env OTEL_RESOURCE_ATTRIBUTES verbatim) —
  // Jaeger-query-API only (`GET /api/traces?service=…&tags=…`, verified on real 1.62: resource attribute = process-tag match,
  // service required). OTLP-native backends (no search API) stay id-correlated.
  correlate?: "id" | "tag";
  service?: string; // search scope for tag correlation (Jaeger requires the service parameter) — the agent's service.name
  mapping?: SpanAttrMapping; // per-harness span-attribute overrides (non-GenAI-convention instrumentation)
}

const RUN_ID_ATTR = "everdict.run_id"; // the correlation resource attribute the instrumented agent writes (same value as the injected env)

// Fetch spans from an OTLP/Jaeger-compatible HTTP endpoint by runId (=trace id) and normalize to TraceEvents.
// With correlate="tag", find it via a Jaeger search (service+tags) — the search response embeds the spans, so it's one request.
export class OtelTraceSource implements BrowsableTraceSource {
  constructor(private readonly opts: OtelTraceSourceOptions) {}

  private url(runId: string): string {
    const base = this.opts.endpoint.replace(/\/$/, "");
    if (this.opts.correlate !== "tag") return `${base}/api/traces/${encodeURIComponent(runId)}`;
    if (!this.opts.service) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { correlate: "tag" },
        "OTel tag correlation requires a service scope (the Jaeger search's service parameter is required).",
      );
    }
    const qs = new URLSearchParams({
      service: this.opts.service,
      tags: JSON.stringify({ [RUN_ID_ATTR]: runId }),
      limit: "1",
    });
    return `${base}/api/traces?${qs.toString()}`;
  }

  // GET the URL and parse to Span[], auto-detecting Jaeger (`{data:[{spans}]}`) vs OTLP-native (`{spans:[...]}`).
  private async getSpans(url: string): Promise<Span[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(url, { ...(this.opts.headers ? { headers: this.opts.headers } : {}) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `OTel trace fetch ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { spans?: OtlpSpan[]; data?: Array<{ spans?: JaegerSpan[] }> };
    // A tag search miss is data=[] → 0 spans (flush lag — retry is the caller's job).
    if (Array.isArray(body.data)) return parseJaegerSpans(body.data.flatMap((t) => t.spans ?? []));
    return parseOtlpSpans(body.spans ?? []);
  }

  async fetch(runId: string): Promise<TraceEvent[]> {
    return (await this.fetchDetailed(runId)).events;
  }

  // fetch + the evidence slots extracted via the configured mapping (screenshot refs resolved best-effort with the
  // source's own credentials) — what the pull-ingest path consumes to synthesize a judge snapshot.
  async fetchDetailed(runId: string): Promise<FetchedTrace> {
    const spans = await this.getSpans(this.url(runId));
    const m = this.opts.mapping;
    const evidence = await extractEvidence(
      spans,
      m,
      this.opts.fetchImpl ?? fetch,
      this.opts.headers,
      this.opts.endpoint,
    );
    return {
      events: withEvidenceEvents(spansToTraceEvents(spans, m), evidence),
      ...(evidence ? { evidence } : {}),
    };
  }

  async inspect(traceId: string, mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    const base = this.opts.endpoint.replace(/\/$/, "");
    const spans = await this.getSpans(`${base}/api/traces/${encodeURIComponent(traceId)}`);
    const m = mapping ?? this.opts.mapping;
    const evidence = await extractEvidence(
      spans,
      m,
      this.opts.fetchImpl ?? fetch,
      this.opts.headers,
      this.opts.endpoint,
    );
    return {
      rawAttributes: spansToRawAttributes(spans),
      events: withEvidenceEvents(spansToTraceEvents(spans, m), evidence),
      ...(evidence ? { evidence } : {}),
      detail: { rollup: summarizeSpans(spans), spans: spansToSpanNodes(spans, m) },
    };
  }

  async listTraces(opts?: ListTracesOptions): Promise<TraceSummary[]> {
    const base = this.opts.endpoint.replace(/\/$/, "");
    const scope = opts?.scope ?? this.opts.service;
    if (!scope) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        {},
        "OTel (Jaeger) trace listing requires a service scope (the Jaeger service parameter).",
      );
    }
    const f = this.opts.fetchImpl ?? fetch;
    const qs = new URLSearchParams({ service: scope, limit: String(opts?.limit ?? 50) });
    const res = await f(`${base}/api/traces?${qs.toString()}`, {
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `OTel trace list ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { data?: JaegerTraceDoc[] };
    return jaegerTracesToSummaries(body.data ?? [], scope);
  }
}
