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
    note: z.string().max(500).optional(),
  })
  // The coordinates rule at the door (the domain transition enforces it again — one owner, `issueLinkDefects`).
  .superRefine((link, ctx) => {
    for (const message of issueLinkDefects(link)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const CreateIssueBodySchema = z.object({
  // Absent = the workspace's default team. Teams give an issue an owner; making every caller name one would
  // just move that decision outward for no gain.
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  // A member filing by hand usually starts in the backlog; `done` is refused here because closing an issue
  // records HOW it was evaluated (POST /issues/:id/status with a resolution).
  status: IssueStatusSchema.exclude(["done", "regressed"]).optional(),
  // How urgent, independent of where it sits in the workflow. Absent = `none`, which is a real answer.
  priority: IssuePrioritySchema.optional(),
  // Points on the owning team's scale — the value, never its rendering.
  estimate: z.number().int().nonnegative().max(1000).optional(),
  dueDate: CalendarDateSchema.optional(),
  // File this as a sub-issue of another. Accepts the id OR the identifier (`ENG-12`), like every other issue
  // reference; the parent must exist in this workspace.
  parentId: z.string().min(1).max(200).optional(),
  // File it straight into an iteration. The service already validated this on create (it may only be one of the
  // owning team's cycles) — the body simply never offered it, so the only way to put a NEW issue in the current
  // cycle was to create it and then edit it.
  projectId: z.string().min(1).max(200).optional(),
  assignee: z.string().min(1).max(200).optional(),
  // Registry ids (GET /issue-labels), not names — a label is a record now, so an issue points at one.
  labelIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  links: z.array(IssueLinkInputSchema).max(50).optional(),
  // ── THE DOOR INTO TRIAGE (arch-review 106) ──────────────────────────────────────────────────────
  //
  // `Issue.create`'s own comment names who enters the queue: "the surfaces that bring work in from outside
  // (import, an agent) — never the default for a member filing". Neither surface had a door. Nothing in the
  // repository wrote `inTriage: true`, so the flag, both triage endpoints, both domain transitions, the store
  // filter and the `?triage=` list param were all reachable only in principle — a designed lifecycle with no
  // producer, which no gate can see because the field is required on the record with a legal default.
  //
  // Opt-in, so a member filing by hand is unaffected: absent still means "straight into the workflow".
});
