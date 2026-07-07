import { UpstreamError } from "@everdict/core";
import type { TraceSink, TraceSinkCase, TraceSinkCaseResult, TraceSinkContext, TraceSinkResult } from "./trace-sink.js";

// Langfuse 싱크 — 전 케이스를 배치 ingestion 으로(POST /api/public/ingestion), 점수는 score-create 이벤트.
// 실 API 검증 요점: 인증은 Basic base64(pk:sk) 그대로, 이벤트 envelope id=중복제거 키·body.id=엔티티 upsert 키,
// usage 대신 usageDetails(+costDetails)가 현행, 응답은 207(성공/실패 혼재 — errors[] 로 케이스 격리).
// 배치 상한 3.5MB(서버 고정) — 직렬화 크기 기준으로 청크 분할해 여러 번 보낸다(이벤트 순서 보존).
export interface LangfuseTraceSinkOptions {
  endpoint: string;
  auth?: string; // Authorization 헤더 '값' 그대로("Basic <base64(pk:sk)>")
  project?: string; // projectId — 딥링크용(없으면 /trace/{id} 리다이렉트 사용)
  webUrl?: string;
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => string;
}

interface LangfuseEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
  // envelope 이벤트 → 케이스 역매핑용(전송 전 제거하지 않아도 무해하나, 전송 바디엔 싣지 않는다)
}

// 케이스들 → ingestion 이벤트 배열(순수 — 단위 테스트 대상). 반환: 이벤트 + 이벤트id→caseId 역매핑 + 케이스별 traceId.
export function langfuseBatch(
  ctx: TraceSinkContext,
  cases: TraceSinkCase[],
  newId: () => string,
  nowIso: () => string,
): { events: LangfuseEvent[]; eventCase: Map<string, string>; traceIdByCase: Map<string, string> } {
  const events: LangfuseEvent[] = [];
  const eventCase = new Map<string, string>();
  const traceIdByCase = new Map<string, string>();
  const now = nowIso();
  const push = (caseId: string, type: string, body: Record<string, unknown>): void => {
    const id = newId();
    events.push({ id, type, timestamp: now, body });
    eventCase.set(id, caseId);
  };
  for (const c of cases) {
    const traceId = c.externalId ?? newId();
    traceIdByCase.set(c.caseId, traceId);
    const maxT = c.trace.reduce((m, e) => Math.max(m, e.t), 0);
    const baseMs = Date.parse(now) - maxT; // 상대 t(ms) → 절대 시각(막 끝난 것으로 정렬)
    if (!c.externalId) {
      // create 모드 — trace + 관측(generation/span). attach 모드는 기존 trace 에 score 만.
      const firstUser = c.trace.find((e) => e.kind === "message" && e.role === "user");
      const lastAssistant = [...c.trace].reverse().find((e) => e.kind === "message" && e.role === "assistant");
      push(c.caseId, "trace-create", {
        id: traceId,
        timestamp: new Date(baseMs).toISOString(),
        name: `${ctx.dataset}#${c.caseId}`,
        ...(firstUser?.kind === "message" ? { input: firstUser.text } : {}),
        ...(lastAssistant?.kind === "message" ? { output: lastAssistant.text } : {}),
        metadata: { scorecardId: ctx.scorecardId, dataset: ctx.dataset, harness: ctx.harness, caseId: c.caseId },
      });
      for (const e of c.trace) {
        if (e.kind === "llm_call") {
          push(c.caseId, "generation-create", {
            id: newId(),
            traceId,
            name: e.model || "llm_call",
            startTime: new Date(baseMs + e.t).toISOString(),
            endTime: new Date(baseMs + e.t + (e.latencyMs ?? 0)).toISOString(),
            model: e.model,
            ...(e.cost
              ? {
                  usageDetails: { input: e.cost.inputTokens, output: e.cost.outputTokens },
                  costDetails: { total: e.cost.usd },
                }
              : {}),
          });
        } else if (e.kind === "tool_call") {
          const result = c.trace.find((r) => r.kind === "tool_result" && r.id === e.id);
          push(c.caseId, "span-create", {
            id: newId(),
            traceId,
            name: e.name,
            startTime: new Date(baseMs + e.t).toISOString(),
            ...(result ? { endTime: new Date(baseMs + result.t).toISOString() } : {}),
            ...(result?.kind === "tool_result" ? { output: result.output.slice(0, 2000) } : {}),
            level: result?.kind === "tool_result" && !result.ok ? "ERROR" : "DEFAULT",
          });
        }
      }
    }
    for (const s of c.scores) {
      push(c.caseId, "score-create", {
        id: newId(),
        traceId,
        name: s.name,
        value: s.value,
        dataType: "NUMERIC",
        ...(s.comment ? { comment: s.comment } : {}),
      });
    }
  }
  return { events, eventCase, traceIdByCase };
}

// 배치 상한(3.5MB)보다 보수적인 3MB 로 청크 분할(순수). 이벤트 하나가 상한을 넘는 극단은 단독 청크로 보낸다
// (서버가 그 이벤트만 errors[] 로 거절 → 케이스 격리로 흡수, 조용한 드랍 없음).
export function chunkLangfuseEvents<T>(events: T[], maxBytes = 3_000_000): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const e of events) {
    const s = JSON.stringify(e).length + 1;
    if (current.length > 0 && size + s > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class LangfuseTraceSink implements TraceSink {
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly opts: LangfuseTraceSinkOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.nowIso = opts.now ?? (() => new Date().toISOString());
  }

  private caseUrl(traceId: string): string {
    const web = (this.opts.webUrl ?? this.opts.endpoint).replace(/\/$/, "");
    // projectId 를 알면 정식 라우트, 모르면 서버측 리다이렉트(/trace/{id}).
    return this.opts.project
      ? `${web}/project/${encodeURIComponent(this.opts.project)}/traces/${encodeURIComponent(traceId)}`
      : `${web}/trace/${encodeURIComponent(traceId)}`;
  }

  async export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const { events, eventCase, traceIdByCase } = langfuseBatch(ctx, cases, this.newId, this.nowIso);
    // 3.5MB 배치 상한 대응 — 청크로 나눠 순차 전송, 207 errors[] 는 청크 전체에서 수집한다.
    const failedCase = new Map<string, string>();
    for (const chunk of chunkLangfuseEvents(events)) {
      const res = await f(`${base}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.auth ? { authorization: this.opts.auth } : {}),
        },
        body: JSON.stringify({ batch: chunk }),
      });
      if (!res.ok && res.status !== 207) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `Langfuse ingestion ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      // 207: errors[] 의 envelope 이벤트 id → 케이스로 역매핑(부분 실패 격리).
      let body: { errors?: Array<{ id?: string; message?: string; error?: unknown }> } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // 빈/비 JSON 응답은 전건 성공으로 취급(2xx 였으므로)
      }
      for (const e of body.errors ?? []) {
        const caseId = e.id ? eventCase.get(e.id) : undefined;
        if (caseId && !failedCase.has(caseId)) failedCase.set(caseId, e.message ?? "ingestion 이벤트 실패");
      }
    }
    const out: TraceSinkCaseResult[] = cases.map((c) => {
      const traceId = traceIdByCase.get(c.caseId);
      const error = failedCase.get(c.caseId);
      return {
        caseId: c.caseId,
        ...(traceId ? { externalId: traceId, url: this.caseUrl(traceId) } : {}),
        ...(error ? { error } : {}),
      };
    });
    const web = (this.opts.webUrl ?? this.opts.endpoint).replace(/\/$/, "");
    const url = this.opts.project ? `${web}/project/${encodeURIComponent(this.opts.project)}/traces` : undefined;
    return { ...(url ? { url } : {}), cases: out };
  }
}
