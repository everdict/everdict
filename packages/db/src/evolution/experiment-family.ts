import type { ReserveCampaignEvaluation } from "@everdict/application-control";
import {
  type CampaignEvaluation,
  ConflictError,
  type EvolutionCampaignRecord,
  type ExperimentFamily,
} from "@everdict/contracts";
import { campaignRoundRefusal, contentDigest } from "@everdict/domain";

export function familyMembers(
  campaignId: string,
  records: EvolutionCampaignRecord[],
): { root: EvolutionCampaignRecord; members: EvolutionCampaignRecord[] } {
  const map = new Map(records.map((r) => [r.id, r]));
  let root = map.get(campaignId);
  if (!root) throw new ConflictError("CONFLICT", {}, "campaign does not exist");
  const seen = new Set<string>();
  while (root.frame.continues) {
    if (seen.has(root.id)) throw new ConflictError("CONFLICT", {}, "cyclic experiment family");
    seen.add(root.id);
    const parent = map.get(root.frame.continues);
    if (!parent) throw new ConflictError("CONFLICT", {}, "experiment family predecessor is missing");
    root = parent;
  }
  const ids = new Set([root.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of records)
      if (r.frame.continues && ids.has(r.frame.continues) && !ids.has(r.id)) {
        ids.add(r.id);
        grew = true;
      }
  }
  return { root, members: records.filter((r) => ids.has(r.id)) };
}

export function reserveInFamily(
  input: ReserveCampaignEvaluation,
  records: EvolutionCampaignRecord[],
  family: ExperimentFamily | undefined,
  attempts: CampaignEvaluation[],
): { family: ExperimentFamily; evaluation: CampaignEvaluation; kind: "reserved" | "replay"; scorecardId: string } {
  const campaign = records.find((r) => r.id === input.campaignId && r.tenant === input.tenant);
  if (!campaign) throw new ConflictError("CONFLICT", {}, "campaign does not exist");
  const { root, members } = familyMembers(campaign.id, records);
  const id = contentDigest([input.tenant, campaign.id, input.requestId]);
  const old = attempts.find((a) => a.id === id);
  if (old && old.candidateVersion !== input.candidateVersion)
    throw new ConflictError("CONFLICT", {}, "evaluation request id belongs to another candidate");
  const binding = old?.[input.side];
  const limit = root.frame.significance.heldOutFamilySize ?? root.frame.budget.maxRounds;
  const current = family ?? {
    id: root.id,
    tenant: input.tenant,
    limit,
    consumed: members.reduce((n, r) => n + r.rounds.filter((round) => !round.verdict.evaluationId).length, 0),
  };
  if (binding) {
    if (binding.requestDigest !== input.requestDigest)
      throw new ConflictError("CONFLICT", {}, "evaluation request id was reused with different submission bytes");
    return { family: current, evaluation: old, kind: "replay", scorecardId: binding.scorecardId };
  }
  if (
    attempts.some(
      (a) => a.baseline?.scorecardId === input.scorecardId || a.candidate?.scorecardId === input.scorecardId,
    )
  )
    throw new ConflictError("CONFLICT", {}, "a scorecard is already bound to an evaluation");
  if (campaign.state !== "open" || old?.reportedRound !== undefined)
    throw new ConflictError("CONFLICT", {}, "campaign or evaluation is already settled");
  const ended = campaignRoundRefusal(campaign.frame, campaign.rounds);
  if (ended) throw new ConflictError("CONFLICT", {}, ended.detail);
  const want = campaign.frame.scenarios.map((s) => s.id).sort();
  if (
    JSON.stringify([...input.caseIds].sort()) !== JSON.stringify(want) ||
    input.trials !== campaign.frame.trialsPerCase
  )
    throw new ConflictError(
      "CONFLICT",
      {},
      "a campaign evaluation must request exactly its frozen scenarios and trials",
    );
  const ownSpent =
    attempts.filter((a) => a.campaignId === campaign.id).length +
    campaign.rounds.filter((r) => !r.verdict.evaluationId).length;
  if (!old && (current.consumed >= current.limit || ownSpent >= campaign.frame.budget.maxRounds))
    throw new ConflictError(
      "CONFLICT",
      { family: current },
      "experiment family or campaign evaluation budget is exhausted",
    );
  const evaluation: CampaignEvaluation = {
    ...(old ?? {
      id,
      tenant: input.tenant,
      familyId: root.id,
      campaignId: campaign.id,
      requestId: input.requestId,
      candidateVersion: input.candidateVersion,
      createdAt: input.at,
    }),
    [input.side]: { scorecardId: input.scorecardId, requestDigest: input.requestDigest },
  };
  return {
    family: { ...current, consumed: current.consumed + (old ? 0 : 1) },
    evaluation,
    kind: "reserved",
    scorecardId: input.scorecardId,
  };
}
