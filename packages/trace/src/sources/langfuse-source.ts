import {
  type BrowsableTraceSource,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceSummary,
  UpstreamError,
} from "@everdict/contracts";

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
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

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

// Langfuse GET /api/public/traces list item (selected fields — the paginated { data, meta } response).
interface LangfuseTraceListItem {
  id?: string;
  name?: string | null;
  timestamp?: string | null; // ISO-8601 start
  latency?: number | null; // seconds (float)
  totalCost?: number | null;
  tags?: string[] | null;
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
    out.push({
      id: it.id,
      ...(it.name ? { name: it.name } : {}),
      ...(it.timestamp ? { startedAt: it.timestamp } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tags ? { tags } : {}),
      ...(scope ? { scope } : {}),
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
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/public/traces/${encodeURIComponent(runId)}`, {
      ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
    });
    if (res.status === 404) return []; // if the trace isn't present yet, degrade to 0 events (the shared source rule)
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `Langfuse trace fetch ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    let body: LangfuseTraceDetail;
    try {
      body = (await res.json()) as LangfuseTraceDetail;
    } catch {
      return [];
    }
    return langfuseObservationsToTraceEvents(body.observations ?? []);
  }

  // Native kind: fixed converter, no per-harness SpanAttrMapping — mapping ignored, no rawAttributes.
  async inspect(traceId: string, _mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    return { events: await this.fetch(traceId) };
  }

  async listTraces(opts?: ListTracesOptions): Promise<TraceSummary[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const qs = new URLSearchParams({ limit: String(opts?.limit ?? 50), page: "1" });
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
    const body = (await res.json().catch(() => ({}))) as { data?: LangfuseTraceListItem[] };
    return langfuseTracesToSummaries(body.data ?? [], opts?.scope);
  }
}
