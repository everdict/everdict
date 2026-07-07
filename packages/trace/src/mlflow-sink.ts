import { UpstreamError } from "@everdict/core";
import type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "./trace-sink.js";

// MLflow 3.x sink — scores via assessments REST (≥3.2), trace creation via StartTraceV3 (trace_info) + OTLP span upload.
// Real-API notes: fields are snake_case, the score field name is `assessment_name` (not name), source_type/source_id are required,
// and rationale is top-level, outside feedback. The server ignores the StartTraceV3 spans array — spans go via a separate
// POST {host}/v1/traces (OTLP, `x-mlflow-experiment-id` header required), and OTLP/JSON is server ≥3.12
// (3.4–3.11 are protobuf-only). So span upload is best-effort: a failure still leaves trace_info+assessments valid, so
// it doesn't make the case fail (on older servers it degrades to a trace with only the spans missing).
export interface MlflowTraceSinkOptions {
  endpoint: string;
  auth?: string; // the Authorization header 'value' verbatim (Basic …). Omit for an auth-less server
  project?: string; // experiment_id — required for trace creation (create mode) and deep links
  webUrl?: string; // UI base (unset = endpoint)
  fetchImpl?: typeof fetch;
  newId?: () => string; // test injection (trace id generation)
  now?: () => string;
}

// A judge:<id> score is LLM_JUDGE, otherwise (result/trace graders) CODE — MLflow assessment source classification.
function sourceType(name: string): "LLM_JUDGE" | "CODE" {
  return name.startsWith("judge:") ? "LLM_JUDGE" : "CODE";
}

// One score → a CreateAssessment request body (pure — unit-testable).
export function mlflowAssessmentBody(score: TraceSinkScore, sourceId: string): Record<string, unknown> {
  return {
    assessment: {
      assessment_name: score.name,
      source: { source_type: sourceType(score.name), source_id: sourceId },
      feedback: { value: score.value },
      ...(score.comment ? { rationale: score.comment } : {}),
      ...(score.pass !== undefined ? { metadata: { pass: String(score.pass) } } : {}),
    },
  };
}

// One case → a StartTraceV3 request body (pure). The preview is the trace's first user message / last assistant message.
export function mlflowTraceBody(
  ctx: TraceSinkContext,
  c: TraceSinkCase,
  traceId: string,
  experimentId: string,
  requestTime: string,
): Record<string, unknown> {
  const firstUser = c.trace.find((e) => e.kind === "message" && e.role === "user");
  const lastAssistant = [...c.trace].reverse().find((e) => e.kind === "message" && e.role === "assistant");
  const maxT = c.trace.reduce((m, e) => Math.max(m, e.t), 0);
  return {
    trace: {
      trace_info: {
        trace_id: traceId,
        trace_location: { type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: experimentId } },
        request_time: requestTime,
        execution_duration: `${(maxT / 1000).toFixed(3)}s`,
        state: "OK",
        ...(firstUser?.kind === "message" ? { request_preview: firstUser.text.slice(0, 1000) } : {}),
        ...(lastAssistant?.kind === "message" ? { response_preview: lastAssistant.text.slice(0, 1000) } : {}),
        trace_metadata: {
          "everdict.scorecardId": ctx.scorecardId,
          "everdict.dataset": ctx.dataset,
          "everdict.harness": ctx.harness,
          "everdict.caseId": c.caseId,
        },
        tags: {},
      },
    },
  };
}

// OTLP JSON AnyValue — span attribute value (camelCase; the OTLP request format, distinct from the snake_case of MLflow responses).
type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
function otlpAttrs(
  entries: Record<string, string | number | boolean | undefined>,
): Array<{ key: string; value: OtlpValue }> {
  const out: Array<{ key: string; value: OtlpValue }> = [];
  for (const [key, v] of Object.entries(entries)) {
    if (v === undefined) continue;
    if (typeof v === "string") out.push({ key, value: { stringValue: v } });
    else if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else if (Number.isInteger(v))
      out.push({ key, value: { intValue: String(v) } }); // OTLP int64 = string
    else out.push({ key, value: { doubleValue: v } });
  }
  return out;
}

// One case → an OTLP/JSON ExportTraceServiceRequest (pure). Attributes are emitted in the OTel GenAI conventions
// (gen_ai.*/tool.*/message.content) that our spansToTraceEvents reads — reading them back via pull round-trips to the same TraceEvent.
export function mlflowOtlpSpans(
  ctx: TraceSinkContext,
  c: TraceSinkCase,
  traceIdHex: string, // 32-hex without the "tr-" prefix (OTel trace id) — MLflow joins it to the tr-<hex> TraceInfo
  nowIso: string,
  newId: () => string,
): Record<string, unknown> {
  const maxT = c.trace.reduce((m, e) => Math.max(m, e.t), 0);
  const baseNs = (ms: number): string => String(BigInt(Date.parse(nowIso) - maxT + ms) * 1_000_000n);
  const spanId = (): string => newId().replace(/-/g, "").slice(0, 16);
  const rootId = spanId();
  const spans: Array<Record<string, unknown>> = [
    {
      traceId: traceIdHex,
      spanId: rootId,
      name: `${ctx.dataset}#${c.caseId}`,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: baseNs(0),
      endTimeUnixNano: baseNs(maxT),
      attributes: otlpAttrs({ "everdict.scorecard_id": ctx.scorecardId, "everdict.harness": ctx.harness }),
      status: {},
    },
  ];
  for (const e of c.trace) {
    if (e.kind === "llm_call") {
      spans.push({
        traceId: traceIdHex,
        spanId: spanId(),
        parentSpanId: rootId,
        name: e.model || "llm_call",
        kind: 1,
        startTimeUnixNano: baseNs(e.t),
        endTimeUnixNano: baseNs(e.t + (e.latencyMs ?? 0)),
        attributes: otlpAttrs({
          "gen_ai.request.model": e.model,
          "gen_ai.usage.input_tokens": e.cost?.inputTokens,
          "gen_ai.usage.output_tokens": e.cost?.outputTokens,
          "gen_ai.usage.cost": e.cost?.usd,
        }),
        status: {},
      });
    } else if (e.kind === "tool_call") {
      const result = c.trace.find((r) => r.kind === "tool_result" && r.id === e.id);
      const ok = result?.kind === "tool_result" ? result.ok : true;
      spans.push({
        traceId: traceIdHex,
        spanId: spanId(),
        parentSpanId: rootId,
        name: e.name,
        kind: 1,
        startTimeUnixNano: baseNs(e.t),
        endTimeUnixNano: baseNs(result?.t ?? e.t),
        attributes: otlpAttrs({
          "tool.name": e.name,
          "tool.call_id": e.id,
          "tool.result": result?.kind === "tool_result" ? result.output.slice(0, 2000) : undefined,
          ...(ok ? {} : { "tool.error": "true" }),
        }),
        status: {},
      });
    } else if (e.kind === "message" && e.role === "assistant") {
      spans.push({
        traceId: traceIdHex,
        spanId: spanId(),
        parentSpanId: rootId,
        name: "message",
        kind: 1,
        startTimeUnixNano: baseNs(e.t),
        endTimeUnixNano: baseNs(e.t),
        attributes: otlpAttrs({ "message.content": e.text.slice(0, 2000) }),
        status: {},
      });
    }
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttrs({ "service.name": "everdict" }) },
        scopeSpans: [{ scope: { name: "everdict" }, spans }],
      },
    ],
  };
}

export class MlflowTraceSink implements TraceSink {
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly opts: MlflowTraceSinkOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.nowIso = opts.now ?? (() => new Date().toISOString());
  }

  private get base(): string {
    return this.opts.endpoint.replace(/\/$/, "");
  }
  private get web(): string {
    return (this.opts.webUrl ?? this.opts.endpoint).replace(/\/$/, "");
  }
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.auth ? { authorization: this.opts.auth } : {}),
    };
  }

  private caseUrl(traceId: string): string | undefined {
    if (!this.opts.project) return undefined;
    // MLflow ≥3.6 UI route (hash router) — select the trace via selectedEvaluationId.
    return `${this.web}/#/experiments/${encodeURIComponent(this.opts.project)}/traces?selectedEvaluationId=${encodeURIComponent(traceId)}`;
  }

  async export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const out: TraceSinkCaseResult[] = [];
    for (const c of cases) {
      try {
        let traceId = c.externalId;
        if (!traceId) {
          // create mode — a trace can't be created without the experiment coordinate (project) (an honest case failure).
          const project = this.opts.project;
          if (!project) {
            out.push({
              caseId: c.caseId,
              error: "MLflow trace creation requires the project (experiment_id) setting.",
            });
            continue;
          }
          const hex = this.newId().replace(/-/g, "").slice(0, 32).padEnd(32, "0");
          traceId = `tr-${hex}`;
          const res = await f(`${this.base}/api/3.0/mlflow/traces`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(mlflowTraceBody(ctx, c, traceId, project, this.nowIso())),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            out.push({ caseId: c.caseId, error: `MLflow trace creation ${res.status}: ${text.slice(0, 200)}` });
            continue;
          }
          // Span upload (OTLP/JSON, server ≥3.12) — best-effort: on older (protobuf-only) / unsupported servers, degrade to
          // a trace with only the spans missing (trace_info+assessments stay valid, so it doesn't make the case fail).
          await f(`${this.base}/v1/traces`, {
            method: "POST",
            headers: { ...this.headers(), "x-mlflow-experiment-id": project },
            body: JSON.stringify(mlflowOtlpSpans(ctx, c, hex, this.nowIso(), this.newId)),
          }).catch(() => undefined);
        }
        // Attach scores — one call per assessment. Isolate the case as failed on the first failure (other cases continue).
        let scoreError: string | undefined;
        for (const s of c.scores) {
          const res = await f(`${this.base}/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}/assessments`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(mlflowAssessmentBody(s, `everdict:${ctx.scorecardId}`)),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            scoreError = `MLflow assessment(${s.name}) ${res.status}: ${text.slice(0, 200)}`;
            break;
          }
        }
        const url = this.caseUrl(traceId);
        out.push({
          caseId: c.caseId,
          externalId: traceId,
          ...(url ? { url } : {}),
          ...(scoreError ? { error: scoreError } : {}),
        });
      } catch (err) {
        // A connection-level failure — likely the same cause for all cases, so escalate to a wholesale failure.
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `MLflow sink connection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const url = this.opts.project
      ? `${this.web}/#/experiments/${encodeURIComponent(this.opts.project)}/traces`
      : undefined;
    return { ...(url ? { url } : {}), cases: out };
  }
}
