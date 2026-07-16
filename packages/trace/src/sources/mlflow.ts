import {
  type BrowsableTraceSource,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceSummary,
  UpstreamError,
} from "@everdict/contracts";
import { type Span, spansToRawAttributes, spansToSpanNodes, spansToTraceEvents, summarizeSpans } from "./trace-source.js";

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
  execution_duration_ms?: number;
  execution_time_ms?: number;
  state?: string; // OK|ERROR|IN_PROGRESS|STATE_UNSPECIFIED
  status?: string; // older
  tags?: Record<string, string> | Array<{ key?: string; value?: string }>;
  trace_metadata?: Record<string, string>;
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

// Pure: MLflow TraceInfo[] → summaries. scope = the experiment id listed under.
export function mlflowTracesToSummaries(traces: MlflowTraceInfo[], scope?: string): TraceSummary[] {
  const out: TraceSummary[] = [];
  for (const info of traces) {
    if (!info.trace_id) continue;
    const startedAt = mlflowStartedAt(info);
    const durationRaw = info.execution_duration_ms ?? info.execution_time_ms;
    const status = mlflowStatus(info);
    const tags = mlflowTags(info);
    const tokens = mlflowTokens(info);
    out.push({
      id: info.trace_id,
      ...(startedAt ? { startedAt } : {}),
      ...(typeof durationRaw === "number" ? { durationMs: Math.max(0, durationRaw) } : {}),
      ...(status ? { status } : {}),
      ...(tags ? { tags } : {}),
      ...(tokens ? { tokens } : {}),
      ...(scope ? { scope } : {}),
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
  experimentIds?: string[]; // search scope for tag correlation (MLflow 3.x traces/search requires locations)
  mapping?: SpanAttrMapping; // per-harness span-attribute overrides (non-GenAI-convention instrumentation)
}

const RUN_ID_TAG = "everdict.run_id"; // the correlation tag the instrumented agent writes (same value as the injected env EVERDICT_RUN_ID)

// Fetch the trace from the MLflow 3.x tracing REST (`GET /api/3.0/mlflow/traces/get?trace_id=`) and normalize to TraceEvents.
// With correlate="tag", first find the trace_id via `POST /api/3.0/mlflow/traces/search` (tags.`everdict.run_id` filter, verified on real 3.14)
// — not found → degrade to 0 events (same as id mode's 404).
export class MlflowTraceSource implements BrowsableTraceSource {
  constructor(private readonly opts: MlflowTraceSourceOptions) {}

  private async traceIdByTag(runId: string): Promise<string | undefined> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const experiments = this.opts.experimentIds ?? [];
    if (experiments.length === 0) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { correlate: "tag" },
        "MLflow tag correlation requires an experiment scope (traces/search requires locations).",
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
        `MLflow trace search ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { traces?: Array<{ trace_id?: string }> };
    return body.traces?.[0]?.trace_id;
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
    let traceId = runId;
    if (this.opts.correlate === "tag") {
      const found = await this.traceIdByTag(runId);
      if (!found) return []; // tag not found — not arrived/tagged yet (flush lag) → degrade to 0 events
      traceId = found;
    }
    return spansToTraceEvents(await this.getSpansById(traceId), this.opts.mapping);
  }

  async inspect(traceId: string, mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    const spans = await this.getSpansById(traceId);
    const m = mapping ?? this.opts.mapping;
    return {
      rawAttributes: spansToRawAttributes(spans),
      events: spansToTraceEvents(spans, m),
      detail: { rollup: summarizeSpans(spans), spans: spansToSpanNodes(spans, m) },
    };
  }

  async listTraces(opts?: ListTracesOptions): Promise<TraceSummary[]> {
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
    const res = await f(`${base}/api/3.0/mlflow/traces/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
      body: JSON.stringify({
        locations: experiments.map((id) => ({ type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: id } })),
        max_results: opts?.limit ?? 50,
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
    const body = (await res.json().catch(() => ({}))) as { traces?: MlflowTraceInfo[] };
    return mlflowTracesToSummaries(body.traces ?? [], experiments[0]);
  }
}
