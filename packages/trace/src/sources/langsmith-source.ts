import { type TraceEvent, type TraceSource, UpstreamError } from "@everdict/contracts";

// LangSmith run — RunSchema (selected fields only) from the POST /runs/query {trace:<trace_id>} response.
// Real-API notes: auth is the X-API-Key header (bare path = same as the SDK), full-trace fetch is v1 /runs/query's
// `trace` filter (v2 requires project_ids + defaults to a 1-day window, so it's unsuitable), pagination is a loop
// feeding cursors.next back as body.cursor, and total_cost is a 'decimal string', not a JSON number (needs Number() parsing).
interface LangsmithRun {
  id?: string;
  name?: string;
  run_type?: string; // tool|chain|llm|retriever|embedding|prompt|parser
  start_time?: string | null;
  end_time?: string | null;
  outputs?: Record<string, unknown> | null;
  error?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_cost?: string | null; // decimal string
  extra?: { metadata?: Record<string, unknown> | null } | null;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

// run array → TraceEvent[] (pure). llm run → llm_call (model from ls_model_name metadata → run name fallback),
// tool run → a tool_call/result pair (ok = no error), other (structural runs like chain) are skipped.
export function langsmithRunsToTraceEvents(runs: LangsmithRun[]): TraceEvent[] {
  const sorted = [...runs].sort((a, b) => ms(a.start_time) - ms(b.start_time));
  const base = ms(sorted[0]?.start_time);
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (!r) continue;
    const t = ms(r.start_time) - base;
    if (r.run_type === "llm") {
      const metaModel = r.extra?.metadata?.ls_model_name;
      out.push({
        t,
        kind: "llm_call",
        model: typeof metaModel === "string" ? metaModel : (r.name ?? ""),
        cost: {
          inputTokens: r.prompt_tokens ?? 0,
          outputTokens: r.completion_tokens ?? 0,
          usd: r.total_cost ? Number(r.total_cost) : 0, // decimal string → number
        },
        latencyMs: Math.max(0, ms(r.end_time) - ms(r.start_time)),
      });
    } else if (r.run_type === "tool") {
      const id = r.id ?? `tool-${i}`;
      out.push({ t, kind: "tool_call", id, name: r.name ?? "tool", args: undefined });
      out.push({
        t: Math.max(t, ms(r.end_time) - base),
        kind: "tool_result",
        id,
        ok: !r.error,
        output: r.error ?? (r.outputs === null || r.outputs === undefined ? "" : JSON.stringify(r.outputs)),
      });
    }
  }
  return out;
}

export interface LangsmithTraceSourceOptions {
  endpoint: string; // e.g. https://api.smith.langchain.com
  auth?: string; // the API key value verbatim — sent as the x-api-key header (not Authorization)
  fetchImpl?: typeof fetch; // test injection
}

// Fetch all runs of the trace from LangSmith by runId (=trace_id uuid) via a cursor loop and normalize to TraceEvents.
export class LangsmithTraceSource implements TraceSource {
  constructor(private readonly opts: LangsmithTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const runs: LangsmithRun[] = [];
    let cursor: string | undefined;
    do {
      const res = await f(`${base}/runs/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.auth ? { "x-api-key": this.opts.auth } : {}),
        },
        body: JSON.stringify({
          trace: runId,
          select: [
            "id",
            "name",
            "run_type",
            "start_time",
            "end_time",
            "outputs",
            "error",
            "prompt_tokens",
            "completion_tokens",
            "total_cost",
            "extra",
          ],
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      });
      if (res.status === 404) return []; // if the trace isn't present yet, degrade to 0 events (the shared source rule)
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `LangSmith trace fetch ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      let body: { runs?: LangsmithRun[]; cursors?: { next?: string | null } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        break;
      }
      runs.push(...(body.runs ?? []));
      cursor = body.cursors?.next ?? undefined;
    } while (cursor);
    return langsmithRunsToTraceEvents(runs);
  }
}
