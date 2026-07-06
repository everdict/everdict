import { UpstreamError } from "@assay/core";
import type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "./trace-sink.js";

// MLflow 3.x 싱크 — 점수는 assessments REST(≥3.2), trace 생성은 StartTraceV3(trace_info) + OTLP 스팬 업로드.
// 실 API 검증 요점: 필드는 snake_case, 점수 필드명은 `assessment_name`(name 아님), source_type/source_id 필수,
// rationale 은 feedback 밖 최상위. StartTraceV3 의 spans 배열은 서버가 무시한다 — 스팬은 별도의
// POST {host}/v1/traces (OTLP, `x-mlflow-experiment-id` 헤더 필수)로 올리며 OTLP/JSON 은 서버 ≥3.12 부터
// (3.4–3.11 은 protobuf 전용). 그래서 스팬 업로드는 best-effort: 실패해도 trace_info+assessments 는 유효하므로
// 케이스를 실패로 만들지 않는다(구버전 서버에서 스팬만 빠진 trace 로 degrade).
export interface MlflowTraceSinkOptions {
  endpoint: string;
  auth?: string; // Authorization 헤더 '값' 그대로(Basic …). 무인증 서버는 생략
  project?: string; // experiment_id — trace 생성(create 모드)과 딥링크에 필요
  webUrl?: string; // UI 베이스(미지정 = endpoint)
  fetchImpl?: typeof fetch;
  newId?: () => string; // 테스트 주입(trace id 생성)
  now?: () => string;
}

// judge:<id> 점수는 LLM_JUDGE, 그 외(결과/트레이스 그레이더)는 CODE — MLflow assessment source 분류.
function sourceType(name: string): "LLM_JUDGE" | "CODE" {
  return name.startsWith("judge:") ? "LLM_JUDGE" : "CODE";
}

// 점수 1건 → CreateAssessment 요청 바디(순수 — 단위 테스트 대상).
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

// 케이스 1건 → StartTraceV3 요청 바디(순수). 프리뷰는 트레이스의 첫 user 메시지/마지막 assistant 메시지.
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
          "assay.scorecardId": ctx.scorecardId,
          "assay.dataset": ctx.dataset,
          "assay.harness": ctx.harness,
          "assay.caseId": c.caseId,
        },
        tags: {},
      },
    },
  };
}

// OTLP JSON AnyValue — 스팬 속성 값(camelCase; MLflow 응답의 snake_case 와 별개인 OTLP 요청 포맷).
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
      out.push({ key, value: { intValue: String(v) } }); // OTLP int64 = 문자열
    else out.push({ key, value: { doubleValue: v } });
  }
  return out;
}

// 케이스 1건 → OTLP/JSON ExportTraceServiceRequest(순수). 속성은 우리 spansToTraceEvents 가 읽는
// OTel GenAI 관례(gen_ai.*/tool.*/message.content)로 방출 — pull 로 되읽으면 같은 TraceEvent 로 왕복된다.
export function mlflowOtlpSpans(
  ctx: TraceSinkContext,
  c: TraceSinkCase,
  traceIdHex: string, // "tr-" 접두 없는 32-hex(OTel trace id) — MLflow 가 tr-<hex> TraceInfo 에 조인한다
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
      attributes: otlpAttrs({ "assay.scorecard_id": ctx.scorecardId, "assay.harness": ctx.harness }),
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
        resource: { attributes: otlpAttrs({ "service.name": "assay" }) },
        scopeSpans: [{ scope: { name: "assay" }, spans }],
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
    // MLflow ≥3.6 UI 라우트(해시 라우터) — selectedEvaluationId 로 trace 를 선택.
    return `${this.web}/#/experiments/${encodeURIComponent(this.opts.project)}/traces?selectedEvaluationId=${encodeURIComponent(traceId)}`;
  }

  async export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const out: TraceSinkCaseResult[] = [];
    for (const c of cases) {
      try {
        let traceId = c.externalId;
        if (!traceId) {
          // create 모드 — experiment 좌표(project) 없이는 trace 를 만들 수 없다(정직한 케이스 실패).
          const project = this.opts.project;
          if (!project) {
            out.push({ caseId: c.caseId, error: "mlflow trace 생성엔 project(experiment_id) 설정이 필요합니다." });
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
            out.push({ caseId: c.caseId, error: `MLflow trace 생성 ${res.status}: ${text.slice(0, 200)}` });
            continue;
          }
          // 스팬 업로드(OTLP/JSON, 서버 ≥3.12) — best-effort: 구버전(protobuf 전용)/미지원이면 스팬만 빠진
          // trace 로 degrade(trace_info+assessments 는 유효하므로 케이스 실패로 만들지 않는다).
          await f(`${this.base}/v1/traces`, {
            method: "POST",
            headers: { ...this.headers(), "x-mlflow-experiment-id": project },
            body: JSON.stringify(mlflowOtlpSpans(ctx, c, hex, this.nowIso(), this.newId)),
          }).catch(() => undefined);
        }
        // 점수 부착 — assessment 하나당 1콜. 첫 실패에서 케이스를 실패로 격리(나머지 케이스는 계속).
        let scoreError: string | undefined;
        for (const s of c.scores) {
          const res = await f(`${this.base}/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}/assessments`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(mlflowAssessmentBody(s, `assay:${ctx.scorecardId}`)),
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
        // 연결 수준 실패 — 전 케이스가 같은 원인일 가능성이 높아 전면 실패로 승격.
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `MLflow 싱크 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const url = this.opts.project
      ? `${this.web}/#/experiments/${encodeURIComponent(this.opts.project)}/traces`
      : undefined;
    return { ...(url ? { url } : {}), cases: out };
  }
}
