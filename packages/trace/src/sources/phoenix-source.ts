import {
  type BrowsableTraceSource,
  type ListTracesOptions,
  type SpanAttrMapping,
  type TraceEvent,
  type TraceInspectResult,
  type TraceSummary,
  UpstreamError,
} from "@everdict/contracts";

// Arize Phoenix spans — the GET /v1/projects/{p}/spans?trace_id=<hex> response (Span schema, read side).
// Real-API notes: there is no GET /v1/traces/{id} — cursor-loop the project spans via the trace_id filter (≥13.9.0).
// The read response's attributes are 'nested' JSON (attributes.llm.token_count.prompt) while write (create) uses flat dotted keys,
// so normalize both defensively. project (name/ID) is required in the path.
interface PhoenixSpan {
  name?: string;
  context?: { trace_id?: string; span_id?: string };
  span_kind?: string; // LLM|CHAIN|TOOL|AGENT|RETRIEVER|...
  start_time?: string | null;
  end_time?: string | null;
  status_code?: string; // OK|ERROR|UNSET
  status_message?: string | null;
  attributes?: Record<string, unknown>;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

// Read a dotted-path value from mixed nested/flat attributes — flat ("llm.model_name") first, else nested (llm→model_name).
function attr(attrs: Record<string, unknown> | undefined, path: string): unknown {
  if (!attrs) return undefined;
  if (path in attrs) return attrs[path];
  let cur: unknown = attrs;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !(key in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Span array → TraceEvent[] (pure). LLM span → llm_call (OpenInference llm.* convention), TOOL span → a tool pair,
// other structural spans (CHAIN/AGENT etc.) are skipped.
export function phoenixSpansToTraceEvents(spans: PhoenixSpan[]): TraceEvent[] {
  const sorted = [...spans].sort((a, b) => ms(a.start_time) - ms(b.start_time));
  const base = ms(sorted[0]?.start_time);
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s) continue;
    const t = ms(s.start_time) - base;
    if (s.span_kind === "LLM") {
      out.push({
        t,
        kind: "llm_call",
        model: str(attr(s.attributes, "llm.model_name")) ?? s.name ?? "",
        cost: {
          inputTokens: num(attr(s.attributes, "llm.token_count.prompt")),
          outputTokens: num(attr(s.attributes, "llm.token_count.completion")),
          usd: 0, // Phoenix has no first-class cost field — tokens only (not reporting the cost is honest)
        },
        latencyMs: Math.max(0, ms(s.end_time) - ms(s.start_time)),
      });
    } else if (s.span_kind === "TOOL") {
      const id = s.context?.span_id ?? `tool-${i}`;
      out.push({ t, kind: "tool_call", id, name: s.name ?? "tool", args: undefined });
      out.push({
        t: Math.max(t, ms(s.end_time) - base),
        kind: "tool_result",
        id,
        ok: s.status_code !== "ERROR",
        output: str(attr(s.attributes, "output.value")) ?? s.status_message ?? "",
      });
    } else {
      // Structural span (CHAIN/AGENT/RETRIEVER etc.) — preserved as a `span` event instead of dropped.
      out.push({ t, kind: "span", name: s.name ?? s.span_kind ?? "span" });
    }
  }
  return out;
}

// Phoenix has no first-class "list traces" REST endpoint — group the most recent project spans by trace_id (best-effort).
// LLM spans contribute tokens/model; the earliest span's name/time seed the summary. scope = the project listed under.
const phMs = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);
function phAttr(attrs: Record<string, unknown> | undefined, path: string): unknown {
  if (!attrs) return undefined;
  if (path in attrs) return attrs[path];
  let cur: unknown = attrs;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !(key in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
const phNum = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0);
const phStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function phoenixSpansToSummaries(spans: PhoenixSpan[], scope?: string): TraceSummary[] {
  const byTrace = new Map<string, PhoenixSpan[]>();
  for (const s of spans) {
    const tid = s.context?.trace_id;
    if (!tid) continue;
    const arr = byTrace.get(tid) ?? [];
    arr.push(s);
    byTrace.set(tid, arr);
  }
  const out: TraceSummary[] = [];
  for (const [id, group] of byTrace) {
    const sorted = [...group].sort((a, b) => phMs(a.start_time) - phMs(b.start_time));
    const first = sorted[0];
    const startMs = phMs(first?.start_time);
    const endMs = group.reduce((m, s) => Math.max(m, phMs(s.end_time)), startMs);
    let input = 0;
    let output = 0;
    let hasLlm = false;
    let model: string | undefined;
    let hasError = false;
    for (const s of group) {
      if (s.span_kind === "LLM") {
        hasLlm = true;
        input += phNum(phAttr(s.attributes, "llm.token_count.prompt"));
        output += phNum(phAttr(s.attributes, "llm.token_count.completion"));
        if (model === undefined) model = phStr(phAttr(s.attributes, "llm.model_name"));
      }
      if (s.status_code === "ERROR") hasError = true;
    }
    out.push({
      id,
      ...(first?.name ? { name: first.name } : {}),
      ...(startMs > 0 ? { startedAt: new Date(startMs).toISOString() } : {}),
      durationMs: Math.max(0, endMs - startMs),
      spanCount: group.length,
      status: hasError ? "error" : "ok",
      ...(hasLlm ? { tokens: { input, output } } : {}),
      ...(model ? { llmModel: model } : {}),
      ...(scope ? { scope } : {}),
    });
  }
  return out;
}

export interface PhoenixTraceSourceOptions {
  endpoint: string;
  auth?: string; // the Authorization header 'value' verbatim ("Bearer <key>")
  project?: string; // project name/ID — required in the span-query path
  fetchImpl?: typeof fetch; // test injection
}

// Fetch spans from Phoenix by runId (=OTel hex trace id) via a cursor loop and normalize to TraceEvents.
export class PhoenixTraceSource implements BrowsableTraceSource {
  constructor(private readonly opts: PhoenixTraceSourceOptions) {}

  private async spansForTrace(traceId: string): Promise<PhoenixSpan[]> {
    if (!this.opts.project)
      throw new UpstreamError("UPSTREAM_ERROR", {}, "A phoenix trace fetch requires the project setting.");
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const spans: PhoenixSpan[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ trace_id: traceId, limit: "1000" });
      if (cursor) qs.set("cursor", cursor);
      const res = await f(`${base}/v1/projects/${encodeURIComponent(this.opts.project)}/spans?${qs.toString()}`, {
        ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
      });
      if (res.status === 404) return []; // project/trace absent → degrade to 0 events (the shared source rule)
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `Phoenix trace fetch ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      let body: { data?: PhoenixSpan[]; next_cursor?: string | null };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        break;
      }
      spans.push(...(body.data ?? []));
      cursor = body.next_cursor ?? undefined;
    } while (cursor);
    return spans;
  }

  async fetch(runId: string): Promise<TraceEvent[]> {
    return phoenixSpansToTraceEvents(await this.spansForTrace(runId));
  }

  // Native kind: no per-harness SpanAttrMapping (fixed OpenInference converter) — mapping is ignored, no rawAttributes.
  async inspect(traceId: string, _mapping?: SpanAttrMapping): Promise<TraceInspectResult> {
    return { events: phoenixSpansToTraceEvents(await this.spansForTrace(traceId)) };
  }

  async listTraces(opts?: ListTracesOptions): Promise<TraceSummary[]> {
    const project = opts?.scope ?? this.opts.project;
    if (!project) throw new UpstreamError("UPSTREAM_ERROR", {}, "Phoenix trace listing requires a project scope.");
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const limit = opts?.limit ?? 50;
    // Best-effort: one recent-spans page, grouped by trace_id (Phoenix REST has no list-traces endpoint). The spans
    // endpoint filters by start_time/end_time (ISO-8601) when given.
    const qs = new URLSearchParams({ limit: "1000" });
    if (opts?.since) qs.set("start_time", opts.since);
    if (opts?.until) qs.set("end_time", opts.until);
    const res = await f(`${base}/v1/projects/${encodeURIComponent(project)}/spans?${qs.toString()}`, {
      ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `Phoenix trace list ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { data?: PhoenixSpan[] };
    const summaries = phoenixSpansToSummaries(body.data ?? [], project);
    summaries.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    return summaries.slice(0, limit);
  }
}
