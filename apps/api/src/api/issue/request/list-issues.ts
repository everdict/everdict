import {
  IssueGroupBySchema,
  IssueLinkTypeSchema,
  IssueOrderSchema,
  IssuePrioritySchema,
  IssueStatusSchema,
} from "@everdict/contracts";
import { z } from "zod";

// The issue LIST's query — shared by `GET /issues` (the rows) and `GET /issues/counts` (how many are in each
// group). One schema for both, because a grouped screen draws them together: headers from the counts, rows
// from the pages, and a filter that applied to only one of the two would show a count the list contradicts.

// A facet is a SET, and a query string spells a set by repeating the key (`?status=todo&status=in_progress`).
// Fastify hands us a bare value for one and an array for several, so both spellings collapse here rather than
// at each call site.
function repeatable<T extends z.ZodType<string>>(item: T) {
  return z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).optional(),
  );
}

// The unset bucket is spelled as the EMPTY string (`?assignee=`), so these deliberately do not require a
// non-empty value: "unassigned" is a group members filter to, and a query parameter has no null to offer.
const optionalRef = z.string().max(200);

export const ListIssuesQuerySchema = z.object({
  status: repeatable(IssueStatusSchema),
  // One team, or every team the caller belongs to. `mine` resolves through the roster rather than trusting a
  // client-supplied id list.
  team: z.string().min(1).optional(),
  mine: z.enum(["true", "false"]).optional(),
  project: repeatable(optionalRef),
  assignee: repeatable(optionalRef),
  priority: repeatable(IssuePrioritySchema),
  cycle: repeatable(optionalRef),
  // Labels are ids into the workspace registry; an issue matches when it carries ANY of them.
  label: repeatable(z.string().min(1).max(200)),
  // One parent's sub-issues, or `none` for the TOP-LEVEL issues — what a board shows so a child never appears
  // twice, once on its own and once under its parent.
  parent: z.string().min(1).optional(),
  triage: z.enum(["true", "false"]).optional(),
  // "Which issues watch this harness" — the capability detail pages' reverse lookup.
  linkType: IssueLinkTypeSchema.optional(),
  linkId: z.string().min(1).optional(),
  // Free-text search over identifier + title — what every "which issue do you mean" picker asks. Server-side
  // because the alternative is loading a window and filtering it in the client, which quietly stops finding
  // issues once the workspace outgrows the window.
  q: z.string().min(1).max(200).optional(),
  // The bulk GitHub sync's working set. Exposed because the alternative a caller is left with is reading the
  // whole list and filtering client-side, which is what the issues page used to do.
  syncPull: z.enum(["true", "false"]).optional(),
});

export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

// The PAGE's own two parameters. Separate from the filter because the counts endpoint has neither: an
// aggregate is not paginated, and it has no ordering to speak of.
export const IssuePageQuerySchema = ListIssuesQuerySchema.extend({
  order: IssueOrderSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).optional(), // opaque token from a prior page's nextCursor
});

export const IssueCountsQuerySchema = ListIssuesQuerySchema.extend({
  groupBy: IssueGroupBySchema,
});

// Query → store filter. The team ref and the visible-team narrowing are resolved by the route (they need the
// team service), so they arrive already decided; everything else is a straight mapping kept in ONE place so
// the rows and the counts can never be narrowed differently.
export function issueFilterOf(
  query: ListIssuesQuery,
  scope: { teamId?: string; teamIds?: string[] },
): {
  statuses?: z.infer<typeof IssueStatusSchema>[];
  teamId?: string;
  teamIds?: string[];
  projectIds?: string[];
  assignees?: string[];
  priorities?: z.infer<typeof IssuePrioritySchema>[];
  cycleIds?: string[];
  labelIds?: string[];
  parentId?: string | null;
  inTriage?: boolean;
  link?: { type: z.infer<typeof IssueLinkTypeSchema>; id: string };
  query?: string;
  syncPull?: boolean;
} {
  return {
    ...(query.status !== undefined ? { statuses: query.status } : {}),
    ...(scope.teamId !== undefined ? { teamId: scope.teamId } : {}),
    ...(scope.teamIds !== undefined ? { teamIds: scope.teamIds } : {}),
    ...(query.project !== undefined ? { projectIds: query.project } : {}),
    ...(query.assignee !== undefined ? { assignees: query.assignee } : {}),
    ...(query.priority !== undefined ? { priorities: query.priority } : {}),
    ...(query.cycle !== undefined ? { cycleIds: query.cycle } : {}),
    ...(query.label !== undefined ? { labelIds: query.label } : {}),
    // `none` is the top-level selector; every other value is a parent id.
    ...(query.parent !== undefined ? { parentId: query.parent === "none" ? null : query.parent } : {}),
    ...(query.triage !== undefined ? { inTriage: query.triage === "true" } : {}),
    ...(query.linkType !== undefined && query.linkId !== undefined
      ? { link: { type: query.linkType, id: query.linkId } }
      : {}),
    ...(query.q !== undefined ? { query: query.q } : {}),
    ...(query.syncPull === "true" ? { syncPull: true } : {}),
  };
}
