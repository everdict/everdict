// @everdict/sdk public types. Zero-dependency: the SDK mirrors only the response fields it reads; the control plane
// stays the validation authority. docs/architecture/one-call-sdk.md

// Injectable HTTP transport — a minimal fetch shape (no DOM lib dependency), so the client is unit-testable with a fake.
export interface SdkResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type SdkFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<SdkResponse>;

// A reference to a registered entity ("id@version"; version defaults to "latest").
export type Ref = string;

// Inline specs (loose — the control plane validates). Any registrable Dataset / HarnessSpec JSON.
export type DatasetInput = { id: string; version: string; [k: string]: unknown };
export type HarnessInput = { id: string; version: string; [k: string]: unknown };

export interface EvaluateInput {
  harness: Ref | HarnessInput; // "claude-code@1.0.0" or an inline HarnessSpec (registered first)
  dataset: Ref | DatasetInput; // "swe-lite@1.0.0" or an inline Dataset (registered first)
  trials?: number; // run each case N times (pass@k / flakiness)
  judges?: Array<{ id: string; version?: string }>;
  runtime?: string; // placement.target (registered runtime id | self:*). Omit = control-plane default.
  poll?: { intervalMs?: number; timeoutMs?: number };
}

// Per-metric aggregate the control plane returns (subset of the fields).
export interface MetricSummary {
  metric: string;
  count: number;
  mean: number;
  passRate?: number;
}

// Trial roll-up (present only for a multi-trial batch).
export interface TrialSummary {
  cases: number;
  minTrials: number;
  maxTrials: number;
  passAt1: number;
  k: number;
  passAtK: number;
  flakyCases: number;
  flakeRate: number;
}

// The scorecard record from GET /scorecards/:id (fields the SDK reads; everything else passes through).
export interface ScorecardRecord {
  id: string;
  status: string; // queued | running | succeeded | failed | superseded
  summary?: MetricSummary[];
  trialSummary?: TrialSummary;
  error?: { code: string; message: string };
  [k: string]: unknown;
}

// The reduced verdict evaluate() returns.
export interface Verdict {
  scorecardId: string;
  status: string;
  passRate: number | null; // trial-aware: trialSummary.passAt1 when present, else the authoritative metric pass rate
  passAt1?: number;
  passAtK?: number;
  flakeRate?: number;
  summary: MetricSummary[];
  record: ScorecardRecord;
}
