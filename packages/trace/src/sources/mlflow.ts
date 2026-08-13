import {
  type BrowsableTraceSource,
  type FetchedTrace,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceListPage,
  type TraceRunStatus,
  type TraceSummary,
  UpstreamError,
} from "@everdict/contracts";
import { extractEvidence } from "./evidence-resolve.js";
import {
  type Span,
  extractProvenance,
  modelFromSpans,
  provenanceFromSpans,
  spansToRawAttributes,
  spansToSpanNodes,
  spansToTraceEvents,
  summarizeSpans,
  withEvidenceEvents,
} from "./trace-source.js";

// Span attributes in the MLflow 3.x trace REST are an OTLP-style AnyValue (snake_case) array — a format distinct from OTel (camelCase).
// Also supports nested kvlist/array (spanInputs/Outputs etc. arrive as a kvlist).
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
// MLflow 3.x span: times are ns (number|string), attributes are an OTLP keyvalue array. span_id/parent_span_id are
// hex strings (OTLP) that drive the waterfall nesting.
interface MlflowSpan {
  name?: string;
  span_id?: string;
  parent_span_id?: string;
  start_time_unix_nano?: number | string;
  end_time_unix_nano?: number | string;
  attributes?: MlflowKeyValue[];
}
interface MlflowTrace {
  spans?: MlflowSpan[];
  trace_info?: MlflowTraceInfo; // 3.x traces/get also carries the TraceInfo (state etc.) beside the spans
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
      ...(s.span_id ? { spanId: s.span_id } : {}),
      ...(s.parent_span_id ? { parentId: s.parent_span_id } : {}),
    };
  });
}

// MLflow 3.x TraceInfo (the traces/search response element). Fields shift across versions — parse defensively.
interface MlflowTraceInfo {
  trace_id?: string;
  request_time?: string | number; // ms epoch (string|number) or ISO
  timestamp_ms?: number; // older field
  execution_duration?: string | number; // 3.x proto3-JSON Duration ("4.83s") — what the live server actually returns
  execution_duration_ms?: number; // older (v2) field
  execution_time_ms?: number;
  state?: string; // OK|ERROR|IN_PROGRESS|STATE_UNSPECIFIED
  status?: string; // older
  tags?: Record<string, string> | Array<{ key?: string; value?: string }>;
  trace_metadata?: Record<string, string>;
}

const TRACE_NAME_TAG = "mlflow.traceName"; // TraceInfo has no name field — MLflow stores the display name in this tag

// 3.x serializes execution_duration as a proto3-JSON Duration string ("1.2s"); v2 exposed *_ms number fields.
function mlflowDurationMs(info: MlflowTraceInfo): number | undefined {
  const ms = info.execution_duration_ms ?? info.execution_time_ms;
  if (typeof ms === "number") return Math.max(0, ms);
  const d = info.execution_duration;
  if (typeof d === "number") return Math.max(0, d);
  if (typeof d === "string") {
    const secs = /^([0-9.]+)s$/.exec(d.trim());
    if (secs) return Math.max(0, Math.round(Number(secs[1]) * 1000));
    const n = Number(d);
    if (!Number.isNaN(n)) return Math.max(0, n);
  }
  return undefined;
}

function mlflowStartedAt(info: MlflowTraceInfo): string | undefined {
  const rt = info.request_time;
  if (typeof rt === "number") return new Date(rt).toISOString();
  if (typeof rt === "string" && rt.trim() !== "") {
    const n = Number(rt);
    if (!Number.isNaN(n)) return new Date(n).toISOString();
    const parsed = Date.parse(rt);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof info.timestamp_ms === "number") return new Date(info.timestamp_ms).toISOString();
  return undefined;
}

function mlflowTags(info: MlflowTraceInfo): Record<string, string> | undefined {
  const t = info.tags;
  if (!t) return undefined;
  if (Array.isArray(t)) {
    const out: Record<string, string> = {};
    for (const kv of t) if (kv.key) out[kv.key] = kv.value ?? "";
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return Object.keys(t).length > 0 ? t : undefined;
}

function mlflowStatus(info: MlflowTraceInfo): "ok" | "error" | "unset" | undefined {
  const s = (info.state ?? info.status ?? "").toUpperCase();
  if (s === "OK") return "ok";
  if (s === "ERROR") return "error";
  if (s === "") return undefined;
  return "unset";
}

function mlflowTokens(info: MlflowTraceInfo): { input?: number; output?: number } | undefined {
  const raw = info.trace_metadata?.["mlflow.trace.tokenUsage"];
  if (typeof raw !== "string") return undefined;
  try {
    const u = JSON.parse(raw) as Record<string, unknown>;
    const input = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
    const output = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
    if (input === undefined && output === undefined) return undefined;
    return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
  } catch {
    return undefined;
  }
}

// Trace-level total cost — real 3.x servers report it as the `mlflow.trace.cost` metadata JSON (live-verified 3.11).
function mlflowCostUsd(info: MlflowTraceInfo): number | undefined {
  const raw = info.trace_metadata?.["mlflow.trace.cost"];
  if (typeof raw !== "string") return undefined;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    return typeof c.total_cost === "number" ? c.total_cost : undefined;
  } catch {
    return undefined;
  }
}

// Pure: MLflow TraceInfo[] → summaries. scope = the experiment id listed under.
export function mlflowTracesToSummaries(traces: MlflowTraceInfo[], scope?: string): TraceSummary[] {
  const out: TraceSummary[] = [];
  for (const info of traces) {
    if (!info.trace_id) continue;
    const startedAt = mlflowStartedAt(info);
    const durationMs = mlflowDurationMs(info);
    const status = mlflowStatus(info);
    const tags = mlflowTags(info);
    const tokens = mlflowTokens(info);
    const costUsd = mlflowCostUsd(info);
    const name = tags?.[TRACE_NAME_TAG];
    // Everdict origin lives in trace_metadata (everdict.scorecardId/dataset/harness/caseId) + the everdict.run_id tag.
    const provenance = extractProvenance({ ...info.trace_metadata, ...tags });
    out.push({
      id: info.trace_id,
      ...(name ? { name } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(status ? { status } : {}),
      ...(tags ? { tags } : {}),
      ...(tokens ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(scope ? { scope } : {}),
      ...(provenance ? { provenance } : {}),
    });
  }
  return out;
}

export interface MlflowTraceSourceOptions {
  endpoint: string;
  headers?: Record<string, string>; // tenant credentials etc. (e.g. Authorization). Injected from the SecretStore.
  fetchImpl?: typeof fetch; // test injection
  // Correlation mode: "id" (default) = the runId in fetch(runId) is the MLflow trace_id (the pull-ingest convention).
  // "tag" = search by the `everdict.run_id` tag the instrumented agent wrote to its own trace (the real-agent path,
  // where the id is minted by the server and so can't equal the everdict runId) — search requires locations, so experimentIds is required.
  correlate?: "id" | "tag";
  // The tag key `correlate:"tag"` searches (default `everdict.run_id`). Set to a controlled-coordinate/session tag
  // (e.g. `mlflow.trace.session`) so a trace whose agent overwrote `everdict.run_id` is found by the session id everdict
  // injected — the value comes from fetch(runId), where the caller passes the controlled coordinate (frontDoor.contextId).
  correlateTag?: string;
  experimentIds?: string[]; // search scope for tag correlation (MLflow 3.x traces/search requires locations)
  mapping?: SpanAttrMapping; // per-harness span-attribute overrides (non-GenAI-convention instrumentation)
  artifactBaseUrl?: string; // base for ROOT-RELATIVE evidence artifact refs (else the judge gets the raw path string)
}

const RUN_ID_TAG = "everdict.run_id"; // the default correlation tag the instrumented agent writes (same value as the injected env EVERDICT_RUN_ID)

// listTraces model enrichment bounds — one traces/get per row missing a model, so cap the fan-out and its parallelism.
const MODEL_ENRICH_CAP = 50;
const MODEL_ENRICH_CONCURRENCY = 6;

// Fetch the trace from the MLflow 3.x tracing REST (`GET /api/3.0/mlflow/traces/get?trace_id=`) and normalize to TraceEvents.
// With correlate="tag", first find the trace_id via `POST /api/3.0/mlflow/traces/search` (tags.`everdict.run_id` filter, verified on real 3.14)
// — not found → degrade to 0 events (same as id mode's 404).
export class MlflowTraceSource implements BrowsableTraceSource {
  constructor(private readonly opts: MlflowTraceSourceOptions) {}

  // One traces/search call with the given filter clause → the first trace_id (or undefined on no match).
  private async searchTraceId(experiments: string[], filter: string): Promise<string | undefined> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/3.0/mlflow/traces/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
      body: JSON.stringify({
        locations: experiments.map((id) => ({
          type: "MLFLOW_EXPERIMENT",
          mlflow_experiment: { experiment_id: id },
        })),
        filter,
        max_results: 1,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `MLflow trace search ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { traces?: Array<{ trace_id?: string }> };
    return body.traces?.[0]?.trace_id;
  }

  private async traceIdByTag(runId: string): Promise<string | undefined> {
    const experiments = this.opts.experimentIds ?? [];
    if (experiments.length === 0) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { correlate: "tag" },
        "MLflow tag correlation requires an experiment scope (traces/search requires locations).",
      );
    }
    const tag = this.opts.correlateTag ?? RUN_ID_TAG; // controlled-coordinate tag override (e.g. mlflow.trace.session) — default everdict.run_id
    const value = runId.replace(/'/g, "''");
    const byTag = await this.searchTraceId(experiments, `tags.\`${tag}\` = '${value}'`);
    if (byTag) return byTag;
    // Request-metadata fallback: some SDK paths record the correlation key in the trace's REQUEST METADATA
    // (TraceInfo.trace_metadata — e.g. metadata attached at trace creation) instead of a tag the agent would have
    // to PATCH afterwards. The tag search then missed a trace that IS correlatable and the pull degraded to 0
    // events; try the metadata filter before declaring absence (one extra call, only on a tag miss).
    const byMetadata = await this.searchTraceId(experiments, `request_metadata.\`${tag}\` = '${value}'`).catch(
      () => undefined, // a server too old for the metadata filter grammar must not break the (authoritative) tag path
    );
    return byMetadata;
  }

  // GET the trace by its (server-minted) trace_id and parse to Span[]. Absent/unparseable → 0 spans (flush lag).
  private async getSpansById(traceId: string): Promise<Span[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/3.0/mlflow/traces/get?trace_id=${encodeURIComponent(traceId)}`, {
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    if (res.status === 404) return []; // if the trace isn't present yet, degrade to 0 spans (the service-harness path)
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `MLflow trace fetch ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    let body: { trace?: MlflowTrace };
    try {
      body = (await res.json()) as { trace?: MlflowTrace };
    } catch {
      return [];
    }
    return parseMlflowTrace(body.trace ?? {});
  }

  async fetch(runId: string): Promise<TraceEvent[]> {
    return (await this.fetchDetailed(runId)).events;
  }

  // Terminal-state probe (front-door "trace" completion): resolve the trace (id or tag correlation), then read the
  // TraceInfo state from traces/get. IN_PROGRESS → running (the agent is still working); a server that reports no
  // state degrades to presence ("ok" when the trace exists — such servers don't track progress, so presence is the
  // best available signal and waiting longer would only burn the completion budget).
  async status(runId: string): Promise<TraceRunStatus> {
    let traceId = runId;
    if (this.opts.correlate === "tag") {
      const found = await this.traceIdByTag(runId);
      if (!found) return "absent";
      traceId = found;
    }
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/3.0/mlflow/traces/get?trace_id=${encodeURIComponent(traceId)}`, {
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    if (res.status === 404) return "absent";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `MLflow trace status ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    let body: { trace?: MlflowTrace };
    try {
      body = (await res.json()) as { trace?: MlflowTrace };
    } catch {
      return "absent";
    }
    if (!body.trace) return "absent";
    const s = (body.trace.trace_info?.state ?? body.trace.trace_info?.status ?? "").toUpperCase();
    if (s === "OK") return "ok";
    if (s === "ERROR") return "error";
    if (s === "IN_PROGRESS" || s === "PENDING") return "running";
    return "ok"; // no/unspecified state — presence-based degrade (see above)
  }

  // fetch + the evidence slots extracted via the configured mapping (screenshot refs resolved best-effort with the
  // source's own credentials) — what the pull-ingest path consumes to synthesize a judge snapshot.
  async fetchDetailed(runId: string): Promise<FetchedTrace> {
    let traceId = runId;
    if (this.opts.correlate === "tag") {
      const found = await this.traceIdByTag(runId);
      if (!found) return { events: [] }; // tag not found — not arrived/tagged yet (flush lag) → degrade to 0 events
      traceId = found;
    }
    const spans = await this.getSpansById(traceId);
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
      // The resolved platform id — under tag correlation this is NOT the runId the caller asked with, which is
      // exactly why it has to travel: nothing downstream could reconstruct it.
      traceId,
    };
  }

  async inspect(traceId: string, mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    const spans = await this.getSpansById(traceId);
    const m = mapping ?? this.opts.mapping;
    const evidence = await extractEvidence(
      spans,
      m,
      this.opts.fetchImpl ?? fetch,
      this.opts.headers,
      this.opts.endpoint,
      this.opts.artifactBaseUrl,
    );
    const provenance = provenanceFromSpans(spans); // span attrs carry everdict.scorecard_id/harness (OTLP)
    return {
      rawAttributes: spansToRawAttributes(spans),
      events: withEvidenceEvents(spansToTraceEvents(spans, m), evidence),
      ...(provenance ? { provenance } : {}),
      ...(evidence ? { evidence } : {}),
      detail: { rollup: summarizeSpans(spans), spans: spansToSpanNodes(spans, m) },
    };
  }

  async listTraces(opts?: ListTracesOptions): Promise<TraceListPage> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const experiments = opts?.scope ? [opts.scope] : (this.opts.experimentIds ?? []);
    if (experiments.length === 0) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        {},
        "MLflow trace listing requires an experiment scope (traces/search requires locations).",
      );
    }
    // Time window → traces/search `filter` on `timestamp_ms` (ms epoch), the trace request-time field (same filter
    // grammar as the live-verified `` tags.`everdict.run_id` `` tag filter). Best-effort — if a server rejects the
    // filter field the listing fails rather than silently widening, so this is the field to re-check first if a real
    // server 400s the list.
    const clauses: string[] = [];
    const since = opts?.since ? Date.parse(opts.since) : Number.NaN;
    const until = opts?.until ? Date.parse(opts.until) : Number.NaN;
    if (!Number.isNaN(since)) clauses.push(`timestamp_ms >= ${since}`);
    if (!Number.isNaN(until)) clauses.push(`timestamp_ms <= ${until}`);
    const filter = clauses.join(" AND ");
    const res = await f(`${base}/api/3.0/mlflow/traces/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
      body: JSON.stringify({
        locations: experiments.map((id) => ({ type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: id } })),
        max_results: opts?.limit ?? 50,
        ...(filter ? { filter } : {}),
        ...(opts?.cursor ? { page_token: opts.cursor } : {}), // traces/search pages via page_token → next_page_token
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `MLflow trace list ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      traces?: MlflowTraceInfo[];
      next_page_token?: string | null;
    };
    const traces = await this.enrichListModels(mlflowTracesToSummaries(body.traces ?? [], experiments[0]));
    const next = body.next_page_token ?? undefined;
    return { traces, ...(next ? { nextCursor: next } : {}) };
  }

  // TraceInfo never carries the model (only tokens/cost — live-verified 3.11/3.14), so the list would show every row
  // model-less while the spans plainly have it. Enrich best-effort from each trace's spans: only the first
  // MODEL_ENRICH_CAP rows missing a model, MODEL_ENRICH_CONCURRENCY parallel fetches, and a per-trace failure just
  // leaves that row without a model — the list itself never fails on enrichment.
  private async enrichListModels(summaries: TraceSummary[]): Promise<TraceSummary[]> {
    const targets = summaries.filter((s) => s.llmModel === undefined).slice(0, MODEL_ENRICH_CAP);
    if (targets.length === 0) return summaries;
    const modelById = new Map<string, string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const target = targets[next];
        next += 1;
        if (!target) continue;
        try {
          const model = modelFromSpans(await this.getSpansById(target.id), this.opts.mapping);
          if (model !== undefined) modelById.set(target.id, model);
        } catch {
          // best-effort — an unreachable/malformed trace keeps its row, just without a model
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MODEL_ENRICH_CONCURRENCY, targets.length) }, worker));
    return summaries.map((s) => {
      const model = modelById.get(s.id);
      return model === undefined ? s : { ...s, llmModel: model };
    });
  }
}
