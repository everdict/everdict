import { type TraceEvent, UpstreamError } from "@everdict/core";
import type { TraceSource } from "./trace-source.js";

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
    }
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
export class PhoenixTraceSource implements TraceSource {
  constructor(private readonly opts: PhoenixTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    if (!this.opts.project)
      throw new UpstreamError("UPSTREAM_ERROR", {}, "A phoenix trace fetch requires the project setting.");
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const spans: PhoenixSpan[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ trace_id: runId, limit: "1000" });
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
    return phoenixSpansToTraceEvents(spans);
  }
}
