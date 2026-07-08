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
  onProgress?: (record: ScorecardRecord) => void; // called on each poll with the latest record (status + steps)
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

// Query for the leaderboard helper (GET /scorecards/leaderboard).
export interface LeaderboardQuery {
  dataset: string;
  metric?: string; // default "judge" server-side
  harness?: string;
  model?: string;
  judgeModel?: string;
  window?: "latest" | "best";
}

export interface LeaderboardRow {
  rank: number;
  harness: { id: string; version: string };
  model?: string;
  scorecardId: string;
  score: number | null;
  passRate: number | null;
  mean: number | null;
  runs: number;
  [k: string]: unknown;
}
export interface Leaderboard {
  dataset: string;
  metric: string;
  window: "latest" | "best";
  rows: LeaderboardRow[];
}

// A trial-aware per-case delta (present on the diff's statistical `trials` gate).
export interface TrialCaseDelta {
  caseId: string;
  baselineRate: number;
  candidateRate: number;
  delta: number;
  z: number;
  significant: boolean;
  [k: string]: unknown;
}
// baseline vs candidate diff. `trials` is present only when either side ran trials (the statistical gate).
export interface ScorecardDiff {
  baseline: string;
  candidate: string;
  metrics: Array<{ metric: string; baselineMean: number; candidateMean: number; delta: number }>;
  regressions: Array<{ caseId: string; metric: string; delta: number; [k: string]: unknown }>;
  improvements: Array<{ caseId: string; metric: string; delta: number; [k: string]: unknown }>;
  trials?: {
    zThreshold: number;
    cases: TrialCaseDelta[];
    regressions: TrialCaseDelta[];
    improvements: TrialCaseDelta[];
  };
}
