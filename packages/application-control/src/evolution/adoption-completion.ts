import type { AdoptionOperation, DomainFact } from "@everdict/contracts";

// ── WHAT BOTH SIDES OF THE COMPLETION JOIN SHARE (arch-review 84) ───────────────────────────────────
//
// The join is symmetric on purpose: an E1 consumer owns `issue done → registered` and the registration path
// owns `registered → issue done`, so whichever fact lands second performs it. That symmetry means the two
// modules need the SAME predicate and the SAME fact — and putting either of them in one of the two writers
// made them import each other.
//
// A cycle between two modules is not a style complaint here. ESM tolerates it only while every use is
// deferred to call time; move one of them to module scope — a `const` derived at import, a decorator, a
// registry populated on load — and one side sees a half-initialized namespace. Nothing in this repository
// checks for cycles, so it would be found by a runtime `undefined` rather than by a gate.
//
// So the shared values live where neither writer owns them: this file imports from neither side.

// Did THIS issue close on THIS adoption's evidence. One predicate, two consumers — written twice it has
// already diverged (rule `protocol` L3), and the two spellings this replaced even read different fields:
// one took `payload.scorecardId` off an event, the other `resolution.scorecardId` off a record.
export function issueSettledThisAdoption(
  issue: { status: string; resolution?: { scorecardId?: string } },
  proof: { provingScorecardId: string },
): boolean {
  // `done` and nothing else: `regressed` is a later fact about the capability, not a retraction of the
  // completion, and an issue still open has settled nothing.
  if (issue.status !== "done") return false;
  // Absence is not a match. An issue closed on something other than measured evidence — a different fix, a
  // sibling campaign, a member's judgement — did not discharge THIS adoption's intent.
  return issue.resolution?.scorecardId === proof.provingScorecardId;
}

// The completion fact, authored once and consumed by both writers of the transition — the same reason the
// predicate above has one owner. Semantic data only: the sentence is the projector's, so the payload carries
// every value the rendering needs rather than just filterable ids (rule `events`).
// `causedBy` only where the cause is KNOWN. The registration path knows the agent that adopted, so a
// completion it performs is that agent's own effect and loop guard #1 must recognize it. The E1 watch does
// NOT know who resolved the issue, and inventing a cause there would suppress a wakeup somebody is owed —
// over-stamping this field is as wrong as under-stamping it (arch-review 85).
export function completionFact(operation: AdoptionOperation, causedBy?: string): DomainFact {
  return {
    kind: "campaign.adoption_completed",
    subject: { type: "campaign", id: operation.proof.campaignId },
    actor: "everdict:adoption-completion",
    ...(causedBy !== undefined ? { causedBy } : {}),
    payload: {
      campaignId: operation.proof.campaignId,
      candidateId: operation.proof.candidate.id,
      version: operation.registeredVersion ?? operation.proof.candidate.version,
      issueId: operation.proof.issueId,
      provingScorecardId: operation.proof.provingScorecardId,
      ...(operation.proof.teamId !== undefined ? { teamId: operation.proof.teamId } : {}),
    },
  };
}
