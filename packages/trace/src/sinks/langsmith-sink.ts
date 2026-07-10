import { UpstreamError } from "@everdict/contracts";
import type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "./trace-sink.js";

// LangSmith sink — one run per case (POST /runs, a client-generated uuid + outputs in one shot), scores via POST /feedback.
// Real-API notes: auth is the x-api-key header (not Authorization), paths are bare (/runs·/feedback — same as the SDK),
// a single POST needs no trace_id (a root run is its own id), session_name = project name (auto-created).
// Run ingest is 202 (async) — feedback right after can 404, so retry once briefly (the SDK also retries).
export interface LangsmithTraceSinkOptions {
  endpoint: string; // e.g. https://api.smith.langchain.com (self-hosted may be <host>/api/v1)
  auth?: string; // the API key value verbatim — sent as the x-api-key header
  project?: string; // session_name (project name). Unset = LangSmith's default project
  webUrl?: string; // UI base (unset = https://smith.langchain.com)
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => string;
}

// One case → a run-create body (pure). Root run: trace_id = its own id, one-shot (end_time/outputs included).
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

// One score → a feedback body (pure). judge:<id> → model (LLM judge), otherwise classified as the api source.
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
            out.push({ caseId: c.caseId, error: `LangSmith run creation ${res.status}: ${text.slice(0, 200)}` });
            continue;
          }
        }
        let scoreError: string | undefined;
        for (const s of c.scores) {
          const body = JSON.stringify(langsmithFeedbackBody(runId, s));
          let res = await f(`${base}/feedback`, { method: "POST", headers: this.headers(), body });
          if (res.status === 404) {
            // run ingest (202) is async so feedback right after can 404 — wait briefly then retry once.
            await new Promise((r) => setTimeout(r, 300));
            res = await f(`${base}/feedback`, { method: "POST", headers: this.headers(), body });
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            scoreError = `LangSmith feedback(${s.name}) ${res.status}: ${text.slice(0, 200)}`;
            break;
          }
        }
        // Case deep link — join the app_path (UI path) from the GET /runs/{id} response onto the web base (best-effort).
        // Don't hand-assemble tenant/project uuids for the deep link (the SDK also uses app_path).
        const url = await this.runAppUrl(f, base, runId);
        out.push({
          caseId: c.caseId,
          externalId: runId,
          ...(url ? { url } : {}),
          ...(scoreError ? { error: scoreError } : {}),
        });
      } catch (err) {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {},
          `LangSmith sink connection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const url = (this.opts.webUrl ?? "https://smith.langchain.com").replace(/\/$/, "");
    return { url, cases: out };
  }

  // Fetch the run's UI path (app_path) — run ingest (202) is async so 404 retries once, and if still absent the link is omitted (best-effort).
  private async runAppUrl(f: typeof fetch, base: string, runId: string): Promise<string | undefined> {
    try {
      let res = await f(`${base}/runs/${encodeURIComponent(runId)}`, { headers: this.headers() });
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 300));
        res = await f(`${base}/runs/${encodeURIComponent(runId)}`, { headers: this.headers() });
      }
      if (!res.ok) return undefined;
      const body = (await res.json()) as { app_path?: string };
      if (!body.app_path) return undefined;
      const web = (this.opts.webUrl ?? "https://smith.langchain.com").replace(/\/$/, "");
      return `${web}${body.app_path.startsWith("/") ? "" : "/"}${body.app_path}`;
    } catch {
      return undefined; // the link is supplementary — a failure doesn't affect the case result
    }
  }
}
