import { type TraceEvent, UpstreamError } from "@everdict/contracts";
import type { TraceSource } from "./trace-source.js";

// Langfuse observations — TraceWithFullDetails.observations[] in the GET /api/public/traces/{traceId} response.
// Real-API notes: observations are fully inline (no pagination), fields are present-but-null (not optional),
// usage is deprecated and usageDetails/costDetails are current, and type carries newer enums (AGENT/TOOL/
// CHAIN/RETRIEVER) beyond GENERATION/SPAN/EVENT (don't hardcode only the three).
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

// Observation array → TraceEvent[] (pure). model present → llm_call, a TOOL observation → a tool_call/result pair, other structural observations are skipped.
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
    // Structural observations other than GENERATION (SPAN/CHAIN/AGENT etc., no model) are skipped — they don't contribute to metric derivation.
  }
  return out;
}

export interface LangfuseTraceSourceOptions {
  endpoint: string;
  auth?: string; // the Authorization header 'value' verbatim ("Basic <base64(pk:sk)>"). Injected from the SecretStore.
  fetchImpl?: typeof fetch; // test injection
}

// Fetch the trace detail from Langfuse by runId (=traceId) and normalize to TraceEvents (observations fully inline — no cursor).
export class LangfuseTraceSource implements TraceSource {
  constructor(private readonly opts: LangfuseTraceSourceOptions) {}
  async fetch(runId: string): Promise<TraceEvent[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.endpoint.replace(/\/$/, "");
    const res = await f(`${base}/api/public/traces/${encodeURIComponent(runId)}`, {
      ...(this.opts.auth ? { headers: { authorization: this.opts.auth } } : {}),
    });
    if (res.status === 404) return []; // if the trace isn't present yet, degrade to 0 events (the shared source rule)
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        `Langfuse trace fetch ${res.status}: ${text.slice(0, 200)}`,
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
