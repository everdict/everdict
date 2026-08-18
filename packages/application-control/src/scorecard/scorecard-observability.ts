import {
  type CaseFailure,
  type CaseResult,
  type MetricSummary,
  type Score,
  type Scorecard,
  type ScorecardExport,
  type VerdictPolicy,
  caseKeyAddress,
  caseKeyOf,
  measuredScores,
} from "@everdict/contracts";
import { type ScorecardOutcomes, caseVerdict, scorecardOutcomes } from "@everdict/domain";
import { contentDigest } from "@everdict/domain";
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
      // ADDRESSED BY THE TRIAL THAT PRODUCED IT (arch-review 52, wave 1). A trialled case is k physical
      // executions of one case id, and this key carried only the id — so k screenshots landed on one object
      // and the last put silently replaced the evidence a judge had already looked at for the others. Object
      // stores have no compare-and-swap to notice. A case with no trial axis keeps its bare-caseId address,
      // so everything already stored stays readable at the ref its record points at.
      r.snapshot = await offloadSnapshot(
        r.snapshot,
        deps.artifacts,
        `scorecards/${id}/${caseKeyAddress(caseKeyOf(r.caseId, r.trial))}`,
      );
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
  // One row per RESULT, and a trialled batch has k results per case id — so the row carries the trial that
  // produced it (arch-review 52, wave 1). Without it a frozen bundle showed k rows sharing one identity and
  // no way to tell which verdict belonged to which execution, which is the one question a frozen artifact
  // exists to answer years later. Absent = no trial axis (single-run), byte-identical to every bundle
  // already in the store.
  cases: Array<{
    caseId: string;
    trial?: number;
    verdict: boolean | undefined;
    scores: Score[];
    failure?: CaseFailure;
  }>;
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
      ...(r.trial !== undefined ? { trial: r.trial } : {}),
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
// The per-PASS immutable artifact (arch-review 8 P0). Keyed by the pass, not by the revision it hopes to
// become: two passes can legitimately target the SAME revision number (a takeover starts from the same
// base), they both freeze a bundle BEFORE the ledger CAS decides which one settles, and the object store
// has no compare-and-swap — so a revision-keyed write let the LOSER's bytes end up under the winner's
// revision. The ledger would name revision 2 while the artifact under revision 2 described a pass that
// never happened. Keying by passId makes that collision impossible instead of unlikely: the winner's
// ledger entry points at its own key, and the loser's object is simply an orphan nobody references
// (kept, not deleted — an abandoned pass's bundle is evidence of what it was doing, not garbage).
// Legacy revision-keyed refs stay readable: the ledger stores the ref it wrote, so old entries resolve
// through their own key forever.
export const analysisPassKey = (id: string, passId: string): string =>
  `${ANALYSIS_KEY_PREFIX}${id}/passes/${passId}.json`;
// …and the EXPORT PAYLOAD of that same pass (arch-review 54, Phase 4). Its own key rather than a field of
// the analysis bundle: the two are read by different consumers at different times (a human opening the
// analysis; a reconciler shipping to a sink days later), and one object serving both would make the export's
// bytes depend on the analysis bundle's shape.
export const exportPayloadKey = (id: string, passId: string): string =>
  `${ANALYSIS_KEY_PREFIX}${id}/passes/${passId}.export.json`;
// The INITIAL revision's writer. A batch settles once, so revision 1 has no competing pass to disambiguate
// — but it still deserves a frozen artifact, and giving it a stable synthetic id keeps every revision in one
// key family instead of splitting history across two schemes.
export const INITIAL_PASS_ID = "initial";

// ── …AND THE INITIAL PASS HAS COMPETING WRITERS TOO (review 39 P0-6) ────────────────────────────────
//
// The reasoning above — two passes, one revision number, an object store with no compare-and-set — was
// applied to re-scoring passes and then contradicted one line later by giving the INITIAL pass a literal id.
// A batch settles once, but its FINALIZER does not: a Temporal activity is at-least-once, an in-process
// driver can race a recovery, and both freeze a bundle before the ledger decides which of them settles. Under
// one shared key the loser's bytes simply replace the winner's, and the ledger then names a revision whose
// artifact describes a pass that did not happen.
//
// Keying by the bundle's own digest makes the collision impossible rather than unlikely: identical bundles
// share one object (which is correct — they are the same evidence), and different ones cannot overwrite each
// other. The winner's ledger entry points at its own key; the loser's object is an orphan nobody references.
export function initialPassId(bundle: AnalysisBundle): string {
  return `${INITIAL_PASS_ID}-${contentDigest(bundle)
    .replace(/^sha256:/, "")
    .slice(0, 16)}`;
}
// (legacy) the revision-keyed artifact — kept for reading pre-passId revisions, never written anymore.
export const analysisRevisionKey = (id: string, revision: number): string =>
  `${ANALYSIS_KEY_PREFIX}${id}/scoring/${revision}.json`;

export interface AnalysisOffload {
  ref?: string; // the CURRENT-key presigned ref (ScorecardRecord.analysisRef — the legacy latest surface)
  revisionRef?: string; // the frozen artifact's presigned ref (ScoringRevision.analysisRef)
  // The frozen artifact's durable KEY. A presigned ref expires, and the key is no longer derivable from the
  // revision number now that artifacts are pass-scoped — so the ledger entry has to remember where its own
  // bundle lives, or a historical read has nothing but an expired URL to go on.
  revisionKey?: string;
  // The EXPORT PAYLOAD this settlement froze (arch-review 54, Phase 4) — the results as counted, under a
  // pass-scoped immutable key. The publication operation carries the key so its drain reads what the
  // settlement published rather than whatever the record holds by the time the sweep gets to it.
  payloadKey?: string;
}

// ── STAGING, WITHOUT PUBLISHING (arch-review 52, Wave 4) ────────────────────────────────────────────
//
// The same bytes as `offloadAnalysis`, minus the one write that is VISIBLE OUTWARD: the mutable current-key
// alias. A settle stages its bundle under the content-addressed pass key BEFORE its terminal CAS — which is
// safe, because a loser's object is an orphan nobody references — and the alias promotion is carried across
// the commit by the publication plan instead (see `PublicationPlan` in `@everdict/contracts`).
//
// Best-effort, exactly like `offloadAnalysis`: a failed stage yields an absent key, the revision entry
// honestly carries no artifact, and nothing is planned for promotion.
export async function stageAnalysis(
  deps: Pick<ScorecardServiceDeps, "artifacts">,
  id: string,
  bundle: AnalysisBundle,
  passId: string,
  // The results this settlement counted, frozen beside the bundle (arch-review 54, Phase 4). Absent = a
  // caller that owes no export, which stages nothing extra.
  results?: readonly CaseResult[],
): Promise<AnalysisOffload> {
  if (!deps.artifacts) return {};
  const out: AnalysisOffload = {};
  try {
    const key = analysisPassKey(id, passId);
    out.revisionRef = await deps.artifacts.put(key, Buffer.from(JSON.stringify(bundle)), "application/json");
    out.revisionKey = key;
  } catch {
    // best-effort — the revision entry simply carries no artifact
  }
  // Staged SEPARATELY on purpose: an export whose payload could not be frozen must fall back to the
  // re-read-and-compare path rather than lose its analysis artifact too, and vice versa. Each failure costs
  // only what it is.
  if (results !== undefined)
    try {
      const key = exportPayloadKey(id, passId);
      await deps.artifacts.put(key, Buffer.from(JSON.stringify(results)), "application/json");
      out.payloadKey = key;
    } catch {
      // best-effort — the plan then carries a digest and no key, which is the pre-Phase-4 behaviour
    }
  return out;
}

// `offloadAnalysis` USED TO LIVE HERE (deleted arch-review 55, Wave 7). It wrote the mutable
// `analyses/<id>.json` alias at submit time, and its last production caller went away when settlements
// started STAGING their bundle under a pass-scoped key instead. Nothing has written that key since, and
// nothing reads it either for any revision that carries an `analysisKey` — which is every revision a modern
// settle appends. The analytics reader keeps its fallback so the objects written before all this still
// resolve; there is simply no longer a writer.
