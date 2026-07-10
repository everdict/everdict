import {
  type TraceSink,
  type TraceSinkCase,
  type TraceSinkCaseResult,
  type TraceSinkContext,
  type TraceSinkResult,
  UpstreamError,
} from "@everdict/contracts";

// Langfuse sink — all cases via batch ingestion (POST /api/public/ingestion), scores as score-create events.
// Real-API notes: auth is Basic base64(pk:sk) verbatim, the event envelope id is the dedup key and body.id the entity upsert key,
// usageDetails (+costDetails) is current instead of usage, and the response is 207 (mixed success/failure — isolate cases via errors[]).
// The batch cap is 3.5MB (fixed by the server) — split into chunks by serialized size and send in several requests (event order preserved).
export interface LangfuseTraceSinkOptions {
  endpoint: string;
  auth?: string; // the Authorization header 'value' verbatim ("Basic <base64(pk:sk)>")
  project?: string; // projectId — for deep links (falls back to the /trace/{id} redirect if absent)
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
  // for reverse-mapping the envelope event → case (harmless to leave in even if not stripped before sending, but it's not put in the send body)
}

// cases → ingestion event array (pure — unit-testable). Returns: events + eventId→caseId reverse map + per-case traceId.
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
    const baseMs = Date.parse(now) - maxT; // relative t(ms) → absolute time (aligned as if it just finished)
    if (!c.externalId) {
      // create mode — trace + observations (generation/span). attach mode is scores-only on the existing trace.
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

// Chunk-split at 3MB, more conservative than the batch cap (3.5MB) (pure). If a single event exceeds the cap, send it as its own chunk
// (the server rejects only that event via errors[] → absorbed by case isolation, no silent drop).
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
    // the canonical route if projectId is known, otherwise a server-side redirect (/trace/{id}).
    return this.opts.project
      ? `${web}/project/${encodeURIComponent(this.opts.project)}/traces/${encodeURIComponent(traceId)}`
      : `${web}/trace/${encodeURIComponent(traceId)}`;
  }

  async export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const { events, eventCase, traceIdByCase } = langfuseBatch(ctx, cases, this.newId, this.nowIso);
    // Handle the 3.5MB batch cap — split into chunks and send sequentially, collecting 207 errors[] across all chunks.
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
      // 207: reverse-map the envelope event id in errors[] → case (partial-failure isolation).
      let body: { errors?: Array<{ id?: string; message?: string; error?: unknown }> } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // an empty/non-JSON response is treated as all-success (it was a 2xx)
      }
      for (const e of body.errors ?? []) {
        const caseId = e.id ? eventCase.get(e.id) : undefined;
        if (caseId && !failedCase.has(caseId)) failedCase.set(caseId, e.message ?? "ingestion event failed");
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
