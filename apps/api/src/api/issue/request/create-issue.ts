import { IssueLinkTypeSchema, IssueStatusSchema } from "@everdict/contracts";
import { z } from "zod";

// A link is a POINTER to an everdict object (unvalidated by design — the same semantics a platform event's
// subject has). Only resolution.scorecardId is checked, because that one is evidence.
export const IssueLinkInputSchema = z.object({
  type: IssueLinkTypeSchema,
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
  note: z.string().max(500).optional(),
});

export const CreateIssueBodySchema = z.object({
  // Absent = the workspace's default team. Teams give an issue an owner; making every caller name one would
  // just move that decision outward for no gain.
  teamId: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  // A member filing by hand usually starts in the backlog; `done` is refused here because closing an issue
  // records HOW it was evaluated (POST /issues/:id/status with a resolution).
  status: IssueStatusSchema.exclude(["done", "regressed"]).optional(),
  projectId: z.string().min(1).max(200).optional(),
  assignee: z.string().min(1).max(200).optional(),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
  links: z.array(IssueLinkInputSchema).max(50).optional(),
});
