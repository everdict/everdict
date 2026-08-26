import { z } from "zod";
import type { ComputeHandle, ComputeSpec } from "./compute.js";
import type { EnvSnapshot } from "./environment.js";
import type { EnvDelta, EvalCase, Scorecard } from "./eval-case.js";
import type { TraceEvidence } from "./trace-source.js";
import { type TraceEvent, TraceEventSchema } from "./trace.js";
import { type ScoreProducer, forgedMetricReason } from "./verdict-policy.js";

// Why a score was NOT a measurement. Closed vocabulary — a new skip path picks an existing reason or adds one here.
export const UNMEASURED_REASONS = [
  "grader_error", // the grader threw at scoring time (transport hiccup, judge LLM failure, grading job death)
  "missing_evidence", // the evidence the grader needs (trace/snapshot slot) was not captured
  "missing_secret", // a required credential was absent or undecryptable (re-scorable once configured)
  "unsupported", // this deployment/path cannot run the grader (no dispatcher, unresolvable rubric)
  "policy_skip", // deliberately skipped by configuration/policy — not an error
  "contract_violation", // the grader RETURNED a score that violates the contract (NaN value, empty ids) — a grader bug, never retried
  "grader_timeout", // the grader never returned within the case's own declared budget — a hang, not a throw
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
  // ── THE JUDGE'S OWN EXECUTION, AS A TRANSPORT SLOT (downstream report 1.1) ─────────────────────────
  //
  // A dispatched judge's only return channel is its scores, so the judgment's own observation — the model
  // call it made, the tokens it spent, the verdict text — had nowhere to exist: an `unmeasured` row said the
  // judge failed and the failed CALL was recorded nowhere. This slot carries those events back. It is a
  // TRANSPORT: the scoring service drains it onto the judged case's trace and persists the score WITHOUT it,
  // so a stored score stays a judgment, never an envelope. On every variant — the failure variants above
  // all — because a failed judge still called, and that call is what makes the failure diagnosable.
  //
  // The events must be `span` kind, NEVER `llm_call`: the cost/steps graders read `llm_call`, so a judge's
  // tokens recorded as one would bill the judged agent for the judgment — the measurement plane polluted by
  // the judging plane's bookkeeping. `judgeExecutionSpans` (@everdict/domain) is the one spelling.
  traceEvents: z.array(TraceEventSchema).optional(),
};

// ── THE REASON, AS A READER GETS IT ──────────────────────────────────────────────────────────────────
//
// `detail` is `unknown` on purpose: a threshold grader writes a sentence, a model judge writes an object
// (`{reasoning, evidence, failure_analysis}`), a code judge writes whatever its script returned. Every
// consumer that wants one line therefore has to decide what an object looks like — and the one that did it
// inline decided by narrowing to `string`, so every judge verdict left the building with no stated reason at
// all. The export was a score with no explanation, and nothing said it had dropped one.
//
// One total rendering, next to the contract that made the field open, so a sink/report/UI never invents its
// own. No I/O, no store, total over every input — the admission test for living here.
export function renderScoreDetail(detail: unknown, maxLength = 4_000): string {
  const text = detailText(detail);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function detailText(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  if (Array.isArray(detail))
    return detail
      .map((entry) => detailText(entry))
      .filter(Boolean)
      .join("\n");
  if (typeof detail === "object") {
    // The readable fields a judge actually writes, in the order a reader wants them — the verdict's own
    // words first, then what it based them on. Anything else falls through to JSON rather than vanishing.
    const record = detail as Record<string, unknown>;
    const named = ["reasoning", "reason", "explanation", "summary", "failure_analysis", "evidence", "comment"]
      .filter((key) => record[key] !== undefined && record[key] !== "")
      .map((key) => `${key}: ${detailText(record[key])}`);
    if (named.length > 0) return named.join("\n");
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail); // circular or otherwise unserialisable — a shape is better than silence
    }
  }
  return String(detail);
}

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
    // ── WHAT THE PLATFORM SAW, BESIDE WHAT THE AGENT CLAIMED (arch-review 71 P1-evolution) ──────────
    //
    // A judge that is shown the platform's own observation account answers whether the trace's claims and
    // that account agree. It was born TYPED from the model and then folded into `detail` as prose —
    // `[observations: divergent — …]` — which is durable and unreadable: a gate may not re-derive a decision
    // from rendered text (L3), so the strongest thing a judge can say about a candidate could not reach the
    // decision that adopts it.
    //
    // Structured here because this is the row a scorecard stores and a campaign reads. `unclear` is its own
    // arm and not a soft `consistent`: "I could not tell" is the third value (L2), and a policy that wants
    // to bound it needs to see it.
    observationAssessment: z
      .object({
        status: z.enum(["consistent", "divergent", "unclear"]),
        note: z.string().max(2000).optional(),
      })
      .optional(),
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
    // How many times the CURRENT scoring pass has attempted this measurement (arch-review 11 P0). Pass-local
    // for free: a pass strips the selected judges' rows before it starts, so the counter a pass reads is one
    // it wrote itself. Without it a `retryable: true` failure that never recovers keeps the case on every
    // continuation's worklist — the same unbounded loop `retryable: false` had, just slower to notice.
    // Absent = never counted (rows written before this existed, and every non-judge producer).
    attempts: z.number().int().nonnegative().optional(),
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
  const { graderId, metric, value, pass, label, detail, status, reason, retryable, attempts, traceEvents } = raw;
  // `traceEvents` must SURVIVE normalization like `attempts` does: this function runs at every
  // deserialization boundary, and a field it forgets is a field every read silently drops — the exact class
  // that kept a schema-present field unreachable (downstream report 1.1's second trap).
  const identity = {
    graderId,
    metric,
    ...(detail !== undefined ? { detail } : {}),
    ...(Array.isArray(traceEvents) && traceEvents.length > 0 ? { traceEvents } : {}),
  };
  const invalid = () => ({ ...identity, status: "invalid", reason: "contract_violation" });

  if (status === "invalid") return invalid();
  if (status === "unmeasured") {
    return {
      ...identity,
      status: "unmeasured",
      reason: typeof reason === "string" && UNMEASURED_REASON_SET.has(reason) ? reason : "unsupported",
      retryable: typeof retryable === "boolean" ? retryable : false,
      // The attempt counter has to SURVIVE normalization. This function runs at every deserialization
      // boundary, so a field it forgets is a field that silently resets on the next read — and a retry
      // budget that resets is not a budget.
      ...(typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0 ? { attempts } : {}),
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
export function sanitizeScore(score: Score, producer?: ScoreProducer): Score {
  const idsBroken = score.metric === "" || score.graderId === "";
  const valueBroken = isMeasured(score) && !Number.isFinite(score.value);
  // …and the METRIC NAME is part of the contract (arch-review 17 P0-2). In this system a name is what assigns
  // authority, so a producer choosing its own name is a producer choosing its own authority: an undeclared
  // custom grader printing `{"metric":"state"}` was read as ground truth, and a code judge whose raw metric
  // did not start with `judge` kept that name through the rewrite and escalated itself the same way. The
  // right to NAME ground truth and the right to be BELIEVED as ground truth have to be one right.
  //
  // It becomes `invalid`, which is the vocabulary this file already uses for a producer contract violation:
  // visible on the plane, aggregated nowhere, unable to decide a case — and the metric is preserved verbatim
  // in the detail so the author sees exactly what they emitted and what to do instead. Silently renaming it
  // would be the other temptation, and it hides the violation from the person who can fix it.
  const forged = producer === undefined ? undefined : forgedMetricReason(score.metric, producer);
  if (!idsBroken && !valueBroken && forged === undefined) return score;
  const shownValue = isMeasured(score) ? String(score.value) : "none";
  return {
    // The violating producer's own execution evidence still travels — an invalid row that kept the call is
    // diagnosable; one that dropped it says only that something went wrong somewhere.
    ...(score.traceEvents !== undefined && score.traceEvents.length > 0 ? { traceEvents: score.traceEvents } : {}),
    graderId: score.graderId === "" ? "unknown" : score.graderId,
    metric: score.metric === "" ? score.graderId || "unknown" : score.metric,
    status: "invalid",
    reason: "contract_violation",
    detail:
      forged !== undefined
        ? `[invalid-score] ${forged}`
        : `[invalid-score] value=${shownValue} metric=${JSON.stringify(score.metric)} graderId=${JSON.stringify(score.graderId)}`,
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

// ── THE WORLD'S OWN ACCOUNT, DELIVERED TO THE JUDGMENT (evolution-lineage Track C) ──────────────────
//
// `EnvDelta[]` is an INDEPENDENT observation — sampled by the environment on its own clock, never reported
// by the agent — and until this channel existed its only terminal consumer was the replay recording, so no
// grader could weigh a claim against what the world actually did. Three-valued on purpose (L2):
//   sampled{[]}              the platform watched and nothing changed — a real, meaningful answer
//   unobserved{unsupported}  this environment cannot sample (browser/os-use/prompt today)
//   unobserved{sampling_failed} the environment supports sampling and EVERY attempt failed — fewer deltas
//                              must never read as a calmer world
//   unobserved{no_environment} this judging path has no live environment at all (control-plane re-score,
//                              the private verifier's container, a zero-cost preview)
export type CaseObservations =
  | { kind: "sampled"; deltas: EnvDelta[] }
  | { kind: "unobserved"; reason: "unsupported" | "sampling_failed" | "no_environment" };

export interface GradeContext {
  case: EvalCase;
  // WHEN THIS CASE'S GRADING MUST BE OVER (epoch ms) — ONE deadline for the whole scoring phase, not one per
  // grader (arch-review 25 P1). The first version gave every grader the case's full budget, so three graders
  // hanging in sequence spent three times the budget the case declared and the bound stopped being a bound.
  // Computed by whoever starts the case, because only it knows when the clock started.
  deadlineAt: number;
  // …and the way to STOP the work, not merely to stop waiting for it (arch-review 25 P1). A timeout revokes a
  // result's authority; it does not revoke the underlying call, so a judge that timed out kept its provider
  // request open and kept spending. `safeGrade` derives a per-grader signal from this and the deadline; a
  // grader that reaches an external system passes it down.
  signal?: AbortSignal;
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
  // REQUIRED, not optional: every construction site states what it knows about the observation channel,
  // because an optional identity is how a channel stays unread for three reviews (rule `protocol`).
  observations: CaseObservations;
  baseline?: Scorecard; // for regression comparison
}

// Scoring — fully separate from the harness. The same grader scores every harness identically →
// enabling fair comparison across harnesses/versions.
export interface Grader {
  readonly id: string;
  // Reserved metric names this grader owns BY CONSTRUCTION (arch-review 17 P0-2, narrowed by 18 P0-1) — a
  // property of the IMPLEMENTATION, whose metric is fixed in its own code. Declared on the class rather than
  // stamped at construction so it cannot be lost by a call site that builds the grader directly, and never
  // sourced from a spec: a spec is user data, and treating a declaration as the permit turned it into a
  // wildcard over every authority-bearing name.
  readonly ownsMetrics?: readonly string[];
  // May emit the inline judge's own shapes. See `forgedMetricReason` for the bound and its residual.
  readonly ownsJudgeVerdict?: boolean;
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
