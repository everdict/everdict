import { UpstreamError } from "@assay/core";
import type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "./trace-sink.js";

// LangSmith 싱크 — 케이스당 run 1건(POST /runs, 클라이언트 생성 uuid + outputs 동봉 원샷), 점수는 POST /feedback.
// 실 API 검증 요점: 인증은 x-api-key 헤더(Authorization 아님), 경로는 bare(/runs·/feedback — SDK 와 동일),
// 단건 POST 는 trace_id 불요(루트 run 은 자기 id), session_name=프로젝트 이름(자동 생성).
// run 접수는 202(비동기) — 직후 feedback 이 404 날 수 있어 1회 짧게 재시도한다(SDK 도 재시도).
export interface LangsmithTraceSinkOptions {
  endpoint: string; // 예: https://api.smith.langchain.com (self-hosted 는 <host>/api/v1 일 수 있음)
  auth?: string; // API 키 값 그대로 — x-api-key 헤더로 전송
  project?: string; // session_name(프로젝트 이름). 미지정 = LangSmith 의 default 프로젝트
  webUrl?: string; // UI 베이스(미지정 = https://smith.langchain.com)
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => string;
}

// 케이스 1건 → run 생성 바디(순수). 루트 run: trace_id = 자기 id, 원샷(end_time/outputs 동봉).
export function langsmithRunBody(
  ctx: TraceSinkContext,
  c: TraceSinkCase,
  runId: string,
  nowIso: string,
  project?: string,
): Record<string, unknown> {
  const firstUser = c.trace.find((e) => e.kind === "message" && e.role === "user");
  const lastAssistant = [...c.trace].reverse().find((e) => e.kind === "message" && e.role === "assistant");
  const maxT = c.trace.reduce((m, e) => Math.max(m, e.t), 0);
  const baseMs = Date.parse(nowIso) - maxT;
  return {
    id: runId,
    trace_id: runId,
    name: `${ctx.dataset}#${c.caseId}`,
    run_type: "chain",
    start_time: new Date(baseMs).toISOString(),
    end_time: nowIso,
    inputs: {
      caseId: c.caseId,
      dataset: ctx.dataset,
      harness: ctx.harness,
      ...(firstUser?.kind === "message" ? { task: firstUser.text } : {}),
    },
    outputs: {
      events: c.trace.length,
      ...(lastAssistant?.kind === "message" ? { output: lastAssistant.text } : {}),
    },
    extra: { metadata: { scorecardId: ctx.scorecardId } },
    ...(project ? { session_name: project } : {}),
  };
}

// 점수 1건 → feedback 바디(순수). judge:<id> 는 model(LLM 저지), 그 외는 api 소스로 분류.
export function langsmithFeedbackBody(runId: string, score: TraceSinkScore): Record<string, unknown> {
  return {
    run_id: runId,
    key: score.name,
    score: score.value,
    ...(score.comment ? { comment: score.comment } : {}),
    feedback_source: { type: score.name.startsWith("judge:") ? "model" : "api" },
  };
}

export class LangsmithTraceSink implements TraceSink {
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly opts: LangsmithTraceSinkOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.nowIso = opts.now ?? (() => new Date().toISOString());
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.auth ? { "x-api-key": this.opts.auth } : {}),
    };
  }

  async export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const out: TraceSinkCaseResult[] = [];
    for (const c of cases) {
      try {
        const runId = c.externalId ?? this.newId();
        if (!c.externalId) {
          const res = await f(`${base}/runs`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(langsmithRunBody(ctx, c, runId, this.nowIso(), this.opts.project)),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            out.push({ caseId: c.caseId, error: `LangSmith run 생성 ${res.status}: ${text.slice(0, 200)}` });
            continue;
          }
        }
        let scoreError: string | undefined;
        for (const s of c.scores) {
          const body = JSON.stringify(langsmithFeedbackBody(runId, s));
          let res = await f(`${base}/feedback`, { method: "POST", headers: this.headers(), body });
          if (res.status === 404) {
            // run 접수(202)가 비동기라 직후 feedback 이 404 날 수 있다 — 잠깐 대기 후 1회 재시도.
            await new Promise((r) => setTimeout(r, 300));
            res = await f(`${base}/feedback`, { method: "POST", headers: this.headers(), body });
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            scoreError = `LangSmith feedback(${s.name}) ${res.status}: ${text.slice(0, 200)}`;
            break;
          }
        }
        // 케이스 딥링크는 tenant/project uuid 가 필요해 v1 은 생략(웹 베이스만) — 후속: GET /runs/{id}.app_path.
        out.push({ caseId: c.caseId, externalId: runId, ...(scoreError ? { error: scoreError } : {}) });
      } catch (err) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `LangSmith 싱크 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const url = (this.opts.webUrl ?? "https://smith.langchain.com").replace(/\/$/, "");
    return { url, cases: out };
  }
}
