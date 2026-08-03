import { z } from "zod";

// Hand an issue to another team. Its own endpoint rather than a field on PATCH /issues/:id, for the same
// reason a status move has one: this is a TRANSITION — it re-mints the issue's identifier from the destination
// team's counter and emits `issue.moved` — and burying it in the content-edit body would let a rename carry a
// re-address as a side effect. The old identifier keeps resolving afterwards.
export const MoveIssueBodySchema = z.object({
  teamId: z.string().min(1).max(200),
});

// Triage: accept the issue INTO the team's workflow (where it lands is the caller's call — `todo` by default),
// or decline it, which cancels it with a reason. Both are lifecycle moves, so they get endpoints rather than a
// flag on the content edit: the history has to be able to answer "when did this stop being a request".
export const AcceptTriageBodySchema = z.object({
  status: z.enum(["backlog", "todo", "in_progress", "in_review"]).default("todo"),
});

export const DeclineTriageBodySchema = z.object({
  note: z.string().max(2000).optional(),
});
