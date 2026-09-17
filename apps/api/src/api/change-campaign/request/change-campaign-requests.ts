import {
  ChangeCampaignCloseSchema,
  ChangeCriterionSchema,
  ChangeJudgementAnswerSchema,
  ChangeSetEntrySchema,
  GateRunSchema,
} from "@everdict/contracts";
import { z } from "zod";

// The `change` grade's request bodies. The criteria are declared HERE, at open — a campaign that could take
// them later would let the work choose the gate it is judged by.
export const OpenChangeCampaignBodySchema = z.object({
  issueId: z.string().min(1),
  service: z.object({ repository: z.string().min(1).max(200), path: z.string().max(200).optional() }),
  criteria: z.array(ChangeCriterionSchema).min(1).max(100),
  // The ENDED campaign this one continues — a request's attempts are a chain, one of them open at a time.
  continues: z.string().min(1).optional(),
});

// No `outcome`: the round's verdict is DERIVED from the answers. A body that could carry it would let a
// caller report "adopted" over an answer set that says otherwise.
export const LogChangeRoundBodySchema = z.object({
  hypothesis: z.string().min(1).max(2000),
  changes: z.array(ChangeSetEntrySchema).max(50),
  // What the repository's gates answered, with numbers. An `observed` answer must cite one of these.
  gateRuns: z.array(GateRunSchema).max(50).default([]),
  answers: z.array(ChangeJudgementAnswerSchema).max(200),
  checkpointId: z.string().min(1).optional(),
  learned: z.string().max(4000).optional(),
});

// `at` and `by` are stamped by the control plane, never supplied — the closer's identity is not the closer's
// to choose.
export const CloseChangeCampaignBodySchema = ChangeCampaignCloseSchema.omit({ at: true, by: true });
