import type { IssueListFilter } from "@everdict/application-control";
import {
  IssueGroupBySchema,
  IssueLinkTypeSchema,
  IssueOrderSchema,
  IssuePrioritySchema,
  IssueStatusSchema,
} from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the issue routes (BFF↔MCP parity). This is the surface an agent uses to triage its own
// regressions: find the issue that watches a harness, read how it was closed last time, and move it.
// ctx.agent rides into the service so an agent's transitions stamp causedBy — the trigger loop guard.
export function registerIssueTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.issueService) return;
  const issues = deps.issueService;
  const agent = ctx.agent?.agentId
    ? {
        agentId: ctx.agent.agentId,
        ...(ctx.agent.conversationId !== undefined ? { conversationId: ctx.agent.conversationId } : {}),
      }
    : undefined;
  const actor = { subject: principal.subject, ...(agent ? { agent } : {}) };

  server.registerTool(
    "create_issue",
    {
      annotations: { readOnlyHint: false },
      description:
        "File an issue on the eval tracker — the record of WHAT problem is under evaluation and why. Link the " +
        "harnesses/datasets/judges that verify it so the issue accumulates its own evaluation history. Use this " +
        "when you find a defect worth tracking across runs, not for one-off notes.",
      inputSchema: {
        title: z.string().min(1).max(300),
        team: z
          .string()
          .optional()
          .describe(
            'the team whose list it lands on — id or key ("ENG"); the identifier is minted from that team\'s counter. Absent: the workspace default team',
          ),
        description: z.string().max(50_000).optional(),
        status: IssueStatusSchema.exclude(["done", "regressed"]).optional(),
        priority: IssuePrioritySchema.optional().describe(
          "urgent | high | medium | low | none (default) — urgency, independent of the workflow status",
        ),
        estimate: z.number().int().nonnegative().max(1000).optional().describe("points on the team's scale"),
        dueDate: z.string().optional().describe("YYYY-MM-DD — when this issue is due"),
        parentId: z.string().optional().describe("file it as a sub-issue of this issue (id or identifier)"),
        projectId: z
          .string()
          .optional()
          .describe("the project this issue belongs to — one of the issue team's projects (list_projects?team=)"),
        assignee: z.string().optional(),
        labelIds: z.array(z.string()).max(50).optional(),
        links: z
          .array(
            z.object({
              type: IssueLinkTypeSchema,
              id: z.string(),
              version: z.string().optional(),
              note: z.string().max(500).optional(),
            }),
          )
          .max(50)
          .optional()
          .describe("capabilities that verify this issue (harness/dataset/judge/scorecard/run/view)"),
        // `Issue.create`'s comment names an agent as one of the two surfaces that files INTO triage; until
        // arch-review 106 neither surface had a door, so nothing in the repository ever set this and the whole
        // triage lifecycle was unreachable. An agent filing work for a human to admit is the point of the queue.
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await issues.create({
            tenant: ws,
            createdBy: principal.subject,
            // Resolved here (id or key) so an unknown team is a 404 rather than an issue quietly filed under
            // the default one.
            title: a.title,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.status !== undefined ? { status: a.status } : {}),
            ...(a.priority !== undefined ? { priority: a.priority } : {}),
            ...(a.estimate !== undefined ? { estimate: a.estimate } : {}),
            ...(a.dueDate !== undefined ? { dueDate: a.dueDate } : {}),
            ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
            ...(a.projectId !== undefined ? { projectId: a.projectId } : {}),
            ...(a.assignee !== undefined ? { assignee: a.assignee } : {}),
            ...(a.labelIds !== undefined ? { labelIds: a.labelIds } : {}),
            ...(a.links !== undefined ? { links: a.links } : {}),
            ...(agent ? { agent } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_issues",
    {
      annotations: { readOnlyHint: true },
      description:
        "One PAGE of the workspace's issues: `{ items, nextCursor? }` — pass `nextCursor` back as `cursor` for " +
        "the next page (absent = last page). Rows are SUMMARIES (identifier, title, status, labels, link count, " +
        "assignee); the description, the full links and the move history live on get_issue. `order` picks the " +
        "sequence (updated [default] | created | priority | due) and the cursor belongs to it — reusing a token " +
        "under a different order is refused rather than served as a meaningless window. status, priority, " +
        "project, assignee, cycle and label take an ARRAY to mean 'any of these', and AND across facets; the " +
        'empty string reaches the unset bucket (assignee: [""] = unassigned). `linkType` + `linkId` answers ' +
        "'which issues watch this harness/dataset', the lookup to run before investigating a failing batch, and " +
        "`q` searches the identifier + title when you know what the issue is CALLED but not its id. " +
        "`parent` takes an issue id for its sub-issues, or the literal `none` for the top-level issues only.",
      inputSchema: {
        status: z.array(IssueStatusSchema).optional(),
        team: z.string().optional().describe('only this team\'s issues — id or key ("ENG")'),
        project: z.array(z.string()).optional(),
        assignee: z.array(z.string()).optional().describe('issue assignees; "" selects the unassigned ones'),
        priority: z.array(IssuePrioritySchema).optional(),
        cycle: z.array(z.string()).optional(),
        label: z.array(z.string()).optional().describe("label ids; an issue matches when it carries ANY of them"),
        parent: z.string().optional().describe("an issue id for its sub-issues, or `none` for top-level only"),
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().optional(),
        q: z.string().optional().describe("free-text search over identifier + title (the issue's own name)"),
        order: IssueOrderSchema.optional().describe("updated (default) | created | priority | due"),
        limit: z.number().int().positive().max(200).optional().describe("page size (default 50, max 200)"),
        cursor: z.string().optional().describe("page token from a prior page's nextCursor (next page)"),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await issues.listSummaries(ws, {
            ...issueFilterOfArgs(a),
            // A private team's issues are not the workspace's — the same narrowing the HTTP list applies. An
            // agent reading through this tool must not see what the person it acts for cannot.
            // `team` is the NARROW on top of that ceiling (the HTTP list's `?team=`): naming a team you cannot
            // see returns nothing rather than that team's issues.
            ...(a.order !== undefined ? { order: a.order } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
            ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "count_issues",
    {
      annotations: { readOnlyHint: true },
      description:
        "How many issues fall in each group under the same filter list_issues takes — 'how much unstarted work " +
        "does each member hold', 'how big is each status column'. `groupBy` is status | assignee | priority | " +
        "project | cycle. Groups come back largest-first with the unset bucket last (`key: null`). Use this " +
        "instead of paging the whole list to count it: the answer is one aggregate, and it stays correct past " +
        "the page limit.",
      inputSchema: {
        groupBy: IssueGroupBySchema,
        status: z.array(IssueStatusSchema).optional(),
        project: z.array(z.string()).optional(),
        assignee: z.array(z.string()).optional(),
        priority: z.array(IssuePrioritySchema).optional(),
        cycle: z.array(z.string()).optional(),
        label: z.array(z.string()).optional(),
        parent: z.string().optional(),
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().optional(),
        q: z.string().optional().describe("free-text search over identifier + title (the issue's own name)"),
      },
    },
    (a) =>
      run(principal, "issues:read", async () => {
        const groups = await issues.countByGroup(ws, a.groupBy, {
          ...issueFilterOfArgs(a),
        });
        return ok({ groupBy: a.groupBy, groups, total: groups.reduce((sum, group) => sum + group.count, 0) });
      }),
  );

  server.registerTool(
    "get_issue",
    {
      annotations: { readOnlyHint: true },
      description:
        "One issue in full — its links, how it was resolved (including the scorecard that proved it), its " +
        "GitHub copy, and the durable history of every move. Read this before re-investigating something the " +
        "team already closed.",
      inputSchema: { id: z.string().describe("issue id, or the identifier a member would name it by (ENG-12)") },
    },
    (a) =>
      run(principal, "issues:read", async () => {
        const issue = await issues.get(ws, a.id);
        // Same answer the HTTP read gives: an issue you may not see is ABSENT, not forbidden.
        return ok(issue);
      }),
  );

  server.registerTool(
    "update_issue",
    {
      annotations: { readOnlyHint: false },
      description:
        "Edit an issue's content (title, description, labels, assignee, project, milestone, cycle, priority, " +
        "estimate, due date, parent). Status moves use set_issue_status instead, and team moves use " +
        "move_issue. Pass null to clear assignee/projectId/milestoneId/cycleId/description/estimate/dueDate/" +
        "parentId. Pulling an issue into an iteration is a plan change, not a transition, so it rides this " +
        "edit — and only into one of the issue's OWN team's cycles; a milestone likewise has to be one of the " +
        "issue's own project's checkpoints. Re-parenting an issue under one of its own sub-issues is refused " +
        "— that would close the loop.",
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        labelIds: z.array(z.string()).max(50).optional(),
        assignee: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
        milestoneId: z
          .string()
          .nullable()
          .optional()
          .describe("a checkpoint on the issue's own project; null detaches it"),
        priority: IssuePrioritySchema.optional(),
        estimate: z.number().int().nonnegative().max(1000).nullable().optional(),
        dueDate: z.string().nullable().optional(),
        parentId: z.string().nullable().optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        const { id, ...fields } = a;
        return ok(await issues.update(ws, id, fields, actor));
      }),
  );

  server.registerTool(
    "set_issue_status",
    {
      annotations: { readOnlyHint: false },
      description:
        "Move an issue through the workflow — say where it should end up and the control plane picks the right " +
        "transition. Closing (status=done) REQUIRES saying how it was evaluated: pass resolution.scorecardId " +
        "with the batch that proved it, which becomes the baseline a later regression is measured against. " +
        "Reopening a done issue with status=regressed is how a fallen resolution is recorded. An illegal move " +
        "(e.g. resolving an already-closed issue) is rejected — read the issue first.",
      inputSchema: {
        id: z.string(),
        status: IssueStatusSchema,
        resolution: z
          .object({ scorecardId: z.string().optional(), note: z.string().max(2000).optional() })
          .optional()
          .describe("required when closing — the evidence the issue is fixed"),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await issues.setStatus(
            ws,
            a.id,
            { status: a.status, ...(a.resolution !== undefined ? { resolution: a.resolution } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "add_issue_link",
    {
      annotations: { readOnlyHint: false },
      description:
        "Attach a capability (harness/dataset/judge/scorecard/run/view) or a CASE to an issue. Dataset and harness " +
        "links widen the issue's evaluation history to every batch that exercised them, which is how a regression " +
        "against a closed issue surfaces. A `case` link (linkId = the case id, `dataset` + `version` = the dataset " +
        "version it lives in) says which cases the issue is about; a campaign opened with frame.fromIssue takes " +
        "them as its targets and adopts only when every one of them flipped.",
      inputSchema: {
        id: z.string(),
        type: IssueLinkTypeSchema,
        linkId: z.string(),
        version: z.string().optional(),
        dataset: z.string().optional().describe("case links only — the dataset the case id lives in"),
        note: z.string().max(500).optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await issues.link(
            ws,
            a.id,
            {
              type: a.type,
              id: a.linkId,
              ...(a.version !== undefined ? { version: a.version } : {}),
              ...(a.dataset !== undefined ? { dataset: a.dataset } : {}),
              ...(a.note !== undefined ? { note: a.note } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "remove_issue_link",
    {
      annotations: { readOnlyHint: false },
      description: "Detach a capability from an issue.",
      inputSchema: { id: z.string(), type: IssueLinkTypeSchema, linkId: z.string() },
    },
    (a) => run(principal, "issues:write", async () => ok(await issues.unlink(ws, a.id, a.type, a.linkId, actor))),
  );

  server.registerTool(
    "list_issue_scorecards",
    {
      annotations: { readOnlyHint: true },
      description:
        "The issue's evaluation history: the scorecards pinned to it as evidence UNION every batch its linked " +
        "datasets/harnesses ran, newest first. Compare the latest against the resolution scorecard to judge " +
        "whether a closed issue has regressed.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "scorecards:read", async () => ok(await issues.evaluationHistory(ws, a.id))),
  );

  server.registerTool(
    "delete_issue",
    {
      annotations: { readOnlyHint: false },
      description: "Delete an issue. Creator or workspace admin only.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await issues.remove(ws, a.id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: a.id });
      }),
  );
}

// The narrowing `list_issues` and `count_issues` share, so the rows an agent reads and the totals it reports
// can never come from two different filters. The HTTP twin has `request/list-issues.ts` doing the same job for
// query strings; here the arguments are already typed, so only the mapping is left.
function issueFilterOfArgs(a: {
  status?: IssueListFilter["statuses"];
  project?: string[];
  assignee?: string[];
  priority?: IssueListFilter["priorities"];
  cycle?: string[];
  label?: string[];
  parent?: string;
  linkType?: IssueListFilter["link"] extends infer L ? (L extends { type: infer T } ? T : never) : never;
  linkId?: string;
  q?: string;
}): IssueListFilter {
  return {
    ...(a.status !== undefined ? { statuses: a.status } : {}),
    ...(a.project !== undefined ? { projectIds: a.project } : {}),
    ...(a.assignee !== undefined ? { assignees: a.assignee } : {}),
    ...(a.priority !== undefined ? { priorities: a.priority } : {}),
    ...(a.label !== undefined ? { labelIds: a.label } : {}),
    ...(a.parent !== undefined ? { parentId: a.parent === "none" ? null : a.parent } : {}),
    ...(a.linkType !== undefined && a.linkId !== undefined ? { link: { type: a.linkType, id: a.linkId } } : {}),
    ...(a.q !== undefined ? { query: a.q } : {}),
  };
}
