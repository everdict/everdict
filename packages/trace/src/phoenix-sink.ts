import { UpstreamError } from "@everdict/core";
import type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "./trace-sink.js";

// Arize Phoenix sink — spans go via JSON-only REST (POST /v1/projects/{p}/spans, ≥10.12), scores via trace annotations.
// Real-API notes: /v1/traces is protobuf-only (doesn't accept OTLP/JSON — the JSON adapter uses projects/{p}/spans),
// ids are OTel hex (trace 32 / span 16, no 0x), times are timezone-aware ISO, and batches are split per case to isolate
// an all-or-nothing failure to that case. Ingest is 202 (queued), so annotations are enqueued with sync=false (default) (avoids an immediate 404).
export interface PhoenixTraceSinkOptions {
  endpoint: string;
  auth?: string; // the Authorization header 'value' verbatim ("Bearer <key>")
  project?: string; // project name/ID — required for span creation (create mode)
  webUrl?: string;
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => string;
}

// uuid → OTel hex id (dashes removed). trace=32 chars, span=first 16.
function hex32(newId: () => string): string {
  return newId().replace(/-/g, "").slice(0, 32).padEnd(32, "0");
}

// One case → a Phoenix JSON span array (pure). A root CHAIN span + child spans: llm_call→LLM, tool_call→TOOL.
export function phoenixSpans(
  ctx: TraceSinkContext,
  c: TraceSinkCase,
  traceId: string,
  nowIso: string,
  newId: () => string,
): Array<Record<string, unknown>> {
  const maxT = c.trace.reduce((m, e) => Math.max(m, e.t), 0);
  const baseMs = Date.parse(nowIso) - maxT;
  const rootSpanId = hex32(newId).slice(0, 16);
  const spans: Array<Record<string, unknown>> = [
    {
      name: `${ctx.dataset}#${c.caseId}`,
      context: { trace_id: traceId, span_id: rootSpanId },
      span_kind: "CHAIN",
      parent_id: null,
      start_time: new Date(baseMs).toISOString(),
      end_time: new Date(baseMs + maxT).toISOString(),
      status_code: "OK",
      status_message: "",
      attributes: {
        "openinference.span.kind": "CHAIN",
        "everdict.scorecard_id": ctx.scorecardId,
        "everdict.harness": ctx.harness,
      },
      events: [],
    },
  ];
  for (const e of c.trace) {
    if (e.kind === "llm_call") {
      spans.push({
        name: e.model || "llm_call",
        context: { trace_id: traceId, span_id: hex32(newId).slice(0, 16) },
        span_kind: "LLM",
        parent_id: rootSpanId,
        start_time: new Date(baseMs + e.t).toISOString(),
        end_time: new Date(baseMs + e.t + (e.latencyMs ?? 0)).toISOString(),
        status_code: "OK",
        status_message: "",
        attributes: {
          "openinference.span.kind": "LLM",
          "llm.model_name": e.model,
          ...(e.cost
            ? { "llm.token_count.prompt": e.cost.inputTokens, "llm.token_count.completion": e.cost.outputTokens }
            : {}),
        },
        events: [],
      });
    } else if (e.kind === "tool_call") {
      const result = c.trace.find((r) => r.kind === "tool_result" && r.id === e.id);
      const ok = result?.kind === "tool_result" ? result.ok : true;
      spans.push({
        name: e.name,
        context: { trace_id: traceId, span_id: hex32(newId).slice(0, 16) },
        span_kind: "TOOL",
        parent_id: rootSpanId,
        start_time: new Date(baseMs + e.t).toISOString(),
        end_time: new Date(baseMs + (result?.t ?? e.t)).toISOString(),
        status_code: ok ? "OK" : "ERROR",
        status_message: "",
        attributes: { "openinference.span.kind": "TOOL" },
        events: [],
      });
    }
  }
  return spans;
}

// One score → a trace annotation (pure). judge:<id> → LLM, otherwise → CODE.
export function phoenixAnnotation(traceId: string, score: TraceSinkScore): Record<string, unknown> {
  return {
    name: score.name,
    annotator_kind: score.name.startsWith("judge:") ? "LLM" : "CODE",
    trace_id: traceId,
    result: {
      score: score.value,
      ...(score.pass !== undefined ? { label: score.pass ? "pass" : "fail" } : {}),
      ...(score.comment ? { explanation: score.comment } : {}),
    },
  };
}

export class PhoenixTraceSink implements TraceSink {
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly opts: PhoenixTraceSinkOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.nowIso = opts.now ?? (() => new Date().toISOString());
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.auth ? { authorization: this.opts.auth } : {}),
    };
  }

  async export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const web = (this.opts.webUrl ?? this.opts.endpoint).replace(/\/$/, "");
    const out: TraceSinkCaseResult[] = [];
    for (const c of cases) {
      try {
        let traceId = c.externalId;
        if (!traceId) {
          if (!this.opts.project) {
            out.push({ caseId: c.caseId, error: "Phoenix span creation requires the project setting." });
            continue;
          }
          traceId = hex32(this.newId);
          const res = await f(`${base}/v1/projects/${encodeURIComponent(this.opts.project)}/spans`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ data: phoenixSpans(ctx, c, traceId, this.nowIso(), this.newId) }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            out.push({ caseId: c.caseId, error: `Phoenix span creation ${res.status}: ${text.slice(0, 200)}` });
            continue;
          }
        }
        // Attach scores — one call per case (batch). Span ingest (202) is queued, so enqueue with sync=false (avoids an immediate 404).
        const tid = traceId; // a let narrowing isn't preserved in the closure, so pin it as a const
        let scoreError: string | undefined;
        if (c.scores.length > 0) {
          const res = await f(`${base}/v1/trace_annotations`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ data: c.scores.map((s) => phoenixAnnotation(tid, s)) }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            scoreError = `Phoenix annotation ${res.status}: ${text.slice(0, 200)}`;
          }
        }
        out.push({
          caseId: c.caseId,
          externalId: traceId,
          // A server-side redirect reachable by the OTel trace id alone (no project GlobalID needed, 2025+ servers).
          url: `${web}/redirects/traces/${traceId}`,
          ...(scoreError ? { error: scoreError } : {}),
        });
      } catch (err) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `Phoenix sink connection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const url = this.opts.project ? `${web}/projects` : undefined;
    return { ...(url ? { url } : {}), cases: out };
  }
}
