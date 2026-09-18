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

// ── WHAT A CRITERION JUDGES (maintainer, 2026-09-17) ─────────────────────────────────────────────────
//
// A campaign's criteria are two different things wearing one name. Some answer a REQUEST the issue made ("the
// photo opens"); others judge the WORK ITSELF ("the suite is no worse", "the counterexample was seen red").
// Only the first kind can be counted against "how much of this request is done", and until the distinction
// was in the type, it was in the reader's head — so "3 of the 5 things you asked for" lived in a prose
// `detail` field and no query could reach it.
//
// The observed failure: a campaign declared one criterion "all five reports are diagnosed", answered it
// `not_met`, and the round came back `rejected` — correct by the arithmetic, and useless as an account.
// Nothing recorded that two of the five HAD shipped, nor that the other three were blocked for three
// different reasons. The count is the product here: a request is satisfied in pieces, and a record that
// cannot name the pieces cannot say which ones are still owed.
//
// `judges` is REQUIRED, and a discriminated union rather than an optional `issueId`. An optional pin would
// make "this criterion answers no request" and "the author did not say" the same value, which is the defect
// this codebase's protocol laws name: the right noun consumed as an optional annotation.
export const CriterionSubjectSchema = z.discriminatedUnion("kind", [
  // Answers a REQUEST — normally a sub-issue of the campaign's issue, one per thing that was asked for. The
  // service resolves it at open (store the id, never the spelling) and refuses one the workspace does not
  // have, so a criterion cannot be pinned to a requirement nobody can look up.
  z.object({ kind: z.literal("requirement"), issueId: z.string().min(1) }),
  // Judges the CHANGE — gates, regressions, counterexamples seen red. Never counted as a requirement, and
  // saying so out loud is what keeps the requirement count honest in both directions: a campaign cannot pad
  // it with quality gates, and it cannot hide an unmet request among them.
  z.object({ kind: z.literal("quality") }),
  // ⚠️ MIGRATION ONLY, and deliberately not a synonym for either of the above. Criteria written before this
  // distinction existed cannot be classified without guessing, and guessing them into `quality` would report
  // an unmet REQUEST as a passed gate. "We do not know" is a third value (protocol L2), so the rollup counts
  // these separately and says so rather than folding them into an answer. The request schema does NOT accept
  // it: nothing new may be born unclassified.
  z.object({ kind: z.literal("unclassified") }),
]);
export type CriterionSubject = z.infer<typeof CriterionSubjectSchema>;

// WHAT "DONE" MEANS, DECLARED BEFORE THE WORK. A criterion assembled afterwards from whatever happened to
// pass is a description of the outcome, not a gate — the frozen-frame discipline applied to a weaker verdict.
export const ChangeCriterionSchema = z.object({
  id: z.string().min(1).max(100),
  statement: z.string().min(1).max(2000),
  judges: CriterionSubjectSchema,
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

// ── WHY IT IS NOT MET, AS A VALUE (maintainer, 2026-09-17) ───────────────────────────────────────────
//
// "Which ones failed, and why" is the second half of the account, and it was prose. `not_met` alone collapses
// answers that call for completely different next actions: an attempt that ran and fell short is work to
// redo; a criterion nobody could judge without a device or a repro path is not work at all — it is a REQUEST
// for something the session did not have, and it stays invisible until someone re-reads the detail field.
//
// A closed vocabulary because the point is to COUNT them. Free text cannot answer "how many of our unmet
// criteria are waiting on information we could just go and get".
export const UnmetReasonSchema = z.enum([
  // Tried, and the change did not achieve it. The only one that means "do the work again".
  "attempted_and_failed",
  // Cannot be judged without something the work does not have: a repro path, a log, the reporter's answer.
  "needs_information",
  // Cannot be judged without an environment this session lacks: a device, a staging service, real hardware.
  "needs_environment",
  // Depends on a decision or a change outside this service — another team, another repository, a product call.
  "blocked_elsewhere",
  // Deliberately dropped from THIS campaign. Still not met; the difference is that nobody is waiting on it.
  "descoped",
]);
export type UnmetReason = z.infer<typeof UnmetReasonSchema>;

// The answer is a union on `answer` so that an unmet criterion WITHOUT a reason is unrepresentable rather
// than merely discouraged. `met` carries no reason for the same purpose in the other direction: a reason on a
// met criterion would be a second verdict with no way to choose.
const answerCommonShape = {
  criterionId: z.string().min(1),
  how: CriterionEvidenceKindSchema,
  // What was run, or what was read. Free text, because the shape of "how" differs per gate and pretending
  // otherwise would push every repository's checks through one schema that fits none of them.
  detail: z.string().max(2000).optional(),
  // WHICH gate runs support this answer (`GateRun.id`). Required by the domain for an `observed` answer: an
  // observation that names no measurement is an assertion wearing the other word.
  gateRunIds: z.array(z.string().min(1)).max(20).default([]),
};

export const ChangeJudgementAnswerSchema = z.discriminatedUnion("answer", [
  z.object({ answer: z.literal("met"), ...answerCommonShape }),
  z.object({ answer: z.literal("not_met"), reason: UnmetReasonSchema, ...answerCommonShape }),
  z.object({ answer: z.literal("not_run"), reason: UnmetReasonSchema, ...answerCommonShape }),
]);
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

// ── WHAT THE WORKER SAID, BESIDE WHAT THE SUPERVISOR DECIDED (DEFAUL-38) ─────────────────────────────
//
// A round performed by a delegated work agent has TWO verdicts in it, and collapsing them is the defect.
// `DelegateReportSchema` already reuses this file's vocabulary by explicit decision — "a report is a PROPOSED
// change round" — and the half that was missing is the join: nothing took a report, ran it past the brief it
// was given, and landed it as a round naming the delegation that produced it. So the supervisor read
// REPORT.json with their eyes and retyped the judgement, and the round could not say which worker produced it.
//
// ⚠️ THE REPORT IS NOT THE JUDGEMENT. `judgement.answers` stays the SUPERVISOR's, answered by the actor logging
// the round; what the delegate said lives here, alongside it. A delegate whose report became the round's
// judgement would be grading its own exam — and the difference is only visible if the two are different fields.
//
// ⚠️ `unanswered` IS A VALUE. "A report that skipped two of five criteria reads exactly like one that met
// three" (plugin/commands/delegate.md §8), and it reads that way because a skipped criterion is an ABSENCE —
// nothing to see unless you count. Here every declared criterion gets an arm, so the skip is a row.
export const DelegateCriterionEchoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answered"),
    criterionId: z.string().min(1),
    answer: CriterionAnswerSchema,
    how: CriterionEvidenceKindSchema,
    reason: UnmetReasonSchema.optional(),
    detail: z.string().max(2000).optional(),
  }),
  // The delegate did not answer this criterion at all. Not `not_run` — that is a delegate saying "I could not
  // run it"; this is a delegate that never said anything, which is a different thing to act on.
  z.object({ kind: z.literal("unanswered"), criterionId: z.string().min(1) }),
]);
export type DelegateCriterionEcho = z.infer<typeof DelegateCriterionEchoSchema>;

export const ChangeRoundDelegationSchema = z.object({
  // The sandbox session that produced this round's work — the `delegationRunId` the evolution grade already
  // carries on its own rounds. Recorded so "which worker, on which runtime, at what cost" is a lookup.
  runId: z.string().min(1).max(200),
  // The delegate's own summary, verbatim. A round that names a delegation and quotes nothing from it asks
  // every later reader to open a container that no longer exists.
  summary: z.string().min(1).max(8000),
  // One entry per criterion the CAMPAIGN declared, in declaration order.
  reported: z.array(DelegateCriterionEchoSchema).max(200),
  // Criterion ids the delegate answered that the campaign never declared. Usually a delegate answering an
  // older brief — which matters precisely because the answer LOOKS valid until someone checks the id.
  unknownCriteria: z.array(z.string().min(1)).max(200).default([]),
  // The ids the BRIEF asked about, so a reader can see whether the delegate was actually asked about what it
  // is being judged on. Read from the brief as it was AUTHORED, never re-parsed out of the rendered BRIEF.md.
  briefedOn: z.array(z.string().min(1)).max(200).default([]),
  // What it could not get past, in its own words — separate from a `not_met` reason because a blocker can stop
  // a delegate before it has an opinion about any criterion at all.
  blockers: z.array(z.string().max(1000)).max(20).default([]),
  // The ids of the questions it stopped on (`awaiting`). The TEXT stays on the session; what the round owes is
  // the fact that the work ended asking rather than finishing.
  questions: z.array(z.string().min(1).max(100)).max(20).default([]),
});
export type ChangeRoundDelegation = z.infer<typeof ChangeRoundDelegationSchema>;

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
  // WHO DID THE WORK, when it was not the agent that judged it. Absent = the judging agent did the work
  // itself, which is the ordinary case and reads as such.
  delegation: ChangeRoundDelegationSchema.optional(),
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
  // ── WHO WORKS THIS CAMPAIGN, DECLARED AT OPEN (DEFAUL-38) ──────────────────────────────────────────
  //
  // `{ required: true }` means every round of this campaign is performed by a delegated work agent, and a
  // round that names no delegation is REFUSED. `z.literal(true)` rather than a boolean on purpose: a `false`
  // and an absent field would be the same value wearing two spellings, and the thing that must not exist is a
  // per-round choice — "the delegate did this" decided after the fact is the annotation form of a protocol.
  // The evaluated grade says the same thing through its frame's delegation budget.
  delegation: z.object({ required: z.literal(true) }).optional(),
  rounds: z.array(ChangeRoundSchema).default([]),
  state: ChangeCampaignStateSchema,
  close: ChangeCampaignCloseSchema.optional(),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangeCampaignRecord = z.infer<typeof ChangeCampaignRecordSchema>;

// ── THE ACCOUNT A REQUEST IS OWED ────────────────────────────────────────────────────────────────────
//
// Derived from the criteria and the latest round's answers, never stored: a stored count is a second opinion
// about the same rounds, and two numbers about one thing means a reader has to decide which one lies. It is
// in the CONTRACTS because it crosses the wire — the campaign read returns it, and the web mirrors it.
export const RequirementBlockerSchema = z.object({
  criterionId: z.string().min(1),
  answer: z.enum(["not_met", "not_run"]),
  reason: UnmetReasonSchema,
});
export type RequirementBlocker = z.infer<typeof RequirementBlockerSchema>;

export const UnsettledRequirementSchema = z.object({
  issueId: z.string().min(1),
  criterionIds: z.array(z.string().min(1)),
  // EVERY blocker, not the first. Two criteria unmet for two different reasons is two different next
  // actions, and picking one of them to show is how the other disappears.
  blockers: z.array(RequirementBlockerSchema),
});
export type UnsettledRequirement = z.infer<typeof UnsettledRequirementSchema>;

export const RequirementRollupSchema = z.object({
  total: z.number().int().min(0),
  settled: z.number().int().min(0),
  unsettled: z.array(UnsettledRequirementSchema),
  // ⚠️ Criteria written before `judges` existed, counted apart and never as either kind. A non-zero here
  // tells the reader the count is INCOMPLETE, which is the whole difference between an unknown and a wrong
  // answer (protocol L2).
  unclassifiedCriteria: z.number().int().min(0),
});
export type RequirementRollup = z.infer<typeof RequirementRollupSchema>;

// What a campaign READ returns: the record plus the count it exists to support.
export const ChangeCampaignViewSchema = ChangeCampaignRecordSchema.extend({
  requirements: RequirementRollupSchema,
});
export type ChangeCampaignView = z.infer<typeof ChangeCampaignViewSchema>;

// ── WHAT A LIST ROW IS (DEFAUL-36) ───────────────────────────────────────────────────────────────────
//
// A ROW IS A SUMMARY. The list used to return the whole `ChangeCampaignView` per campaign, rounds included —
// every hypothesis, every change set, every gate run's metrics, every per-criterion answer with its detail
// prose, and every `learned`. Measured on 2026-09-18: nine campaigns, 85,793 characters over 1,905 lines,
// which exceeded the caller's output limit and had to be spilled to a file and read back with a script. That
// is the read that answers "what has this workspace been changing", so it is the one that must fit.
//
// `list_issues` has carried the lesson in its own description for as long as it has existed — "rows are
// SUMMARIES; the description, the full links and the move history live on get_issue" — and three sibling
// reads never learned it. This is one of them.
//
// ⚠️ A PROJECTION SAYS HOW MUCH IT WITHHELD. `rounds` becomes a count plus the latest round's verdict, not
// an omitted field: a campaign with four rejected attempts and one with none must not render alike, and the
// latest round IS the current standing (every round answers every criterion, so the newest answer set is a
// complete picture rather than a delta). Same law the knowledge assembly's `bodyChars` follows.
export const ChangeRoundDigestSchema = z.object({
  seq: z.number().int().min(1),
  outcome: z.enum(["adopted", "rejected"]),
  at: z.string(),
  by: z.string().min(1),
  // Who did the WORK, when it was not the agent that judged it. One string on a row, because "which of these
  // attempts were delegated" is a question a supervisor asks of the list, not of one campaign.
  delegationRunId: z.string().optional(),
});
export type ChangeRoundDigest = z.infer<typeof ChangeRoundDigestSchema>;

export const ChangeCampaignSummarySchema = ChangeCampaignRecordSchema.omit({
  rounds: true,
  criteria: true,
}).extend({
  // The account the request is owed — derived, small, and the whole reason a row is still worth reading.
  requirements: RequirementRollupSchema,
  // How many criteria were declared. The statements themselves are behind `get_change_campaign`.
  criteriaCount: z.number().int().min(0),
  rounds: z.object({
    total: z.number().int().min(0),
    // Absent means "opened, not attempted" — which is the truthful reading of a campaign with no rounds, and
    // is why this is optional rather than a zeroed object that reads like a round nobody judged.
    latest: ChangeRoundDigestSchema.optional(),
  }),
});
export type ChangeCampaignSummary = z.infer<typeof ChangeCampaignSummarySchema>;

// ── AND THE PAGE SAYS IT IS A PAGE ───────────────────────────────────────────────────────────────────
//
// `available` is how many there were, against how many came back. Without it a caller served 200 of 600
// cannot tell that from being served everything there was — a bounded read reporting "there is no more" when
// it means "I stopped" (rule `protocol` L2). The web was already compensating by inferring truncation from a
// full page (`rows.length >= WINDOW`), which is the caller rebuilding a fact the answer should have carried.
export const ChangeCampaignPageSchema = z.object({
  items: z.array(ChangeCampaignSummarySchema),
  available: z.number().int().min(0),
});
export type ChangeCampaignPage = z.infer<typeof ChangeCampaignPageSchema>;
