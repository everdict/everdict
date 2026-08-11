import { type StagePromotionReadiness, stagePromotionReadiness } from "@everdict/domain";
import type { ScorecardStore } from "../ports/scorecard-store.js";

// THE GATE'S READER (arch-review 23, final). `stagePromotionReadiness` decides; this is what asks it, over
// the observations the settled passes actually recorded.
//
// It exists because a decision function nobody calls is a deferral with extra steps — the contract step spent
// five reviews as a sentence in a document precisely because no surface could answer "are we there yet". It
// answers honestly from the start: with no evidence under the current parity era, it reports `observed: 0`
// and `ready: false`, which is the true state of a migration nobody has measured rather than a blocker
// nobody can see.
//
// Tenant-scoped like every other read here; `undefined` is the operator's cross-workspace view.
export async function stagePromotionReport(
  scorecards: ScorecardStore,
  tenant: string | undefined,
  minimumObserved: number,
): Promise<StagePromotionReadiness> {
  const records = await scorecards.list(tenant);
  // One entry per settled scoring PASS — the unit the parity comparison observes and the unit the promotion
  // would move. A batch with several revisions contributes each of them.
  const revisions = records.flatMap((record) =>
    (record.scoring ?? []).map((revision) => ({
      scorecardId: record.id,
      // The revision ordinal names the pass here — a revision entry does not carry the pass id, and
      // `scorecard#revision` is the coordinate an operator would look it up by anyway.
      passId: `${record.id}#${revision.revision}`,
      ...(revision.stageParity ? { stageParity: revision.stageParity } : {}),
    })),
  );
  return stagePromotionReadiness(revisions, minimumObserved);
}
