import { type TraceEvent, UpstreamError } from "@everdict/core";
import type { TraceSource } from "./trace-source.js";

// LangSmith run — POST /runs/query {trace:<trace_id>} 응답의 RunSchema(선택 필드만).
// 실 API 검증 요점: 인증은 X-API-Key 헤더(bare 경로 = SDK 와 동일), 트레이스 전체 조회는 v1 /runs/query 의
// `trace` 필터(v2 는 project_ids 필수+기본 1일 시간창이라 부적합), 페이지네이션은 cursors.next 를 body.cursor 로
// 되돌리는 루프, total_cost 는 JSON 숫자가 아니라 '십진 문자열'(Number() 파싱 필요).
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
  total_cost?: string | null; // 십진 문자열
  extra?: { metadata?: Record<string, unknown> | null } | null;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

// run 배열 → TraceEvent[] (순수). llm run → llm_call(모델은 ls_model_name 메타 → run name 폴백),
// tool run → tool_call/result 쌍(ok = error 없음), 그 외(chain 등 구조 run)는 스킵.
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
          usd: r.total_cost ? Number(r.total_cost) : 0, // 십진 문자열 → 숫자
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
  endpoint: string; // 예: https://api.smith.langchain.com
  auth?: string; // API 키 값 그대로 — x-api-key 헤더로 전송(Authorization 아님)
  fetchImpl?: typeof fetch; // 테스트 주입
}

// LangSmith 에서 runId(=trace_id uuid)로 그 트레이스의 run 전체를 커서 루프로 가져와 TraceEvent 로 정규화.
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
      if (res.status === 404) return []; // 트레이스가 아직 없으면 0건으로 degrade(소스 공통 규칙)
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `LangSmith 트레이스 조회 ${res.status}: ${text.slice(0, 200)}`,
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
