import { IssueLinkTypeSchema, IssuePrioritySchema, IssueStatusSchema, issueLinkDefects } from "@everdict/contracts";
import { z } from "zod";

// A link is a POINTER to an everdict object (unvalidated by design — the same semantics a platform event's
// subject has). Only resolution.scorecardId is checked, because that one is evidence.
export const IssueLinkInputSchema = z
  .object({
    type: IssueLinkTypeSchema,
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100).optional(),
    // `case` links only: the dataset the case id lives in (docs/architecture/evolution-routing-spec.md §3).
    dataset: z.string().min(1).max(200).optional(),
    // `commit` links only: "owner/name", and the Enterprise host when the forge is not github.com. Coordinates
    // are explicit here rather than a pasted URL, the same way link_github_issue takes a repository and a
    // number — decomposing an address is the SCREEN's affordance, and a door that accepted both shapes would
    // ask every future caller which one is the real one.
    repository: z.string().min(1).max(200).optional(),
    host: z.string().min(1).max(200).optional(),
    // `commit` links only: the commit's AUTHOR DATE — the order witness (DEFAUL-39 §3). Required by the
    // transition once the request is in the work chain; the door only checks it belongs to a commit link.
    committedAt: z.string().min(1).max(64).optional(),
    note: z.string().max(500).optional(),
  })
  // The coordinates rule at the door (the domain transition enforces it again — one owner, `issueLinkDefects`).
  .superRefine((link, ctx) => {
    for (const message of issueLinkDefects(link)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const CreateIssueBodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  // A member filing by hand usually starts in the backlog; `done` is refused here because closing an issue
  // records HOW it was evaluated (POST /issues/:id/status with a resolution).
  status: IssueStatusSchema.exclude(["done", "regressed"]).optional(),
  // How urgent, independent of where it sits in the workflow. Absent = `none`, which is a real answer.
  priority: IssuePrioritySchema.optional(),
  // Points on whatever scale the workspace reads them in — the value, never its rendering.
  estimate: z.number().int().nonnegative().max(1000).optional(),
  dueDate: CalendarDateSchema.optional(),
  // File this as a sub-issue of another. Accepts the id OR the identifier (`EVD-12`), like every other issue
  // reference; the parent must exist in this workspace.
  parentId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
  assignee: z.string().min(1).max(200).optional(),
  // Registry ids (GET /issue-labels), not names — a label is a record now, so an issue points at one.
  labelIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  links: z.array(IssueLinkInputSchema).max(50).optional(),
});
