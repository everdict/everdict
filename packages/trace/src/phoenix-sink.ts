import { UpstreamError } from "@everdict/core";
import type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "./trace-sink.js";

// Arize Phoenix 싱크 — 스팬은 JSON 전용 REST(POST /v1/projects/{p}/spans, ≥10.12)로, 점수는 trace annotations.
// 실 API 검증 요점: /v1/traces 는 protobuf 전용(OTLP/JSON 미수용 — JSON 어댑터는 projects/{p}/spans 를 쓴다),
// id 는 OTel hex(trace 32/span 16, 0x 없이), 시간은 timezone-aware ISO, 배치는 케이스 단위로 쪼개 all-or-nothing
// 실패를 케이스로 격리. 접수는 202(큐잉)라 annotation 은 sync=false(기본)로 enqueue 한다(직후 404 회피).
export interface PhoenixTraceSinkOptions {
  endpoint: string;
  auth?: string; // Authorization 헤더 '값' 그대로("Bearer <key>")
  project?: string; // 프로젝트 이름/ID — 스팬 생성(create 모드) 필수
  webUrl?: string;
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => string;
}

// uuid → OTel hex id(대시 제거). trace=32자, span=앞 16자.
function hex32(newId: () => string): string {
  return newId().replace(/-/g, "").slice(0, 32).padEnd(32, "0");
}

// 케이스 1건 → Phoenix JSON 스팬 배열(순수). 루트 CHAIN 스팬 + llm_call→LLM · tool_call→TOOL 자식 스팬.
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

// 점수 1건 → trace annotation(순수). judge:<id> → LLM, 그 외 → CODE.
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
            out.push({ caseId: c.caseId, error: "phoenix 스팬 생성엔 project 설정이 필요합니다." });
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
            out.push({ caseId: c.caseId, error: `Phoenix 스팬 생성 ${res.status}: ${text.slice(0, 200)}` });
            continue;
          }
        }
        // 점수 부착 — 케이스당 1콜(배치). 스팬 접수(202)가 큐잉이라 sync=false 로 enqueue(직후 404 회피).
        const tid = traceId; // let 좁힘은 클로저에 보존되지 않아 const 로 고정
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
          // OTel trace id 만으로 도달하는 서버측 리다이렉트(프로젝트 GlobalID 불요, 2025+ 서버).
          url: `${web}/redirects/traces/${traceId}`,
          ...(scoreError ? { error: scoreError } : {}),
        });
      } catch (err) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `Phoenix 싱크 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const url = this.opts.project ? `${web}/projects` : undefined;
    return { ...(url ? { url } : {}), cases: out };
  }
}
