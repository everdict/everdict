import type {
  DatasetInput,
  EvaluateInput,
  HarnessInput,
  Leaderboard,
  LeaderboardQuery,
  Ref,
  ScorecardDiff,
  ScorecardRecord,
  SdkFetch,
  Verdict,
} from "./types.js";

// A control-plane error (a {code,message} body from the API), carrying the HTTP status.
export class EverdictError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EverdictError";
  }
}

export interface EverdictClientOptions {
  baseUrl: string; // control-plane URL
  apiKey: string; // ak_…
  workspace?: string; // x-everdict-workspace (else the key's default)
  fetch?: SdkFetch; // injectable (default: global fetch)
  sleep?: (ms: number) => Promise<void>; // injectable (default: real timer)
}

// Authoritative-first metric order for a single headline pass rate (mirrors the server's caseVerdict ranking).
const PASS_RATE_METRICS = ["tests_pass", "state", "answer_match", "url_matches", "dom_contains", "judge"];

function parseRef(ref: Ref): { id: string; version: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { id: ref, version: "latest" };
  return { id: ref.slice(0, at), version: ref.slice(at + 1) || "latest" };
}

// Reduce a scorecard record to a single headline pass rate. Trial-aware: prefer the case-weighted trial pass rate;
// else the highest-authority metric that carries a pass rate; else any; else null (nothing pass-deciding).
function headlinePassRate(record: ScorecardRecord): number | null {
  if (record.trialSummary) return record.trialSummary.passAt1;
  const summary = record.summary ?? [];
  for (const metric of PASS_RATE_METRICS) {
    const s = summary.find((x) => x.metric === metric && x.passRate !== undefined);
    if (s?.passRate !== undefined) return s.passRate;
  }
  return summary.find((x) => x.passRate !== undefined)?.passRate ?? null;
}

// A thin, zero-dependency client for the Everdict control plane. Its evaluate() composes the existing endpoints
// (register → submit → poll) into one call → a Verdict. docs/architecture/one-call-sdk.md
export class EverdictClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly workspace?: string;
  private readonly fetchImpl: SdkFetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: EverdictClientOptions) {
    if (!opts.baseUrl) throw new Error("EverdictClient requires a baseUrl.");
    if (!opts.apiKey) throw new Error("EverdictClient requires an apiKey.");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    if (opts.workspace) this.workspace = opts.workspace;
    const globalFetch = (globalThis as { fetch?: SdkFetch }).fetch;
    const resolved = opts.fetch ?? globalFetch;
    if (!resolved) throw new Error("No fetch available — pass opts.fetch (Node <18 / a non-fetch runtime).");
    this.fetchImpl = resolved;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (this.workspace) headers["x-everdict-workspace"] = this.workspace;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => undefined);
    if (!res.ok) {
      const envelope = (data ?? {}) as { code?: string; message?: string };
      throw new EverdictError(res.status, envelope.code ?? "ERROR", envelope.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  registerDataset(dataset: DatasetInput): Promise<{ id: string; version: string }> {
    return this.request("POST", "/datasets", dataset);
  }
  registerHarness(harness: HarnessInput): Promise<{ id: string; version: string }> {
    return this.request("POST", "/harnesses", harness);
  }
  submitScorecard(input: {
    dataset: { id: string; version: string };
    harness: { id: string; version: string };
    trials?: number;
    judges?: Array<{ id: string; version?: string }>;
    runtime?: string;
  }): Promise<{ id: string }> {
    return this.request("POST", "/scorecards", input);
  }
  getScorecard(id: string): Promise<ScorecardRecord> {
    return this.request("GET", `/scorecards/${encodeURIComponent(id)}`);
  }

  // Compare two completed scorecards. When either ran trials, the result carries a statistically-gated `trials` diff
  // (two-proportion z gate); `z` tunes the confidence threshold (default 1.96 ≈ 95%).
  diff(baseline: string, candidate: string, opts?: { z?: number }): Promise<ScorecardDiff> {
    const query = [`baseline=${encodeURIComponent(baseline)}`, `candidate=${encodeURIComponent(candidate)}`];
    if (opts?.z !== undefined) query.push(`z=${encodeURIComponent(String(opts.z))}`);
    return this.request("GET", `/scorecards/diff?${query.join("&")}`);
  }

  // Rank (harness × model) on one dataset by a metric (default judge). window: latest | best.
  leaderboard(query: LeaderboardQuery): Promise<Leaderboard> {
    const params = [`dataset=${encodeURIComponent(query.dataset)}`];
    if (query.metric) params.push(`metric=${encodeURIComponent(query.metric)}`);
    if (query.harness) params.push(`harness=${encodeURIComponent(query.harness)}`);
    if (query.model) params.push(`model=${encodeURIComponent(query.model)}`);
    if (query.judgeModel) params.push(`judgeModel=${encodeURIComponent(query.judgeModel)}`);
    if (query.window) params.push(`window=${encodeURIComponent(query.window)}`);
    return this.request("GET", `/scorecards/leaderboard?${params.join("&")}`);
  }

  // One call: reproduce env + N trials + score → verdict. Registers inline specs, submits, polls to terminal, reduces.
  async evaluate(input: EvaluateInput): Promise<Verdict> {
    const dataset =
      typeof input.dataset === "string" ? parseRef(input.dataset) : await this.registerDataset(input.dataset);
    const harness =
      typeof input.harness === "string" ? parseRef(input.harness) : await this.registerHarness(input.harness);
    const submitted = await this.submitScorecard({
      dataset,
      harness,
      ...(input.trials !== undefined ? { trials: input.trials } : {}),
      ...(input.judges ? { judges: input.judges } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
    });
    const record = await this.poll(submitted.id, {
      ...(input.poll ?? {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
    return {
      scorecardId: record.id,
      status: record.status,
      passRate: headlinePassRate(record),
      ...(record.trialSummary
        ? {
            passAt1: record.trialSummary.passAt1,
            passAtK: record.trialSummary.passAtK,
            flakeRate: record.trialSummary.flakeRate,
          }
        : {}),
      summary: record.summary ?? [],
      record,
    };
  }

  // Poll GET /scorecards/:id until terminal (succeeded|failed|superseded). Injectable interval/timeout; a timeout throws.
  // onProgress fires on every poll with the latest record (status + steps) — for live progress.
  async poll(
    id: string,
    opts?: { intervalMs?: number; timeoutMs?: number; onProgress?: (record: ScorecardRecord) => void },
  ): Promise<ScorecardRecord> {
    const interval = opts?.intervalMs ?? 2000;
    const timeout = opts?.timeoutMs ?? 30 * 60 * 1000;
    const terminal = new Set(["succeeded", "failed", "superseded"]);
    let waited = 0;
    for (;;) {
      const record = await this.getScorecard(id);
      opts?.onProgress?.(record);
      if (terminal.has(record.status)) return record;
      if (waited >= timeout)
        throw new EverdictError(
          408,
          "TIMEOUT",
          `scorecard ${id} did not finish within ${timeout}ms (last status: ${record.status}).`,
        );
      await this.sleep(interval);
      waited += interval;
    }
  }
}
