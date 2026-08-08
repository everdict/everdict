import {
  type CaseFailure,
  type CaseResult,
  type MetricSummary,
  type Score,
  type Scorecard,
  type ScorecardExport,
  type VerdictPolicy,
  measuredScores,
} from "@everdict/contracts";
import { type ScorecardOutcomes, caseVerdict, scorecardOutcomes } from "@everdict/domain";
import { offloadSnapshot } from "../ports/artifact-store.js";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";

// The scorecard use-cases' OBSERVABILITY seam (review §22): progress copy, the orchestration event
// vocabulary the composition maps to Prometheus, and the offloaded analysis/result artifacts. What a batch
// LOOKS like from outside — never how it runs.

// One-line trace-sink export result — for progress-step messages (success/partial/failure + reason).
export function exportStepMessage(e: ScorecardExport): string {
  if (e.status === "succeeded") return `Trace sink (${e.sink}) export complete — ${e.cases?.length ?? 0} case(s)`;
  const label = e.status === "partial" ? "partial export" : "export failed";
  return `Trace sink (${e.sink}) ${label}${e.message ? ` — ${e.message}` : ""}`;
}

// Orchestration observability events — the generic seam keeping the services metrics-vocabulary-free;
// the composition root (main.ts) maps these to the operator Prometheus registry.
export type OrchestrationEvent =
  | { kind: "spillover"; from: string; to: string; code: string }
  | { kind: "speculation_fired"; from: string; to: string }
  | { kind: "speculation_settled"; winnerSpeculated: boolean }
  | { kind: "oom_escalated"; memoryMb: number }
  | { kind: "concurrency_adapted"; effective: number; previous: number; base: number }
  // Batch settle (both drivers — in-process track AND Temporal finalize): the contract's closed vocabulary
  // promoted to time series. Tallies are the DOMAIN's (caseOutcome/scorecardOutcomes) — the seam never
  // re-derives outcome semantics.
  | {
      kind: "batch_settled";
      tenant: string;
      outcomes: ScorecardOutcomes;
      unmeasuredReasons: Record<string, number>; // closed reason vocabulary → count (never graderId — unbounded)
      latencySec: number; // submit → terminal (time-to-verdict, catalog S1)
    };

// Derive the batch_settled observation from the final scorecard — shared by both settle drivers so the
// two paths cannot drift (the rescore-predicate lesson).
export function batchSettledEvent(
  tenant: string,
  createdAt: string,
  scorecard: Pick<Scorecard, "results">,
  requested: number | undefined,
  nowMs: number,
  policy?: VerdictPolicy, // the batch's own (composed) policy — the outcome split is a verdict derivation
): Extract<OrchestrationEvent, { kind: "batch_settled" }> {
  const unmeasuredReasons: Record<string, number> = {};
  for (const result of scorecard.results) {
    for (const s of result.scores) {
      if (s.status !== "unmeasured") continue;
      // Raw rows on purpose (guard allowlist): this is the unmeasured TALLY — the one consumer whose subject
      // is the failures themselves. `reason` is required on the variant, so the count can never be "unspecified".
      unmeasuredReasons[s.reason] = (unmeasuredReasons[s.reason] ?? 0) + 1;
    }
  }
  return {
    kind: "batch_settled",
    tenant,
    outcomes: scorecardOutcomes(scorecard, requested, policy),
    unmeasuredReasons,
    latencySec: Math.max(0, (nowMs - new Date(createdAt).getTime()) / 1000),
  };
}

// Offload os-use screenshots (inline base64) to object storage → each result snapshot.screenshotRef=URL, screenshot cleared (slim
// record). best-effort: on failure keep the base64 (no effect on the scorecard itself). Called after applyJudges (once registry judges have used the image).
export async function offloadResults(
  deps: Pick<ScorecardServiceDeps, "artifacts">,
  id: string,
  results: CaseResult[],
): Promise<void> {
  if (!deps.artifacts) return;
  for (const r of results) {
    try {
      r.snapshot = await offloadSnapshot(r.snapshot, deps.artifacts, `scorecards/${id}/${r.caseId}`);
    } catch {}
  }
}

// The self-contained ANALYSIS artifact — the analysis result as a first-class, portable object (the analysis-output
// sibling of the run-output snapshot artifacts). Pure: dataset/harness + the aggregate summary + per-case verdict/scores.
export interface AnalysisBundle {
  scorecardId: string;
  dataset: string;
  harness: string;
  summary: MetricSummary[];
  cases: Array<{ caseId: string; verdict: boolean | undefined; scores: Score[]; failure?: CaseFailure }>;
  // M5 — the infra lens: the batch's classified-failure aggregation ("was this the agent or the platform").
  // Derived from the SAME per-case failures below, so a consumer can render the trend without re-walking cases.
  infra: {
    failedCases: number; // cases carrying a classified failure (agent FAILs carry none by design)
    byClass: Record<string, number>; // infra | config | harness | agent
    byCode: Record<string, number>; // OOM_KILLED | UPSTREAM_ERROR | …
    oom: number; // OOM_KILLED count (the "raise resources" signal)
    placementBlocked: number; // placement_blocked-coded failures (the "cluster capacity" signal)
  };
}

// `policy` is the batch's own verdict policy (the composed document sealed in its manifest, absent = the
// built-in ladder). The bundle freezes per-case verdicts into a downloadable artifact, so judging them under
// anything but the batch's own policy would ship a rewritten history as a file.
export function analysisBundle(
  meta: { scorecardId: string; dataset: string; harness: string },
  summary: MetricSummary[],
  results: CaseResult[],
  policy?: VerdictPolicy,
): AnalysisBundle {
  const byClass: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  let failedCases = 0;
  let oom = 0;
  let placementBlocked = 0;
  for (const r of results) {
    if (!r.failure) continue;
    failedCases++;
    byClass[r.failure.class] = (byClass[r.failure.class] ?? 0) + 1;
    byCode[r.failure.code] = (byCode[r.failure.code] ?? 0) + 1;
    if (r.failure.code === "OOM_KILLED") oom++;
    if (r.failure.message.includes("placement blocked")) placementBlocked++;
  }
  return {
    scorecardId: meta.scorecardId,
    dataset: meta.dataset,
    harness: meta.harness,
    summary,
    cases: results.map((r) => ({
      caseId: r.caseId,
      verdict: caseVerdict(r, policy),
      scores: r.scores,
      ...(r.failure ? { failure: r.failure } : {}),
    })),
    infra: { failedCases, byClass, byCode, oom, placementBlocked },
  };
}

// Where a scorecard's analysis artifact lives in the store. The KEY is the durable handle (the returned ref is a
// presigned URL that expires), so the read side derives it from the scorecard id through this same constant.
export const ANALYSIS_KEY_PREFIX = "analyses/";
export const analysisArtifactKey = (id: string): string => `${ANALYSIS_KEY_PREFIX}${id}.json`;

// Offload the analysis bundle to object storage → a downloadable ref (ScorecardRecord.analysisRef). Best-effort: no
// store or a failure returns undefined and never affects the scorecard (same discipline as offloadResults).
export async function offloadAnalysis(
  deps: Pick<ScorecardServiceDeps, "artifacts">,
  id: string,
  bundle: AnalysisBundle,
): Promise<string | undefined> {
  if (!deps.artifacts) return undefined;
  try {
    return await deps.artifacts.put(analysisArtifactKey(id), Buffer.from(JSON.stringify(bundle)), "application/json");
  } catch {
    return undefined;
  }
}
