import {
  type BrowsableTraceSource,
  EVERDICT_SEMCONV,
  type FetchedTrace,
  type ListTracesOptions,
  OTEL_SERVICE_NAME_ATTR,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceListPage,
  type TraceSpan,
  type TraceSummary,
  UpstreamError,
  traceIdForRun,
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

// The published everdict.* semantic conventions (native-observability N0) and OTel's own service identity.
// Both now live in `@everdict/contracts/execution/semconv` — the vocabulary is a CONTRACT, and it had
// outgrown this adapter the moment our own emitters started speaking it (otel-trace-model.md N6). Re-exported
// here so every existing importer (and the `@everdict/otel` drift guard, which compares the user-facing copy
// against this module) keeps its import path.
export { EVERDICT_SEMCONV, OTEL_SERVICE_NAME_ATTR };

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

// --- The DOOR's parser: OTLP → the RECORD (otel-trace-model.md N6) ------------------------------------
//
// `parseOtlpSpans` above exists for the PULL adapters, which normalize a foreign platform's dialect into the
// flat intermediate their SpanAttrMapping machinery works on. It drops what a pull never needed: the trace
// id, the span kind, the status, the span events, and the resource/scope separation.
//
// Our own door needs all of it. A tenant sends us a valid OTLP trace; storing a lossy flattening of it and
// then guessing the tree back in the viewer was the defect N6 removes. So the door parses ONCE, into
// `TraceSpan`, and what we hold is what we were sent.

// OTLP JSON carries these as fields the pull path never reads.
interface OtlpRichSpan extends OtlpSpan {
  traceId?: string;
  kind?: number | string;
  status?: { code?: number | string; message?: string };
  events?: Array<{ timeUnixNano?: string | number; name?: string; attributes?: OtlpAttr[] }>;
  links?: Array<{ traceId?: string; spanId?: string; attributes?: OtlpAttr[] }>;
}

// OTel SpanKind is an enum over the wire (0 UNSPECIFIED … 5 CONSUMER); some exporters send the name.
const SPAN_KINDS = ["internal", "internal", "server", "client", "producer", "consumer"] as const;
function spanKindOf(value: number | string | undefined): TraceSpan["kind"] {
  if (typeof value === "string") {
    const name = value.toLowerCase().replace("span_kind_", "");
    return (SPAN_KINDS as readonly string[]).includes(name) ? (name as TraceSpan["kind"]) : "internal";
  }
  return SPAN_KINDS[typeof value === "number" ? value : 0] ?? "internal";
}

function statusOf(status: OtlpRichSpan["status"]): TraceSpan["status"] | undefined {
  if (!status) return undefined;
  const raw = status.code;
  const code =
    raw === 2 || raw === "STATUS_CODE_ERROR" ? "error" : raw === 1 || raw === "STATUS_CODE_OK" ? "ok" : "unset";
  return { code, ...(status.message ? { message: status.message } : {}) };
}

// A sender's id, kept when it is already W3C-shaped and DERIVED when it is not. Deriving (rather than
// minting) keeps a parent link intact: the same input always yields the same id, so a tree whose ids we had
// to rewrite is still the tree we were sent.
function hexId(value: string | undefined, width: 16 | 32): string | undefined {
  if (value === undefined || value === "") return undefined;
  const lower = value.toLowerCase();
  if (new RegExp(`^[0-9a-f]{${width}}$`).test(lower)) return lower;
  const derived = traceIdForRun(value);
  return width === 32 ? derived : derived.slice(0, 16);
}

export function parseOtlpTraceSpans(
  spans: OtlpRichSpan[],
  ctx: { runId: string; resource?: Record<string, unknown>; scope?: { name: string; version?: string } },
): TraceSpan[] {
  const out: TraceSpan[] = [];
  for (const s of spans) {
    const attributes: Record<string, unknown> = {};
    for (const at of s.attributes ?? []) attributes[at.key] = attrValue(at.value);
    // A span with no id of its own cannot be a node in anyone's tree; deriving one from its name+start keeps
    // it in the picture rather than dropping evidence.
    const spanId = hexId(s.spanId, 16) ?? hexId(`${s.name ?? ""}-${s.startTimeUnixNano ?? ""}`, 16);
    if (spanId === undefined) continue;
    const parentSpanId = hexId(s.parentSpanId, 16);
    const startMs = nanoToMs(s.startTimeUnixNano);
    const endMs = nanoToMs(s.endTimeUnixNano);
    out.push({
      // The run correlates the trace: every plane of one run shares an id whether or not the sender knew it.
      traceId: hexId(s.traceId, 32) ?? traceIdForRun(ctx.runId),
      spanId,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      name: s.name ?? "",
      kind: spanKindOf(s.kind),
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs >= startMs ? endMs : startMs).toISOString(),
      attributes,
      ...(s.events && s.events.length > 0
        ? {
            events: s.events.map((e) => {
              const eventAttrs: Record<string, unknown> = {};
              for (const at of e.attributes ?? []) eventAttrs[at.key] = attrValue(at.value);
              return {
                name: e.name ?? "",
                at: new Date(nanoToMs(e.timeUnixNano)).toISOString(),
                ...(Object.keys(eventAttrs).length > 0 ? { attributes: eventAttrs } : {}),
              };
            }),
          }
        : {}),
      ...(s.links && s.links.length > 0
        ? {
            links: s.links.flatMap((l) => {
              const traceId = hexId(l.traceId, 32);
              const linkSpanId = hexId(l.spanId, 16);
              return traceId !== undefined && linkSpanId !== undefined ? [{ traceId, spanId: linkSpanId }] : [];
            }),
          }
        : {}),
      ...(statusOf(s.status) !== undefined ? { status: statusOf(s.status) } : {}),
      // Resource stays SEPARATE from the span's own attributes. Merging them (which the pull path does, and
      // must) loses which described the process and which the operation — and an export cannot be rebuilt
      // from the merged bag.
      ...(ctx.resource && Object.keys(ctx.resource).length > 0 ? { resource: ctx.resource } : {}),
      ...(ctx.scope ? { scope: ctx.scope } : {}),
    });
  }
  return out;
}

// The door's grouping, on the record instead of the flattening. Same correlation rule as
// `groupOtlpExportByRun` (everdict.run_id, resource-level or span-level), same honest count of what could not
// join the ledger.
export function groupOtlpTraceSpansByRun(body: unknown): {
  groups: Map<string, TraceSpan[]>;
  missingRunId: number;
} {
  const groups = new Map<string, TraceSpan[]>();
  let missingRunId = 0;
  const resourceSpans = (body as { resourceSpans?: OtlpResourceSpans[] })?.resourceSpans ?? [];
  for (const rs of resourceSpans) {
    const resourceAttrs: Record<string, unknown> = {};
    for (const at of rs.resource?.attributes ?? []) resourceAttrs[at.key] = attrValue(at.value);
    const scopes = [...(rs.scopeSpans ?? []), ...(rs.instrumentationLibrarySpans ?? [])];
    for (const scopeSpans of scopes) {
      const scope = (scopeSpans as { scope?: { name?: string; version?: string } }).scope;
      for (const raw of (scopeSpans.spans ?? []) as OtlpRichSpan[]) {
        const spanAttrs: Record<string, unknown> = {};
        for (const at of raw.attributes ?? []) spanAttrs[at.key] = attrValue(at.value);
        const runId = spanAttrs[EVERDICT_SEMCONV.runId] ?? resourceAttrs[EVERDICT_SEMCONV.runId];
        if (typeof runId !== "string" || runId === "") {
          missingRunId++;
          continue;
        }
        const parsed = parseOtlpTraceSpans([raw], {
          runId,
          resource: resourceAttrs,
          ...(scope?.name ? { scope: { name: scope.name, ...(scope.version ? { version: scope.version } : {}) } } : {}),
        });
        const bucket = groups.get(runId) ?? [];
        bucket.push(...parsed);
        groups.set(runId, bucket);
      }
    }
  }
  return { groups, missingRunId };
}

// One run's SPANS split by the service that emitted them — the record twin of `partitionSpansByService`.
// The key is OTel's own `service.name`, read from the resource where it belongs.
export function partitionTraceSpansByService(spans: TraceSpan[]): Map<string | undefined, TraceSpan[]> {
  const out = new Map<string | undefined, TraceSpan[]>();
  for (const span of spans) {
    const name = span.resource?.[OTEL_SERVICE_NAME_ATTR] ?? span.attributes[OTEL_SERVICE_NAME_ATTR];
    const key = typeof name === "string" && name !== "" ? name : undefined;
    const bucket = out.get(key) ?? [];
    bucket.push(span);
    out.set(key, bucket);
  }
  return out;
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
  // Which PROCESS emitted the span — the key into the trace doc's `processes` map, where Jaeger keeps the
  // resource attributes (`service.name`, and everything an exporter set via OTEL_RESOURCE_ATTRIBUTES,
  // `everdict.run_id` among them). A span's own tags never carry them.
  processID?: string;
}

// The trace doc's process table: resource attributes, one entry per emitting process.
interface JaegerProcess {
  serviceName?: string;
  tags?: JaegerTag[];
}
function microToMs(v: number | undefined): number {
  return Math.floor((v ?? 0) / 1000);
}
// `processes` is the trace doc's resource table. Merging it INTO each span's bag is the same rule the OTLP
// path already applies to resource attributes, and it is what makes an exporter-set `everdict.run_id` (a
// RESOURCE attribute, not a span tag) visible to provenance extraction and the identity keys — without it a
// Jaeger-listed row can carry no correlation at all, which is exactly how a browse page ends up with nothing
// but uuids on it. A span's own tag wins over the process's: the more specific statement is the truer one.
export function parseJaegerSpans(spans: JaegerSpan[], processes?: Record<string, JaegerProcess>): Span[] {
  return spans.map((s) => {
    const attrs: Record<string, unknown> = {};
    const process = s.processID !== undefined ? processes?.[s.processID] : undefined;
    if (process?.serviceName) attrs[OTEL_SERVICE_NAME_ATTR] = process.serviceName;
    for (const t of process?.tags ?? []) attrs[t.key] = t.value;
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
  processes?: Record<string, JaegerProcess>;
}
// String-valued resource attributes across every process in the doc, flattened for the row's `tags` column.
// undefined rather than {} when there are none — an empty tag bag is a claim the trace carries no metadata.
function jaegerResourceTags(processes?: Record<string, JaegerProcess>): Record<string, string> | undefined {
  if (!processes) return undefined;
  const out: Record<string, string> = {};
  for (const process of Object.values(processes)) {
    if (process.serviceName) out[OTEL_SERVICE_NAME_ATTR] = process.serviceName;
    for (const t of process.tags ?? []) if (typeof t.value === "string" && t.value !== "") out[t.key] = t.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Pure: Jaeger trace docs → summaries (metrics derived from the embedded spans). scope = the service listed under.
export function jaegerTracesToSummaries(traces: JaegerTraceDoc[], scope?: string): TraceSummary[] {
  const out: TraceSummary[] = [];
  for (const tr of traces) {
    if (!tr.traceID) continue;
    const spans = parseJaegerSpans(tr.spans ?? [], tr.processes);
    // The resource/process attributes as the row's tags — the correlation display the list column reads
    // (`everdict.run_id` and the service that emitted it live here, never on a span's own tags).
    const tags = jaegerResourceTags(tr.processes);
    out.push({
      id: tr.traceID,
      ...summarizeSpans(spans),
      ...(tags ? { tags } : {}),
      ...(scope ? { scope } : {}),
    });
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
    const body = (await res.json()) as { spans?: OtlpSpan[]; data?: JaegerTraceDoc[] };
    // A tag search miss is data=[] → 0 spans (flush lag — retry is the caller's job).
    if (Array.isArray(body.data)) return body.data.flatMap((t) => parseJaegerSpans(t.spans ?? [], t.processes));
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
      // The platform's own trace id — TRUE only in correlate:"id", where the runId IS the trace id this
      // adapter addressed. Under correlate:"tag" the runId is the tag VALUE searched for, and the returned
      // spans carry no resolvable id here — naming it anyway handed the export a back-reference that
      // resolves to nothing (downstream report 1.4). An adapter that cannot name the platform's id names
      // nothing; the field is optional for exactly this.
      ...(this.opts.correlate === "tag" ? {} : { traceId: runId }),
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
