import { z } from "zod";
import type { ComputeHandle, ComputeSpec } from "./compute.js";
import type { EnvSnapshot } from "./environment.js";
import type { EvalCase, Scorecard } from "./eval-case.js";
import type { TraceEvidence } from "./trace-source.js";
import type { TraceEvent } from "./trace.js";

// Why a score was NOT a measurement. Closed vocabulary — a new skip path picks an existing reason or adds one here.
export const UNMEASURED_REASONS = [
  "grader_error", // the grader threw at scoring time (transport hiccup, judge LLM failure, grading job death)
  "missing_evidence", // the evidence the grader needs (trace/snapshot slot) was not captured
  "missing_secret", // a required credential was absent or undecryptable (re-scorable once configured)
  "unsupported", // this deployment/path cannot run the grader (no dispatcher, unresolvable rubric)
  "policy_skip", // deliberately skipped by configuration/policy — not an error
  "contract_violation", // the grader RETURNED a score that violates the contract (NaN value, empty ids) — a grader bug, never retried
] as const;
export type UnmeasuredReason = (typeof UNMEASURED_REASONS)[number];

// ── The measurement algebra ──────────────────────────────────────────────────────────────────────────
// A Score is a DISCRIMINATED UNION on `status`, not one flat object with three optional fields. The flat
// shape let illegal states parse — `{status:"measured", reason:"grader_error", retryable:true}` was a valid
// wire row — and, worse, it forced every non-measurement to invent a placeholder `value: 0` that only the
// isMeasured gate stood between and a mean. Here a non-measurement carries NO `value` at all: a dead grader
// has no number to leak, and a consumer that reads `.value` without narrowing fails to COMPILE.

const ScoreIdentitySchema = {
  graderId: z.string(),
  metric: z.string(),
  detail: z.unknown().optional(),
};

// A real measurement of the agent. `status` is OPTIONAL here (absent ⇒ measured) because that is what a
// grader literally writes — `{graderId, metric, value, pass}` — and what every row persisted before the
// field exists says. Read-time normalization stamps it explicitly, so anything that came off a wire or a
// jsonb column carries "measured"; only in-process producer literals leave it off.
export const MeasuredScoreSchema = z
  .object({
    ...ScoreIdentitySchema,
    value: z.number(),
    pass: z.boolean().optional(),
    // Categorical outcome (tier/string) — a human-facing value like "gold" | "correct" | "B". Its presence marks the
    // metric CATEGORICAL: the batch summary aggregates a label DISTRIBUTION + mode instead of a (meaningless) mean, and
    // the UI shows the label, not `value`. `value` stays required as the numeric ordering key (bronze<silver<gold ⇒
    // 1<2<3; 0 when unordered) so trend/diff/leaderboard still have a number. Absent ⇒ a plain numeric/boolean metric.
    label: z.string().optional(),
    status: z.literal("measured").optional(),
  })
  .strict();
export type MeasuredScore = z.infer<typeof MeasuredScoreSchema>;

// A grader failure or skip — NOT a measurement of the agent, so it has no value, no pass and no label.
// `reason` and `retryable` are REQUIRED: an unmeasured row that cannot say why it is unmeasured, or whether
// re-scoring can recover it, is a hole in the evidence rather than a record of one.
export const UnmeasuredScoreSchema = z
  .object({
    ...ScoreIdentitySchema,
    status: z.literal("unmeasured"),
    reason: z.enum(UNMEASURED_REASONS),
    retryable: z.boolean(), // true ⇒ re-scoring this grader can recover the measurement
  })
  .strict();
export type UnmeasuredScore = z.infer<typeof UnmeasuredScoreSchema>;

// A contract-violating grader OUTPUT (NaN value, empty ids) — a grader BUG to fix, never something to
// average or retry. Its reason is fixed by construction, so the variant pins the literal.
export const InvalidScoreSchema = z
  .object({
    ...ScoreIdentitySchema,
    status: z.literal("invalid"),
    reason: z.literal("contract_violation"),
  })
  .strict();
export type InvalidScore = z.infer<typeof InvalidScoreSchema>;

// The algebra itself — strict, so an illegal combination is REFUSED rather than silently stripped. Parse
// raw input through `ScoreSchema` below (which normalizes first); reach for this one to assert the shape.
export const ScoreUnionSchema = z.discriminatedUnion("status", [
  MeasuredScoreSchema,
  UnmeasuredScoreSchema,
  InvalidScoreSchema,
]);

export type Score = MeasuredScore | UnmeasuredScore | InvalidScore;

// Legacy sentinels: before `status` existed, the two skip producers marked themselves in `detail` prose —
// safeGrade with "[grader-error] …" and the judge runner with "skipped: …". Persisted rows keep that shape
// forever, so measured-ness is decided at READ (normalizeScoreShape below), never by re-migrating stored
// results. Both legacy producers ALSO left `pass` undefined — requiring that too keeps a real measurement
// whose prose detail merely opens with the same words from being misclassified as unmeasured.
// THE ONLY occurrence of this pattern in the codebase: all legacy tolerance lives in the normalizer.
const LEGACY_UNMEASURED_DETAIL_RE = /^(\[grader-error\]|skipped: )/;

const UNMEASURED_REASON_SET = new Set<string>(UNMEASURED_REASONS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Read-time normalization — the ONE place that knows every shape a Score has ever had on a wire or in a
// jsonb column, mapping all of them onto the modern union. It is wired INTO `ScoreSchema` as a preprocess
// step, so every deserialization boundary (the job-result sentinel, the Pg record schemas, MCP inputs, the
// script grader's stdout, ingest) normalizes by construction instead of by remembering to call it.
//
// Truth table (input ⇒ output):
//   status "invalid"                             ⇒ invalid (placeholder value/retryable dropped)
//   status "unmeasured"                          ⇒ unmeasured, value dropped; an unrecognizable reason or a
//                                                  missing retryable falls back to unsupported/false (the
//                                                  fail-closed reading: never claim a retryability we can't honor)
//   no status + no pass + detail "[grader-error]…" ⇒ unmeasured{grader_error, retryable:true}   (safeGrade's twin)
//   no status + no pass + detail "skipped: …"      ⇒ unmeasured{unsupported, retryable:false}   (skip's twin)
//   non-finite value, or an empty metric/graderId  ⇒ invalid{contract_violation}                (sanitizeScore's twin)
//   anything else                                  ⇒ measured, status stamped explicitly
// A non-object input is passed through untouched so the union — not this function — reports the type error.
function normalizeScoreShape(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const { graderId, metric, value, pass, label, detail, status, reason, retryable } = raw;
  const identity = { graderId, metric, ...(detail !== undefined ? { detail } : {}) };
  const invalid = () => ({ ...identity, status: "invalid", reason: "contract_violation" });

  if (status === "invalid") return invalid();
  if (status === "unmeasured") {
    return {
      ...identity,
      status: "unmeasured",
      reason: typeof reason === "string" && UNMEASURED_REASON_SET.has(reason) ? reason : "unsupported",
      retryable: typeof retryable === "boolean" ? retryable : false,
    };
  }
  if (status === undefined && pass === undefined && typeof detail === "string") {
    const sentinel = LEGACY_UNMEASURED_DETAIL_RE.exec(detail)?.[1];
    if (sentinel === "[grader-error]")
      return { ...identity, status: "unmeasured", reason: "grader_error", retryable: true };
    if (sentinel !== undefined) return { ...identity, status: "unmeasured", reason: "unsupported", retryable: false };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || metric === "" || graderId === "") return invalid();
  return {
    ...identity,
    value,
    ...(pass !== undefined ? { pass } : {}),
    ...(label !== undefined ? { label } : {}),
    status: "measured",
  };
}

// THE boundary schema — every nested schema (CaseResult, the record schemas, the wire views) embeds this
// one, so legacy tolerance is applied everywhere and loosening the union was never necessary.
export const ScoreSchema = z.preprocess(normalizeScoreShape, ScoreUnionSchema);

// The reader-side normalizer, for a caller holding raw score JSON outside a schema (throws on garbage).
export function normalizeScore(raw: unknown): Score {
  return ScoreSchema.parse(raw);
}

// THE measured gate — every aggregate (mean/passRate/distribution/diff/trend/leaderboard/verdict) filters
// through this, so "grader died" and "scored 0" can never share a number space. It is a real type predicate:
// `value`/`pass`/`label` exist ONLY on the narrowed side, so a new aggregation cannot reach a number without
// passing the gate first (packages/domain + application-control pin the structural half with .scores guards).
export function isMeasured(score: Score): score is MeasuredScore {
  return score.status === undefined || score.status === "measured";
}
export function measuredScores(scores: Score[]): MeasuredScore[] {
  return scores.filter(isMeasured);
}

// Contract validation at the PRODUCER boundary — the twin of the normalizer's invalid branch, applied where a
// grader's return value is collected (safeGrade, the judge runner) so a grader that RETURNS garbage (a
// NaN/Infinity value, an empty metric or grader id) becomes a visible invalid row at the moment it is
// produced, rather than at whatever read happens to come first.
export function sanitizeScore(score: Score): Score {
  const idsBroken = score.metric === "" || score.graderId === "";
  const valueBroken = isMeasured(score) && !Number.isFinite(score.value);
  if (!idsBroken && !valueBroken) return score;
  const shownValue = isMeasured(score) ? String(score.value) : "none";
  return {
    graderId: score.graderId === "" ? "unknown" : score.graderId,
    metric: score.metric === "" ? score.graderId || "unknown" : score.metric,
    status: "invalid",
    reason: "contract_violation",
    detail: `[invalid-score] value=${shownValue} metric=${JSON.stringify(score.metric)} graderId=${JSON.stringify(score.graderId)}`,
  };
}

// A read against a purpose:"data" store's per-case slice — the store-state grader's window into the post-run world.
// The topology runtime resolves (store, role?) → the case's isolation slice and runs `query` there. Co-located by
// necessity: an internal store URL never reaches a remote grader (docs/architecture/judge-placement-locality.md).
export interface StoreReadQuery {
  store: string;
  role?: string; // disambiguate when several dependencies share a store kind
  query: string; // the read (a SQL SELECT for postgres)
}
export type StoreReader = (q: StoreReadQuery) => Promise<string>;

export interface GradeContext {
  case: EvalCase;
  trace: TraceEvent[];
  snapshot: EnvSnapshot;
  // Evidence extracted from a pulled trace via the mapping's evidence slots — carries the CUSTOM named slots a
  // judge's promptTemplate references ({<name>}); the fixed slots already ride the snapshot/trace. Optional:
  // live-run paths without a mapping leave it unset.
  evidence?: TraceEvidence;
  // Outcome graders can run commands in the environment (process harness). Optional because service/browser harnesses have no compute.
  compute?: ComputeHandle;
  // Provision a DEDICATED grading compute (script grader `image` mode) — injected by runCase from its driver.
  // Optional: scoring paths without a driver (control-plane collect, topology) leave it unset. The grader that
  // provisions OWNS the handle and MUST dispose it in a finally.
  provision?: (spec: ComputeSpec) => Promise<ComputeHandle>;
  // Read a purpose:"data" store's post-run slice (store-state grading, P2). Injected by the topology backend from a
  // runtime that can exec into its stores; other paths leave it unset (a store-state grader then fails, like a
  // missing-compute outcome grader). docs/architecture/dependency-store-roles.md
  readStore?: StoreReader;
  baseline?: Scorecard; // for regression comparison
}

// Scoring — fully separate from the harness. The same grader scores every harness identically →
// enabling fair comparison across harnesses/versions.
export interface Grader {
  readonly id: string;
  // A grader that runs commands in the environment (compute) at scoring time declares true (outcome-family: tests-pass/command etc.).
  // Undeclared = observation-only (trace/snapshot) → runCase scores it after releasing compute, minimizing sandbox occupancy to
  // the execution window (not held while waiting on the judge LLM). docs/architecture/streaming-case-pipeline.md
  readonly needsCompute?: boolean;
  // One Score for most graders; a multi-metric grader (multi-criteria judge, script) returns several from ONE
  // evaluation pass — each Score's `metric` label stays the aggregation axis. docs/architecture/eval-domain-model.md
  grade(ctx: GradeContext): Promise<Score | Score[]>;
}

// Normalize a grader result at the collection points (runCase / service backends / judge runner).
export function toScores(result: Score | Score[]): Score[] {
  return Array.isArray(result) ? result : [result];
}
