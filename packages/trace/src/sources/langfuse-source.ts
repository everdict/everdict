import {
  type BrowsableTraceSource,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceListPage,
  type TraceSummary,
  UpstreamError,
  deadlineFetch,
} from "@everdict/contracts";

import { extractProvenance, previewOfPayload } from "./trace-source.js";

// Langfuse observations — TraceWithFullDetails.observations[] in the GET /api/public/traces/{traceId} response.
// Real-API notes: observations are fully inline (no pagination), fields are present-but-null (not optional),
// usage is deprecated and usageDetails/costDetails are current, and type carries newer enums (AGENT/TOOL/
// CHAIN/RETRIEVER) beyond GENERATION/SPAN/EVENT (don't hardcode only the three).
interface LangfuseObservation {
  type?: string | null;
  name?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  model?: string | null;
  usage?: { input?: number | null; output?: number | null } | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
  calculatedTotalCost?: number | null;
  output?: unknown;
  level?: string | null;
  statusMessage?: string | null;
}
interface LangfuseTraceDetail {
  observations?: LangfuseObservation[];
  metadata?: Record<string, unknown> | null; // the sink writes everdict origin here: scorecardId/dataset/harness/caseId (unprefixed)
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

// The list cursor for a page-numbered platform (Langfuse) is just the 1-based page number as a string. A missing or
// unparseable cursor is page 1 (never trust a client-supplied token to be a valid integer).
function pageFromCursor(cursor: string | undefined): number {
  const n = cursor ? Number(cursor) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// Observation array → TraceEvent[] (pure). model present → llm_call, a TOOL observation → a tool_call/result pair, other structural observations are skipped.
export function langfuseObservationsToTraceEvents(observations: LangfuseObservation[]): TraceEvent[] {
  const sorted = [...observations].sort((a, b) => ms(a.startTime) - ms(b.startTime));
  const base = ms(sorted[0]?.startTime);
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    if (!o) continue;
    const t = ms(o.startTime) - base;
    if (o.model) {
      const inTok = o.usageDetails?.input ?? o.usage?.input ?? 0;
      const outTok = o.usageDetails?.output ?? o.usage?.output ?? 0;
      const usd = o.costDetails?.total ?? o.calculatedTotalCost ?? 0;
      out.push({
        t,
        kind: "llm_call",
        model: o.model,
        cost: { inputTokens: inTok, outputTokens: outTok, usd },
        latencyMs: Math.max(0, ms(o.endTime) - ms(o.startTime)),
      });
    } else if (o.type === "TOOL") {
      const id = `${o.name ?? "tool"}-${i}`;
      out.push({ t, kind: "tool_call", id, name: o.name ?? "tool", args: undefined });
      out.push({
        t: Math.max(t, ms(o.endTime) - base),
        kind: "tool_result",
        id,
        ok: o.level !== "ERROR",
        output: typeof o.output === "string" ? o.output : o.output === undefined ? "" : JSON.stringify(o.output),
      });
    } else {
      // Structural observation (SPAN/CHAIN/AGENT etc., no model) — preserved as a `span` event instead of dropped,
      // so a `span` judge requirement is satisfiable and non-LLM steps aren't silently lost.
      out.push({ t, kind: "span", name: o.name ?? o.type ?? "span" });
    }
  }
  return out;
}

// Langfuse GET /api/public/traces list item (the paginated { data, meta } response).
// The list payload carries far more than the metrics: the trace's own input/output, who ran it, which session
// it belongs to, and the `metadata` bag — which is where OUR OWN SINK writes provenance (see langfuse-sink),
// so reading only id/name/latency/cost meant an everdict-exported trace came back through the browse list with
// no origin on it at all, while the inspect dialog for the same trace showed it.
interface LangfuseTraceListItem {
  id?: string;
  name?: string | null;
  timestamp?: string | null; // ISO-8601 start
  latency?: number | null; // seconds (float)
  totalCost?: number | null;
  tags?: string[] | null;
  input?: unknown;
  output?: unknown;
  userId?: string | null;
  sessionId?: string | null;
  metadata?: unknown; // object (or a JSON string on older servers) — the sink's provenance lives here
  observations?: unknown[] | null; // the trace's observation ids — their count is the row's span count
  // Langfuse's own level vocabulary (DEBUG/DEFAULT/WARNING/ERROR): the only failure signal a trace-level row
  // carries. Without it every langfuse row rendered "unset" — a list nobody can scan for what broke.
  level?: string | null;
}

// `metadata` is documented as an object but reaches us as a JSON string from some SDK/server versions — take
// both rather than silently losing the provenance our own exporter wrote.
function langfuseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
// Pure: Langfuse trace list items → summaries. scope = the project listed under (informational).
export function langfuseTracesToSummaries(items: LangfuseTraceListItem[], scope?: string): TraceSummary[] {
  const out: TraceSummary[] = [];
  for (const it of items) {
    if (!it.id) continue;
    const durationMs = typeof it.latency === "number" ? Math.max(0, Math.round(it.latency * 1000)) : undefined;
    const costUsd = typeof it.totalCost === "number" ? Math.max(0, it.totalCost) : undefined;
    const tags =
      Array.isArray(it.tags) && it.tags.length > 0 ? Object.fromEntries(it.tags.map((t) => [t, ""])) : undefined;
    const preview = previewOfPayload(it.input) ?? previewOfPayload(it.output);
    const metadata = langfuseMetadata(it.metadata);
    const provenance = metadata !== undefined ? extractProvenance(metadata) : undefined;
    const spanCount = Array.isArray(it.observations) ? it.observations.length : undefined;
    // ERROR is a fact the trace reports about itself; every other level (DEBUG/DEFAULT/WARNING) says it ran.
    const status = typeof it.level === "string" ? (it.level.toUpperCase() === "ERROR" ? "error" : "ok") : undefined;
    out.push({
      id: it.id,
      ...(it.name ? { name: it.name } : {}),
      ...(preview ? { preview } : {}),
      ...(it.timestamp ? { startedAt: it.timestamp } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(status ? { status } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(spanCount !== undefined ? { spanCount } : {}),
      ...(tags ? { tags } : {}),
      ...(it.userId ? { userId: it.userId } : {}),
      ...(it.sessionId ? { sessionId: it.sessionId } : {}),
      ...(scope ? { scope } : {}),
      ...(provenance ? { provenance } : {}),
    });
  }
  return out;
}

export interface LangfuseTraceSourceOptions {
  endpoint: string;
  auth?: string; // the Authorization header 'value' verbatim ("Basic <base64(pk:sk)>"). Injected from the SecretStore.
  fetchImpl?: typeof fetch; // test injection
}

// Fetch the trace detail from Langfuse by runId (=traceId) and normalize to TraceEvents (observations fully inline — no cursor).
export class LangfuseTraceSource implements BrowsableTraceSource {
  constructor(private readonly opts: LangfuseTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const detail = await this.fetchTrace(runId);
    return langfuseObservationsToTraceEvents(detail?.observations ?? []);
  }

  // GET the trace detail (observations + metadata) — shared by fetch + inspect (inspect also reads metadata for
  // provenance). 404/parse-failure → undefined (degrade to 0 events, the shared source rule).
  private async fetchTrace(runId: string): Promise<LangfuseTraceDetail | undefined> {
    const f = deadlineFetch(this.opts.fetchImpl);
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/public/traces/${encodeURIComponent(runId)}`, {
      ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `Langfuse trace fetch ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    try {
      return (await res.json()) as LangfuseTraceDetail;
    } catch {
      return undefined;
    }
  }

  // Native kind: fixed converter, no per-harness SpanAttrMapping — mapping ignored, no rawAttributes.
  async inspect(traceId: string, _mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    const detail = await this.fetchTrace(traceId);
    const provenance = detail?.metadata ? extractProvenance(detail.metadata) : undefined;
    return {
      events: langfuseObservationsToTraceEvents(detail?.observations ?? []),
      ...(provenance ? { provenance } : {}),
    };
  }

  async listTraces(opts?: ListTracesOptions): Promise<TraceListPage> {
    const f = deadlineFetch(this.opts.fetchImpl);
    const base = this.opts.endpoint.replace(/\/$/, "");
    const limit = opts?.limit ?? 50;
    // Langfuse paginates by 1-based page number — the cursor IS the next page number (default page 1).
    const page = pageFromCursor(opts?.cursor);
    const qs = new URLSearchParams({ limit: String(limit), page: String(page) });
    if (opts?.since) qs.set("fromTimestamp", opts.since);
    if (opts?.until) qs.set("toTimestamp", opts.until); // upper bound — symmetric with fromTimestamp (Langfuse public API)
    const res = await f(`${base}/api/public/traces?${qs.toString()}`, {
      ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `Langfuse trace list ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: LangfuseTraceListItem[];
      meta?: { totalPages?: number | null };
    };
    const items = body.data ?? [];
    const traces = langfuseTracesToSummaries(items, opts?.scope);
    // Prefer the API's totalPages; fall back to inferring "a full page ⇒ maybe more" when meta is absent.
    const totalPages = body.meta?.totalPages;
    const hasMore = typeof totalPages === "number" ? page < totalPages : items.length >= limit;
    return { traces, ...(hasMore ? { nextCursor: String(page + 1) } : {}) };
  }
}
