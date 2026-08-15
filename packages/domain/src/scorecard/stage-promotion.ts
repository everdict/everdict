import type { CaseResult, Score } from "@everdict/contracts";
import { childKey, stripJudgeScores } from "./scoring-plan.js";

// Whether a scoring pass's write-ahead STAGE may be promoted to the source of truth
// (docs/architecture/scoring-plane-revisions.md, the contract step).
//
// This lives in the DOMAIN, not on the store port (arch-review 12). A port says how to read and write a
// thing; "is this parity good enough to move the source of truth" is a pure policy decision over numbers,
// with no I/O and no storage knowledge — exactly the admission test the layer spine states. Keeping it on
// the port meant the one rule that gates an irreversible migration lived next to SQL helpers.

// What one pass's stage looked like against the plane it actually wrote. Reported per settled pass so a
// mismatch names the pass, not a daily aggregate nobody can trace back.
export interface ScoringStageParity {
  scorecardId: string;
  passId: string;
  // Did the comparison itself run (arch-review 13 P1)? A parity report that could not be produced — the
  // stage read threw, the store was gone — used to fire nothing at all, so an operator watching
  // `mismatched = 0` was watching a series that says the same thing whether every pass agreed or no pass was
  // ever checked. The suite's oldest rule applies to migration telemetry too: what was not observed is not
  // green. A `completed: false` report carries the reason and nothing else; it exists to be counted.
  completed: boolean;
  failure?: string;
  // What this pass ACTUALLY JUDGED, derived from the settled plane rather than from the stage (arch-review
  // 11). A comparison that walks the staged rows can only report on the writes that SUCCEEDED, so a pass
  // that judged 100 cases and failed to stage 20 graphed as perfect parity over a 20% loss. The stage write
  // is best-effort by design, which is precisely why the measurement cannot be sourced from it.
  expectedJudged: number;
  staged: number;
  // Judged, but NOT in the stage. A promotion would silently drop these — the failure mode a stage-only
  // comparison is structurally blind to.
  missingFromStage: string[];
  // Of the staged rows, how many carry exactly the judgments the live plane ended up with.
  matched: number;
  // Cases whose staged judgment differs from the plane — the ones a promotion would have changed.
  mismatched: string[];
  // Staged for a case the plane has no row for at all. A promotion would INVENT a row here, which is why it
  // is counted apart from a plain value mismatch.
  orphaned: string[];
  // WHICH PLANE THIS COMPARISON WAS TAKEN AGAINST (arch-review 44 ②) — the digest of the carrier plane the
  // stage was compared to, pinned into the observation itself.
  //
  // Parity's entire meaning is "the stage agrees with the plane this pass WROTE". The contract step's whole
  // job is to make the settled plane come from the stage instead — and at that moment the obvious refactor
  // (compare against the plane being settled) turns the comparison into stage-vs-stage: perfect agreement,
  // for free, on every pass, with the fleet gate reading it as evidence. Until now the only thing standing
  // between the migration and that outcome was the ORDER of two statements in one private method, plus a
  // comment asking the next reader not to move them.
  //
  // So the observation states its basis and the promotion checks it. A comparison taken against anything
  // other than the plane being promoted FROM is refused by name rather than believed. Absent = an observation
  // from before this era pinned one, which under the current era is itself a refusal (see below).
  basisDigest?: string;
}

// THE OBSERVER'S ERA. Bumped whenever the parity comparison changes what it MEANS — a different expectation
// source, a different unit, a different equality. Evidence stamped under an older number is not weaker data
// about the same question; it is data about a different one, and the readiness gate below refuses to count it.
//
//   1 — settled-plane expectation, per-judge units, canonical Score equality, `completed` reporting.
//   2 — …and the comparison's BASIS is pinned (`basisDigest`): the observation names the carrier plane it was
//       taken against, and a promotion refuses an observation taken against any other. Era 1's evidence was
//       gathered while "compared against the carriers" was a convention rather than a checked fact, and the
//       contract step is precisely the change that would break the convention — so era-1 greens are not
//       weaker evidence about era 2's question, they are evidence about a different one.
export const CURRENT_STAGE_PARITY_VERSION = 2;

// The contract step's precondition, as code so nobody reconstructs it from a dashboard. `staged === matched`
// is NOT it: that holds trivially when nothing was staged, which is the exact failure being guarded against.
export function stagePromotionSafe(parity: ScoringStageParity): boolean {
  if (!parity.completed) return false; // an unmeasured pass is not a passing one
  return (
    parity.expectedJudged === parity.staged &&
    parity.staged === parity.matched &&
    parity.missingFromStage.length === 0 &&
    parity.mismatched.length === 0 &&
    parity.orphaned.length === 0
  );
}

// WHY a pass may not be promoted, as a sentence — the one spelling, so the revision, the step an operator
// reads and any future gate cannot each describe the same refusal differently. `undefined` = nothing to say.
//
// `promotingFrom` is the digest of the plane the caller is about to merge the stage ONTO. Passing it turns
// the basis rule from a comment into a check (see `ScoringStageParity.basisDigest`): a comparison taken
// against a different plane than the one being promoted from is not weak evidence, it is evidence about
// another question — and in the one case that matters (the settled plane having become the PROMOTED plane)
// it is a comparison of the stage with itself, which agrees perfectly and certifies nothing. Omit it and the
// basis is not examined, which is what every caller that is not promoting wants.
export function stagePromotionRefusal(parity: ScoringStageParity, promotingFrom?: string): string | undefined {
  if (!parity.completed)
    return `the stage/plane parity comparison did not complete (${parity.failure ?? "unknown"}) — an unmeasured pass is not an agreeing one`;
  if (promotingFrom !== undefined) {
    // Fail-closed on an UNPINNED observation too. Under the current era every comparison states its basis, so
    // one that does not was produced by other code — and "we cannot tell what this was compared against" is
    // exactly the answer that must not be read as "the carriers".
    if (parity.basisDigest === undefined)
      return "the parity comparison did not pin the plane it was taken against — a promotion cannot tell whether it was compared to the carriers or to itself";
    if (parity.basisDigest !== promotingFrom)
      return `the parity comparison was taken against a different plane than the one being promoted from (compared to ${parity.basisDigest}, promoting from ${promotingFrom}) — a comparison re-based onto the promoted plane compares the stage with itself`;
  }
  if (stagePromotionSafe(parity)) return undefined;
  return (
    `the staged judgments do not match the plane this pass settled: judged=${parity.expectedJudged} staged=${parity.staged} ` +
    `matched=${parity.matched} missingFromStage=${parity.missingFromStage.length} mismatched=${parity.mismatched.length} ` +
    `orphaned=${parity.orphaned.length}`
  );
}

// ONE (case, judge) row as the promotion reads it — the stage's own unit, restated here so the domain merge
// does not have to import a store port (the layer spine forbids it, and the shape is three fields).
export interface StagedJudgmentRow {
  caseKey: string; // caseId#trial
  judgeId: string;
  scores: Score[];
}

// THE PROMOTION'S MERGE — the one piece of the contract step that had never been written down as code.
//
// The stage holds a DELTA: what THIS pass produced, per (case, judge). The carriers hold everything else —
// graders, judges this pass did not select, judgments inherited from the previous revision. So the promoted
// plane is not "the stage" and never was: it is the carrier plane with each PRODUCED judge family replaced by
// the staged one, which is exactly the distinction the stage was re-shaped into a delta to preserve
// (arch-review 11). Writing the merge as "whatever the stage says" would drop every inherited row on the
// floor, and the mistake would look like a scoring bug rather than a migration one.
//
// A judge with no staged row for a case keeps its carrier rows untouched — absence in a delta means "this
// pass produced nothing here", never "delete what is there". Whether that absence is LEGITIMATE is the parity
// report's question (`missingFromStage`), and the caller must have asked it before promoting.
//
// Pure and total: no I/O, no ordering assumptions beyond its own (the promoted families are appended in a
// deterministic order, and `scorePlaneDigest` sorts, so row order is not content).
export function promoteStagedJudgments(
  results: readonly CaseResult[],
  staged: readonly StagedJudgmentRow[],
  judges: ReadonlyArray<{ id: string }>,
): CaseResult[] {
  const selected = new Set(judges.map((j) => j.id));
  const byCase = new Map<string, StagedJudgmentRow[]>();
  for (const row of staged) {
    if (!selected.has(row.judgeId)) continue; // a row for a judge this pass did not select is not its delta
    byCase.set(row.caseKey, [...(byCase.get(row.caseKey) ?? []), row]);
  }
  return results.map((result) => {
    const rows = byCase.get(childKey(result.caseId, result.trial));
    if (rows === undefined || rows.length === 0) return result;
    const ordered = [...rows].sort((a, b) => a.judgeId.localeCompare(b.judgeId));
    const promoted = ordered.map((row) => ({ id: row.judgeId }));
    return {
      ...result,
      scores: [...stripJudgeScores(result.scores, promoted), ...ordered.flatMap((row) => row.scores)],
    };
  });
}

// WHETHER THE FLEET MAY TAKE THE CONTRACT STEP — the aggregate over what passes actually observed.
//
// `stagePromotionSafe` answers it for ONE pass. The migration is a decision about all of them, and it has
// been carried across five reviews as "deferred pending observed real-traffic parity" — a precondition
// stated in prose, which means nobody could ever say whether it had been met. It is now a function over the
// durable observations (`ScoringRevision.stageParity`), so the answer comes from evidence rather than from
// somebody's reading of a dashboard.
//
// Two rules, both inherited from this suite's oldest one — NOT EVALUATED IS NEVER GREEN:
//
//   1. An UNOBSERVED pass is not a passing pass. A revision with no `stageParity` predates the observation
//      or ran with no stage wired; either way it is evidence of nothing, and counting it as agreement is how
//      "0 mismatches" comes to mean "0 comparisons".
//   2. ONE incomplete report blocks. A comparison that could not run is the case the operator most needs to
//      see, and averaging it away is the failure this whole field exists to prevent.
//
// `minimumObserved` is the caller's — how much traffic is enough is a product judgement, not a domain one.
export interface StagePromotionReadiness {
  // Every recorded observation, whatever it said.
  observed: number;
  // …of which agreed completely (`promotionSafe`).
  safe: number;
  // Revisions carrying no observation at all — the denominator that makes `safe` meaningful.
  unobserved: number;
  // Comparisons that could not run. Any of these blocks, regardless of the counts.
  incomplete: number;
  // The passes that disagreed, named — a promotion decision has to be traceable to the units that block it.
  blockedBy: Array<{ scorecardId?: string; passId?: string; reason: string }>;
  ready: boolean;
}

export function stagePromotionReadiness(
  revisions: ReadonlyArray<{
    scorecardId?: string;
    passId?: string;
    stageParity?: { version?: number; completed: boolean; failure?: string; promotionSafe: boolean };
  }>,
  minimumObserved: number,
  // Which observer's evidence counts. Defaults to the current one — a caller asking about the contract step
  // is asking about today's comparison, and having to remember to say so would be a footgun with a green
  // default.
  parityVersion: number = CURRENT_STAGE_PARITY_VERSION,
): StagePromotionReadiness {
  const blockedBy: StagePromotionReadiness["blockedBy"] = [];
  let observed = 0;
  let safe = 0;
  let unobserved = 0;
  let incomplete = 0;
  for (const revision of revisions) {
    const parity = revision.stageParity;
    // An observation from another ERA is not an observation of this question (arch-review 23 P1). Counted as
    // unobserved rather than dropped, so it still moves the denominator the minimum is measured against —
    // a fleet whose evidence is all stale has not observed today's comparison at all.
    if (parity === undefined || (parity.version ?? 0) !== parityVersion) {
      unobserved += 1;
      continue;
    }
    observed += 1;
    if (!parity.completed) {
      incomplete += 1;
      blockedBy.push({
        ...(revision.scorecardId !== undefined ? { scorecardId: revision.scorecardId } : {}),
        ...(revision.passId !== undefined ? { passId: revision.passId } : {}),
        reason: parity.failure ?? "the parity comparison did not complete",
      });
      continue;
    }
    if (parity.promotionSafe) {
      safe += 1;
      continue;
    }
    blockedBy.push({
      ...(revision.scorecardId !== undefined ? { scorecardId: revision.scorecardId } : {}),
      ...(revision.passId !== undefined ? { passId: revision.passId } : {}),
      reason: "the staged judgments differ from the plane this pass settled",
    });
  }
  return {
    observed,
    safe,
    unobserved,
    incomplete,
    blockedBy,
    // Enough evidence, all of it clean. `minimumObserved` guards the trivial case the per-pass rule already
    // refuses one level down: a fleet that never staged anything agrees with itself perfectly.
    ready: observed >= minimumObserved && minimumObserved > 0 && blockedBy.length === 0,
  };
}
