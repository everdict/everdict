import { z } from "zod";
import { IssueStatusSchema } from "./tracker.js";

// WORKFLOW STATES — a team's own names for the positions in its workflow (docs/tracker.md). Linear lets each
// team define its states; this is that, with one deliberate difference which is the reason the rest of the
// tracker keeps working:
//
//   The CANONICAL vocabulary stays closed (`IssueStatus`), and a workflow state is a NAMED VIEW onto it.
//
// A team may rename "Todo" to "Up next", recolour it, reorder the board, or add "In QA" alongside "In review" —
// and every programmatic reader (the release gate, the rollups, the regression watch, the GitHub sync) keeps
// reading `status`, because each state declares which canonical status it IS. Letting teams mint arbitrary
// statuses would mean either teaching every one of those readers an open vocabulary, or inventing a category
// field that duplicates the status enum we already have. This way the customization is real where it is felt
// (names, colours, order, extra states) and impossible where it would silently break a release verdict.
//
// `regressed` is deliberately not offered as a state a team can add: an issue reaches it only by falling from a
// resolution (the regression watch), never by somebody dragging a card.

// The same closed colour vocabulary the labels use, for the same reason: a state chip has to stay legible in
// both themes, and nobody can author an off-theme (or invisible) one.
export const WORKFLOW_STATE_COLORS = [
  "gray",
  "purple",
  "blue",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
] as const;
export const WorkflowStateColorSchema = z.enum(WORKFLOW_STATE_COLORS);
export type WorkflowStateColor = z.infer<typeof WorkflowStateColorSchema>;

export const WorkflowStateRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  // Which canonical status this state IS. Two states may share one (a team with "In review" and "In QA" both
  // mapping to `in_review`), which is exactly the flexibility a team wants and the invariance every reader
  // needs. `done`/`cancelled` states exist too — closing still records its evidence, whatever the state is
  // called.
  status: IssueStatusSchema,
  color: WorkflowStateColorSchema,
  // Board order. A workflow is a sequence, so the position is meaning rather than a display preference.
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowStateRecord = z.infer<typeof WorkflowStateRecordSchema>;

// What every team starts with — Linear's default set, plus our `in_review`. Seeded on team creation so a team
// that never opens the settings screen still has a board, and so renaming one is editing a row rather than
// creating the concept.
export const DEFAULT_WORKFLOW_STATES: readonly {
  name: string;
  status: WorkflowStateRecord["status"];
  color: WorkflowStateColor;
}[] = [
  { name: "Backlog", status: "backlog", color: "gray" },
  { name: "Todo", status: "todo", color: "blue" },
  { name: "In progress", status: "in_progress", color: "yellow" },
  { name: "In review", status: "in_review", color: "purple" },
  { name: "Done", status: "done", color: "green" },
  { name: "Cancelled", status: "cancelled", color: "gray" },
];
