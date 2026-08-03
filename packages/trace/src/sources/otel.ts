import {
  type BrowsableTraceSource,
  type FetchedTrace,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceListPage,
  type TraceSummary,
  UpstreamError,
} from "@everdict/contracts";
import { extractEvidence } from "./evidence-resolve.js";
import {
  type Span,
  provenanceFromSpans,
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
  // The span TREE, as OTLP/JSON sends it (hex ids). Carried through to the normalized events so evidence
  // arriving at our door keeps the nesting the exporter reported — a trace read from our own store must be
  // the same picture the sender's platform shows.
  spanId?: string;
  parentSpanId?: string;
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

// The published everdict.* semantic conventions (native-observability N0): instrumentation is standard OTel;
// these attribute keys are the CONTRACT — everdict.run_id correlates spans to the run ledger (resource-level
// via the injected OTEL_RESOURCE_ATTRIBUTES, span-level override wins), the rest carry execution identity.
// Scores/verdicts stay platform-layer records referencing trace ids — never span data.
export const EVERDICT_SEMCONV = {
  runId: "everdict.run_id",
  kind: "everdict.kind",
  caseId: "everdict.case_id",
  groupId: "everdict.group_id",
} as const;

// OTel's OWN identity attribute for the emitting process. It is the plane key of a multi-service
// trajectory (maintainer's decision: the standard attribute, never an everdict-specific one — a service
// joins a run's trajectory by setting OTEL_SERVICE_NAME and the run-id correlation, nothing else).
export const OTEL_SERVICE_NAME_ATTR = "service.name";

// One run's spans split by the SERVICE that emitted them — the door's plane grouping. `undefined` keys the
// spans that declare no service.name: they stay the run's own record instead of inventing a service for
// them. Insertion order follows first appearance, so the export's own ordering decides the header plane.
export function partitionSpansByService(spans: Span[]): Map<string | undefined, Span[]> {
  const out = new Map<string | undefined, Span[]>();
  for (const span of spans) {
    const name = span.attrs[OTEL_SERVICE_NAME_ATTR];
    const key = typeof name === "string" && name !== "" ? name : undefined;
    const bucket = out.get(key) ?? [];
    bucket.push(span);
    out.set(key, bucket);
  }
  return out;
}

// OTLP/HTTP ExportTraceServiceRequest (JSON) → spans grouped by their everdict.run_id (the N0 receiver's
// core). Resource attributes merge INTO each span's bag (resource attrs correlate whole processes; a
// span-level attribute overrides). Spans with no run id anywhere cannot join the ledger — counted, never
// silently dropped.
interface OtlpResourceSpans {
  resource?: { attributes?: OtlpAttr[] };
  scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  // pre-1.0 exporters spell it instrumentationLibrarySpans — accept both.
  instrumentationLibrarySpans?: Array<{ spans?: OtlpSpan[] }>;
}

export function groupOtlpExportByRun(body: unknown): { groups: Map<string, Span[]>; missingRunId: number } {
  const groups = new Map<string, Span[]>();
  let missingRunId = 0;
  const resourceSpans = (body as { resourceSpans?: OtlpResourceSpans[] })?.resourceSpans ?? [];
  for (const rs of resourceSpans) {
    const resourceAttrs: Record<string, unknown> = {};
    for (const at of rs.resource?.attributes ?? []) resourceAttrs[at.key] = attrValue(at.value);
    const scopes = [...(rs.scopeSpans ?? []), ...(rs.instrumentationLibrarySpans ?? [])];
    for (const scope of scopes) {
      for (const span of parseOtlpSpans(scope.spans ?? [])) {
        const merged = { ...span, attrs: { ...resourceAttrs, ...span.attrs } };
        const runId = merged.attrs[EVERDICT_SEMCONV.runId];
        if (typeof runId !== "string" || runId === "") {
          missingRunId++;
          continue;
        }
        const bucket = groups.get(runId) ?? [];
        bucket.push(merged);
        groups.set(runId, bucket);
      }
    }
  }
  return { groups, missingRunId };
}

export function parseOtlpSpans(spans: OtlpSpan[]): Span[] {
  return spans.map((s) => {
    const attrs: Record<string, unknown> = {};
    for (const at of s.attributes ?? []) attrs[at.key] = attrValue(at.value);
    return {
      name: s.name ?? "",
      startMs: nanoToMs(s.startTimeUnixNano),
      endMs: nanoToMs(s.endTimeUnixNano),
      attrs,
      // An empty parentSpanId is OTLP's way of saying "root" — kept as absent rather than as an id nothing has.
      ...(s.spanId ? { spanId: s.spanId } : {}),
      ...(s.parentSpanId ? { parentId: s.parentSpanId } : {}),
    };
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
  artifactBaseUrl?: string; // base for ROOT-RELATIVE evidence artifact refs (else the judge gets the raw path string)
  // The tag/resource-attribute key `correlate:"tag"` searches (default `everdict.run_id`). Set to a controlled-
  // coordinate/session attribute so a trace whose agent overwrote `everdict.run_id` is found by the id everdict injected
  // (the value comes from fetch(runId), where the caller passes the controlled coordinate — frontDoor.contextId).
  correlateTag?: string;
  service?: string; // search scope for tag correlation (Jaeger requires the service parameter) — the agent's service.name
  mapping?: SpanAttrMapping; // per-harness span-attribute overrides (non-GenAI-convention instrumentation)
}

const RUN_ID_ATTR = "everdict.run_id"; // the default correlation resource attribute the instrumented agent writes (same value as the injected env)

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
    const tag = this.opts.correlateTag ?? RUN_ID_ATTR; // controlled-coordinate attribute override (e.g. a session id) — default everdict.run_id
    const qs = new URLSearchParams({
      service: this.opts.service,
      tags: JSON.stringify({ [tag]: runId }),
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
      this.opts.artifactBaseUrl,
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
      this.opts.artifactBaseUrl,
    );
    const provenance = provenanceFromSpans(spans); // resource/span attrs carry everdict.run_id + everdict.scorecard_id/harness
    return {
      rawAttributes: spansToRawAttributes(spans),
      events: withEvidenceEvents(spansToTraceEvents(spans, m), evidence),
      ...(provenance ? { provenance } : {}),
      ...(evidence ? { evidence } : {}),
      detail: { rollup: summarizeSpans(spans), spans: spansToSpanNodes(spans, m) },
    };
  }

  // Single best-effort page — the Jaeger find-traces API has no cursor, so this returns one page with no nextCursor.
  async listTraces(opts?: ListTracesOptions): Promise<TraceListPage> {
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
    // Jaeger query API takes the time window as start/end in MICROSECONDS since epoch (ignored if the value is unparseable).
    const since = opts?.since ? Date.parse(opts.since) : Number.NaN;
    const until = opts?.until ? Date.parse(opts.until) : Number.NaN;
    if (!Number.isNaN(since)) qs.set("start", String(since * 1000));
    if (!Number.isNaN(until)) qs.set("end", String(until * 1000));
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
    return { traces: jaegerTracesToSummaries(body.data ?? [], scope) };
  }
}
