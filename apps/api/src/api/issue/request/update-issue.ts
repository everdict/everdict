import { IssuePrioritySchema } from "@everdict/contracts";
import { z } from "zod";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Content editing only — status moves go through POST /issues/:id/status so a transition can never be a silent
// side effect of a rename. `null` clears an optional field (unassign, detach from a project).
export const UpdateIssueBodySchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(50_000).nullable().optional(),
    // Whole-array replacement of the issue's labels, by registry id (GET /issue-labels).
    labelIds: z.array(z.string().min(1).max(200)).max(50).optional(),
    assignee: z.string().min(1).max(200).nullable().optional(),
    projectId: z.string().min(1).max(200).nullable().optional(),
    priority: IssuePrioritySchema.optional(),
    // Pulling an issue into an iteration — or out of one (`null`) — is a plan change rather than a workflow
    // transition, so it rides the ordinary edit (docs/tracker.md). The body simply never offered it, so every
    // surface that puts work in a cycle sent a key this schema stripped: a cycle-only edit came back 400
    // "Nothing to update.", and one bundled with another field answered 200 having changed nothing. The service
    // checks the cycle is the issue's OWN team's, which is why the value has to reach it verbatim.
    cycleId: z.string().min(1).max(200).nullable().optional(),
    // The project checkpoint, and the same omission one level up: the project screen has counted the issues on
    // each milestone since it existed, and no transport ever accepted the field that would make one of those
    // counts non-zero. Only the EDIT path offers it, because only the edit path validates it — the service
    // checks the milestone is on whichever project the issue ends up in, which is also why a project change in
    // the same request re-checks it (and clears a stale one when the project moves alone).
    milestoneId: z.string().min(1).max(200).nullable().optional(),
    // `null` clears them: no estimate, no due date, no parent (the issue becomes top-level again). Re-parenting
    // under one of its own sub-issues is refused with a 409 — that would close the loop.
    estimate: z.number().int().nonnegative().max(1000).nullable().optional(),
    dueDate: CalendarDateSchema.nullable().optional(),
    parentId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
