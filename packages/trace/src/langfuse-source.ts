import { type TraceEvent, UpstreamError } from "@assay/core";
import type { TraceSource } from "./trace-source.js";

// Langfuse 관측(observation) — GET /api/public/traces/{traceId} 응답의 TraceWithFullDetails.observations[].
// 실 API 검증 요점: observations 는 인라인 전체(페이지네이션 없음), 필드는 present-but-null(옵셔널 아님),
// usage 는 deprecated 이고 usageDetails/costDetails 가 현행, type 은 GENERATION/SPAN/EVENT 외에 AGENT/TOOL/
// CHAIN/RETRIEVER 등 신형 enum 도 온다(3종만 하드코딩 금지).
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

// 관측 배열 → TraceEvent[] (순수). model 있으면 llm_call, TOOL 관측은 tool_call/result 쌍, 그 외 구조 관측은 스킵.
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
    }
    // GENERATION 외의 구조 관측(SPAN/CHAIN/AGENT 등, model 없음)은 스킵 — 지표 파생에 기여하지 않는다.
  }
  return out;
}

export interface LangfuseTraceSourceOptions {
  endpoint: string;
  auth?: string; // Authorization 헤더 '값' 그대로("Basic <base64(pk:sk)>"). SecretStore 에서 주입.
  fetchImpl?: typeof fetch; // 테스트 주입
}

// Langfuse 에서 runId(=traceId)로 trace 상세를 가져와 TraceEvent 로 정규화(관측 인라인 전체 — 커서 없음).
export class LangfuseTraceSource implements TraceSource {
  constructor(private readonly opts: LangfuseTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/public/traces/${encodeURIComponent(runId)}`, {
      ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
    });
    if (res.status === 404) return []; // 트레이스가 아직 없으면 0건으로 degrade(소스 공통 규칙)
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `Langfuse 트레이스 조회 ${res.status}: ${text.slice(0, 200)}`,
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
}
