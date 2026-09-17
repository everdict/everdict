import { z } from "zod";

// ── THE `change` GRADE (docs/architecture/change-campaign-spec.md) ────────────────────────────────────
//
// Every code change is a campaign. The EVALUATED grade (EvolutionCampaignRecord) judges an agent, harness or
// environment against a frozen exam; this one judges a CHANGE to a service against the repository's own
// gates, as the agent that made it read them. Two grades, one spine — both name the issue they serve, so a
// request is one read away from the code that shipped and from what the work taught.
//
// It is a separate record on purpose. Making the evaluated campaign's `frame` optional would force every
// reader of a gate to ask "is there an exam here at all", which is the defect this codebase names in its
// protocol laws: the right noun consumed as an optional annotation. The trust harness rests on that record.

// WHAT "DONE" MEANS, DECLARED BEFORE THE WORK. A criterion assembled afterwards from whatever happened to
// pass is a description of the outcome, not a gate — the frozen-frame discipline applied to a weaker verdict.
export const ChangeCriterionSchema = z.object({
  id: z.string().min(1).max(100),
  statement: z.string().min(1).max(2000),
});
export type ChangeCriterion = z.infer<typeof ChangeCriterionSchema>;

// A service touched by one round: the repository, the subpath when the service is one of several in it, and
// the commits that actually landed. A request routinely moves an API, a BFF and an app, and it is satisfied
// only when all of them are in — so the change set is a LIST, and a round that names one repository is the
// single-service case of the general shape rather than the shape itself.
export const ChangeSetEntrySchema = z.object({
  repository: z.string().min(1).max(200), // "owner/name"
  path: z.string().max(200).optional(), // the subpath inside a monorepo, when the service is one
  commits: z
    .array(
      z.object({
        sha: z.string().min(7).max(64),
        message: z.string().max(500).optional(),
        at: z.string().optional(),
      }),
    )
    .max(200),
  pr: z
    .object({ number: z.number().int().positive(), url: z.string().optional(), mergedSha: z.string().optional() })
    .optional(),
});
export type ChangeSetEntry = z.infer<typeof ChangeSetEntrySchema>;

// HOW THE JUDGE KNOWS. `observed` means a command ran and its result is nameable; `asserted` means the agent
// read the code and concluded. Both are legitimate and they are not the same evidence, which is why the
// answer carries the distinction rather than a reader inferring it from the wording (E09: an inferred
// diagnosis belongs in an advice field, never in place of the recorded result).
// ── THE GATE'S OUTPUT IS QUANTITATIVE (maintainer, 2026-09-17) ───────────────────────────────────────
//
// "The suite is green" is a sentence; "4027 passed, 0 failed, 51 of 51 tasks" is a measurement, and only the
// second can be compared to the next round, watched for regression, or disagreed with. The agent still does
// the evaluating — what changes is that its `observed` answers must point at NUMBERS it can name.
//
// `metrics` is an open list rather than a fixed schema because every repository's gates count different
// things; what is NOT optional is that there be some.
export const GateMetricSchema = z.object({
  name: z.string().min(1).max(100), // "tests.passed" · "tasks.total" · "coverage.lines"
  value: z.number(),
  unit: z.string().max(20).optional(), // "percent" · "ms" · absent = a count
});
export type GateMetric = z.infer<typeof GateMetricSchema>;

export const GateRunSchema = z.object({
  id: z.string().min(1).max(100), // the criterion's gate: "tests" · "typecheck" · "lint"
  command: z.string().min(1).max(500),
  exitCode: z.number().int(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  // At least one. A gate run that reports no number is a sentence with an exit code attached, which is the
  // thing this field exists to replace.
  metrics: z.array(GateMetricSchema).min(1).max(50),
});
export type GateRun = z.infer<typeof GateRunSchema>;

export const CriterionEvidenceKindSchema = z.enum(["observed", "asserted"]);
export const CriterionAnswerSchema = z.enum(["met", "not_met", "not_run"]);
export type CriterionAnswer = z.infer<typeof CriterionAnswerSchema>;

export const ChangeJudgementAnswerSchema = z.object({
  criterionId: z.string().min(1),
  answer: CriterionAnswerSchema,
  how: CriterionEvidenceKindSchema,
  // What was run, or what was read. Free text, because the shape of "how" differs per gate and pretending
  // otherwise would push every repository's checks through one schema that fits none of them.
  detail: z.string().max(2000).optional(),
  // WHICH gate runs support this answer (`GateRun.id`). Required by the domain for an `observed` answer: an
  // observation that names no measurement is an assertion wearing the other word.
  gateRunIds: z.array(z.string().min(1)).max(20).default([]),
});
export type ChangeJudgementAnswer = z.infer<typeof ChangeJudgementAnswerSchema>;

// THE JUDGEMENT IS THE AGENT'S, AND IT SAYS WHOSE. `checkpointId` points at the executor's claim
// (publish_checkpoint) when one was filed: that record already enforces evidence-per-fact and stamps which
// references resolved, so the campaign references it instead of restating it. `by` is the actor that judged
// — a self-judgement recorded AS a self-judgement, which is what makes an independent verification later
// mean something.
export const ChangeJudgementSchema = z.object({
  at: z.string(),
  by: z.string().min(1),
  checkpointId: z.string().min(1).optional(),
  answers: z.array(ChangeJudgementAnswerSchema).max(200),
});
export type ChangeJudgement = z.infer<typeof ChangeJudgementSchema>;

// One attempt: what it believed, what it changed, and how it was judged. Rounds are append-only — a rejected
// attempt is a round, not a deletion, because what failed is what the next attempt is built on (WikiSkill's
// contribution: the knowledge survives the rollback).
export const ChangeRoundSchema = z.object({
  seq: z.number().int().min(1),
  hypothesis: z.string().min(1).max(2000),
  changes: z.array(ChangeSetEntrySchema).max(50),
  // What the repository's own gates answered, with numbers. The AGENT decides when the round is closed
  // (maintainer, 2026-09-17) — no merge event, no external trigger — so the moment a round is logged IS the
  // moment its agent judged it finished, and these are the measurements it judged on.
  gateRuns: z.array(GateRunSchema).max(50).default([]),
  judgement: ChangeJudgementSchema,
  outcome: z.enum(["adopted", "rejected"]),
  learned: z.string().max(4000).optional(),
});
export type ChangeRound = z.infer<typeof ChangeRoundSchema>;

export const ChangeCampaignStateSchema = z.enum(["open", "adopted", "partially_adopted", "abandoned"]);
export type ChangeCampaignState = z.infer<typeof ChangeCampaignStateSchema>;

// A REQUEST IS OFTEN SATISFIED IN PIECES (maintainer, 2026-09-17). Four services, two of them in: that is
// neither `adopted` nor `abandoned`, and calling it either loses the half that matters. `partially_adopted`
// names what landed and what is left, and the remainder is picked up by a SUCCESSOR campaign that names this
// one — a walk is a chain of campaigns, not a campaign that runs forever.
export const ChangeCampaignCloseSchema = z.object({
  at: z.string(),
  by: z.string().min(1),
  state: z.enum(["adopted", "partially_adopted", "abandoned"]),
  // Required when `partially_adopted`, refused otherwise: the services this campaign actually landed, and the
  // ones still owed. "Partially" with no list is the same silence the state exists to break.
  landed: z
    .array(z.object({ repository: z.string().min(1), path: z.string().optional() }))
    .max(50)
    .default([]),
  remaining: z
    .array(z.object({ repository: z.string().min(1), path: z.string().optional() }))
    .max(50)
    .default([]),
  // Why it ended this way. An abandoned campaign without one is a campaign that merely stopped.
  reason: z.string().min(1).max(2000),
  // The round that carried it, so "what shipped" is a lookup rather than a scan.
  roundSeq: z.number().int().min(1).optional(),
  // What the work taught, or the declared refusal — `Knowledge: none — <why>`. A campaign may not close in
  // silence: accepted ≠ learned (protocol L5 applied to learning).
  knowledge: z.array(z.string().min(1)).max(32).default([]),
  knowledgeDeclined: z.string().max(500).optional(),
});
export type ChangeCampaignClose = z.infer<typeof ChangeCampaignCloseSchema>;

export const ChangeCampaignRecordSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  // The intent hub, exactly as the evaluated grade uses it: the issue journals the narrative and carries the
  // resolution; the campaign references it rather than duplicating any of it.
  issueId: z.string().min(1),
  service: z.object({ repository: z.string().min(1).max(200), path: z.string().max(200).optional() }),
  // The campaign this one continues — the remainder of a `partially_adopted` predecessor, or a second attempt
  // after an abandonment. ONE OPEN CAMPAIGN PER ISSUE (maintainer, 2026-09-17), so a request's history is a
  // chain rather than a set nobody can order, and "which attempt changed this commit" stays answerable across
  // the whole walk rather than only inside one campaign.
  continues: z.string().min(1).optional(),
  criteria: z.array(ChangeCriterionSchema).min(1).max(100),
  rounds: z.array(ChangeRoundSchema).default([]),
  state: ChangeCampaignStateSchema,
  close: ChangeCampaignCloseSchema.optional(),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangeCampaignRecord = z.infer<typeof ChangeCampaignRecordSchema>;
