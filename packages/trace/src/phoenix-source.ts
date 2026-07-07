import { type TraceEvent, UpstreamError } from "@everdict/core";
import type { TraceSource } from "./trace-source.js";

// Arize Phoenix 스팬 — GET /v1/projects/{p}/spans?trace_id=<hex> 응답(Span 스키마, 읽기 쪽).
// 실 API 검증 요점: GET /v1/traces/{id} 는 없다 — trace_id 필터(≥13.9.0)로 프로젝트 스팬을 커서 루프 조회.
// 읽기 응답의 attributes 는 '중첩' JSON(attributes.llm.token_count.prompt)이고 쓰기(생성)는 평면 dotted 키라
// 양쪽을 방어적으로 정규화한다. project(이름/ID)가 경로에 필수.
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

// 중첩/평면 혼재 속성에서 dotted 경로 값 꺼내기 — 평면("llm.model_name") 우선, 없으면 중첩(llm→model_name).
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

// 스팬 배열 → TraceEvent[] (순수). LLM 스팬 → llm_call(OpenInference llm.* 관례), TOOL 스팬 → tool 쌍,
// 그 외 구조 스팬(CHAIN/AGENT 등)은 스킵.
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
          usd: 0, // Phoenix 는 1급 비용 필드가 없다 — 토큰만(비용은 미보고가 정직)
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
  auth?: string; // Authorization 헤더 '값' 그대로("Bearer <key>")
  project?: string; // 프로젝트 이름/ID — 스팬 조회 경로에 필수
  fetchImpl?: typeof fetch; // 테스트 주입
}

// Phoenix 에서 runId(=OTel hex trace id)로 스팬을 커서 루프로 가져와 TraceEvent 로 정규화.
export class PhoenixTraceSource implements TraceSource {
  constructor(private readonly opts: PhoenixTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    if (!this.opts.project)
      throw new UpstreamError("UPSTREAM_ERROR", {}, "phoenix 트레이스 조회엔 project 설정이 필요합니다.");
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
      if (res.status === 404) return []; // 프로젝트/트레이스 부재 → 0건 degrade(소스 공통 규칙)
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `Phoenix 트레이스 조회 ${res.status}: ${text.slice(0, 200)}`,
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
