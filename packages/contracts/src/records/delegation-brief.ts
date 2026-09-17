import { z } from "zod";
import { AgentReferenceTypeSchema } from "./agent-session.js";
import { ChangeJudgementAnswerSchema, ChangeSetEntrySchema, GateRunSchema } from "./change-campaign.js";

// The DELEGATION BRIEF — the context contract when everdict hands work to another agent environment.
//
// Delegation used to have exactly one channel: a prompt string. Everything that makes a handoff reproducible —
// what must be true when this is done, which evidence is being handed over, what the delegate must NOT do —
// had to be crammed into prose, and none of it survived as evidence. The brief is that handoff made
// structured: it is materialized INTO the delegate's sandbox (so the delegate reads it as a file, not only as
// a sentence it might lose from context) and stamped on the session's trajectory (so the ledger alone answers
// "what were they actually asked to do").
//
// The reference TYPE vocabulary is the agent's own (AGENT_REFERENCE_TYPES) — what everdict can point at has
// ONE answer, never a second list that drifts. The display `label` an @-mention carries is deliberately absent:
// a brief names WHAT is handed over, and whoever renders it resolves the title itself.
export const DelegationReferenceSchema = z.object({
  type: AgentReferenceTypeSchema,
  id: z.string().min(1),
  version: z.string().optional(),
  note: z.string().optional(), // why THIS is in the brief ("the case that regressed", "the failing trace")
});
export type DelegationReference = z.infer<typeof DelegationReferenceSchema>;

// ── A FINISH LINE IS NAMED, OR IT CANNOT BE ANSWERED ─────────────────────────────────────────────────
//
// `doneWhen` was a list of sentences, which is enough to READ and not enough to ANSWER. A delegate that
// finishes says "done"; a supervisor comparing that to four sentences is re-reading prose and deciding by
// impression, which is the same thing as not checking. An id makes each check a thing a report can bind an
// answer to — so "three of four met, the fourth not_met{needs_environment}" is a record rather than a feeling.
//
// The id is minted where the criterion is BORN (the door that authors the brief), never derived from the
// position later: a brief edited between the handoff and the report would otherwise silently re-number what
// the delegate was answering.
export const DelegationCriterionSchema = z.object({
  id: z.string().min(1).max(100),
  statement: z.string().min(1).max(2000),
});
export type DelegationCriterion = z.infer<typeof DelegationCriterionSchema>;

export const DelegationBriefSchema = z.object({
  goal: z.string().min(1), // what must be true when this is done — the one required field
  context: z.string().optional(), // background prose: what happened, what has been tried
  references: z.array(DelegationReferenceSchema).default([]), // the evidence handed over
  constraints: z.array(z.string()).default([]), // what the delegate must not do / must preserve
  doneWhen: z.array(DelegationCriterionSchema).default([]), // the checks the delegator will apply to the result
});
export type DelegationBrief = z.infer<typeof DelegationBriefSchema>;

// ── THE OTHER END OF THE HANDOFF ─────────────────────────────────────────────────────────────────────
//
// The brief has been a contract in one direction for as long as it has existed, and nothing came back along
// it. A delegate finished, its turn settled, and what it had done was recoverable only by reading a trace or
// running `sandbox_exec` against a container that was about to die. `doneWhen` — the field whose whole purpose
// is to be checked — was never answered by anyone.
//
// ⚠️ THE VOCABULARY HERE IS DELIBERATELY NOT NEW. A report is a PROPOSED change round: the same
// `ChangeSetEntry` for what landed, the same `GateRun` for what was measured with numbers, the same
// `ChangeJudgementAnswer` for the per-criterion verdict with its unmet reasons. Inventing a second set of
// words for "what a piece of work achieved" would mean two of everything — two ways to say `not_met`, two
// notions of evidence — and the campaign lane would have to translate one into the other at exactly the seam
// where a supervisor decides whether to accept the work.
//
// What it is NOT: a judgement. The delegate answers its criteria and says what it did; whether that is
// ACCEPTED is the supervisor's decision, made after `reviewDelegateReport` says the report is even answerable.
// A delegate that could adopt its own round would be grading its own exam.
export const DelegateReportSchema = z.object({
  // The final message — what the supervisor reads first, and the one required field. A report with nothing
  // else is still a report; a report with no summary is a delegate that finished without saying anything.
  summary: z.string().min(1).max(8000),
  // One per `doneWhen` criterion. `reviewDelegateReport` is what refuses a set that does not correspond.
  answers: z.array(ChangeJudgementAnswerSchema).max(200).default([]),
  changes: z.array(ChangeSetEntrySchema).max(50).default([]),
  gateRuns: z.array(GateRunSchema).max(50).default([]),
  // What the work taught — the seed of a knowledge entry. Carried here rather than written by the delegate
  // itself: the delegate reports, the supervisor records (see the delegation lane's knowledge path).
  learned: z.string().max(4000).optional(),
  // What it could not get past, in its own words. Separate from a `not_met` reason because a blocker can stop
  // a delegate before it has an opinion about any criterion at all.
  blockers: z.array(z.string().max(1000)).max(20).default([]),
});
export type DelegateReport = z.infer<typeof DelegateReportSchema>;
