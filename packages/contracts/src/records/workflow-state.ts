import { z } from "zod";
import { IssueStatusSchema } from "./tracker.js";

// WORKFLOW STATES — a workspace's own names for the positions in its workflow (docs/tracker.md). Linear lets each
// team define its states; this keeps the shape, per workspace, with one deliberate difference which is the reason
// the rest of the tracker keeps working:
//
//   The CANONICAL vocabulary stays closed (`IssueStatus`), and a workflow state is a NAMED VIEW onto it.
//
// Every programmatic reader (the release gate, the rollups, the regression watch, the GitHub sync) reads
// `status`, because each state declares which canonical status it IS — so what a column is called cannot reach a
// release verdict. The board is read-only today: a workspace uses the seeded default set below, and columns a
// workspace added while an editor existed ("In QA" beside "In review") stay readable.
//
// `regressed` is deliberately not a column: an issue reaches it only by falling from a resolution (the regression
// watch), never by somebody dragging a card.

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
  // Which canonical status this state IS. Two states may share one (a board with "In review" and "In QA" both
  // mapping to `in_review`), which is exactly the flexibility a workspace wants and the invariance every reader
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

// What every workspace starts with — Linear's default set, plus our `in_review`. Seeded on the first read, so every
// workspace has a board without anybody creating one.
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
