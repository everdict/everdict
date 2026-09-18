import {
  ChangeCampaignCloseSchema,
  ChangeCriterionSchema,
  ChangeJudgementAnswerSchema,
  ChangeSetEntrySchema,
  GateRunSchema,
} from "@everdict/contracts";
import { z } from "zod";

// NOTHING NEW IS BORN UNCLASSIFIED. The record schema carries a third `judges.kind` for criteria written
// before the distinction existed — "we cannot know what this judged" is a real answer about history and a
// forbidden one about a campaign being opened right now. So the DOOR accepts only the two kinds an author can
// actually choose between, and the migration value stays reachable from storage alone.
export const DeclarableCriterionSchema = ChangeCriterionSchema.extend({
  judges: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("requirement"), issueId: z.string().min(1) }),
    z.object({ kind: z.literal("quality") }),
  ]),
});

// The `change` grade's request bodies. The criteria are declared HERE, at open — a campaign that could take
// them later would let the work choose the gate it is judged by.
export const OpenChangeCampaignBodySchema = z.object({
  issueId: z.string().min(1),
  service: z.object({ repository: z.string().min(1).max(200), path: z.string().max(200).optional() }),
  criteria: z.array(DeclarableCriterionSchema).min(1).max(100),
  // The ENDED campaign this one continues — a request's attempts are a chain, one of them open at a time.
  continues: z.string().min(1).optional(),
  // Every round of this campaign is performed by a delegated work agent (DEFAUL-38). `{required: true}` is the
  // only value: a `false` would be a second spelling of "absent", and what must not exist is a per-round
  // choice — "the delegate did this", decided after the work, is an annotation nobody checks.
  delegation: z.object({ required: z.literal(true) }).optional(),
});

// No `outcome`: the round's verdict is DERIVED from the answers. A body that could carry it would let a
// caller report "adopted" over an answer set that says otherwise.
export const LogChangeRoundBodySchema = z.object({
  hypothesis: z.string().min(1).max(2000),
  // Absent on a DELEGATED round: the change set comes from the delegate's report, read from the session that
  // produced it. A supervisor retyping the commits is the re-derivation that turns a record into a summary.
  changes: z.array(ChangeSetEntrySchema).max(50).default([]),
  // What the repository's gates answered, with numbers. An `observed` answer must cite one of these.
  gateRuns: z.array(GateRunSchema).max(50).default([]),
  // ⚠️ THE ANSWERS ARE ALWAYS THE CALLER'S, delegated round or not. A delegate whose report became the
  // judgement would be grading its own exam; what it said is recorded beside this, joined by criterion id.
  answers: z.array(ChangeJudgementAnswerSchema).max(200),
  checkpointId: z.string().min(1).optional(),
  learned: z.string().max(4000).optional(),
  // The sandbox session whose delegate did this round's work. The service READS that session's brief and
  // report; it is a POINTER, never a copy.
  delegationRunId: z.string().min(1).max(200).optional(),
});

// `at` and `by` are stamped by the control plane, never supplied — the closer's identity is not the closer's
// to choose.
export const CloseChangeCampaignBodySchema = ChangeCampaignCloseSchema.omit({ at: true, by: true });
