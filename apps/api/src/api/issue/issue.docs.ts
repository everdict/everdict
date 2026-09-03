import {
  IssueGroupBySchema,
  IssueGroupCountsSchema,
  IssueLinkTypeSchema,
  IssueOrderSchema,
  IssuePageSchema,
  IssuePrioritySchema,
  IssueRecordSchema,
  IssueStatusSchema,
} from "@everdict/contracts";
import { IssueScorecardsResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateIssueBodySchema, IssueLinkInputSchema } from "./request/create-issue.js";
import { SetIssueStatusBodySchema } from "./request/set-issue-status.js";
import { UpdateIssueBodySchema } from "./request/update-issue.js";

// OpenAPI descriptors for the eval tracker's issues (doc-only — never validates/serializes; see api/openapi.ts).
// An issue is the unit of intent: what problem we are evaluating, which capabilities verify it, how it was
// closed, and why it came back. Authz: read = issues:read (viewer+), write = issues:write (member+); delete
// additionally creator-or-admin. Facts issue.created / issue.status_changed / issue.linked feed the event log;
// the first two are trigger-matchable (payload.cause distinguishes a regression from a member's move).
export const issueDocs: Record<
  "create" | "list" | "counts" | "get" | "update" | "setStatus" | "link" | "unlink" | "scorecards" | "delete",
  FastifySchema
> = {
  create: {
    summary: "File an issue on the eval tracker",
    description:
      "Record what problem is under evaluation. Links attach the harnesses/datasets/judges/scorecards that " +
      "verify it. Emits the trigger-matchable issue.created fact; an agent-filed issue stamps causedBy so the " +
      "creator never wakes on its own issue. Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(CreateIssueBodySchema),
    response: {
      201: { description: "The filed issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  list: {
    summary: "List the workspace's issues",
    description:
      "One PAGE of the workspace's issues: `{ items, nextCursor? }` — pass nextCursor back as `cursor` for the " +
      "next page (absent = last page). Rows are SUMMARIES: the description, the full link list and the move " +
      "history are on GET /issues/:id, because a list row draws none of them. `order` picks the sequence " +
      "(updated [default] | created | priority | due); the cursor is minted UNDER that ordering, so reusing a " +
      "token with a different `order` is a 400 rather than a meaningless window. status, priority, project, " +
      "assignee, cycle and label are SETS — repeat the key to name several (`?status=todo&status=in_progress`), " +
      "and they AND across facets; an empty value reaches the unset bucket (`?assignee=` = unassigned). Also " +
      "filter by team (or mine=true for every team you belong to), syncPull (the GitHub bulk sync's working " +
      "set), parent (an issue id for its sub-issues, `none` for the top-level ones), or by the capability an " +
      "issue links (linkType + linkId — 'which issues watch this harness'), or search by name (`q` — a " +
      "case-insensitive substring of the identifier or title, what every issue picker asks). Requires issues:read.",
    tags: ["issue"],
    querystring: toJsonSchema(
      z.object({
        status: z.union([IssueStatusSchema, z.array(IssueStatusSchema)]).optional(),
        team: z.string().optional(),
        mine: z.enum(["true", "false"]).optional(),
        project: z.union([z.string(), z.array(z.string())]).optional(),
        assignee: z.union([z.string(), z.array(z.string())]).optional(),
        priority: z.union([IssuePrioritySchema, z.array(IssuePrioritySchema)]).optional(),
        cycle: z.union([z.string(), z.array(z.string())]).optional(),
        label: z.union([z.string(), z.array(z.string())]).optional(),
        parent: z.string().optional(),
        triage: z.enum(["true", "false"]).optional(),
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().optional(),
        q: z.string().min(1).max(200).optional(),
        syncPull: z.enum(["true", "false"]).optional(),
        order: IssueOrderSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        cursor: z.string().optional(),
      }),
    ),
    response: {
      200: { description: "One page of issue summaries", ...toJsonSchema(IssuePageSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  counts: {
    summary: "Count the workspace's issues per group",
    description:
      "How many issues fall in each group under the SAME filter GET /issues takes — the headers of a grouped " +
      "board. `groupBy` is status | assignee | priority | project | cycle, all scalar columns, so every issue " +
      "counts exactly once. Groups come back largest-first with the UNSET bucket last and `key: null` " +
      "(unassigned, no project, no cycle). A grouped screen holds one PAGE per group, so it cannot get these " +
      "numbers from its own rows — counting what it received would only report the page size. Requires " +
      "issues:read.",
    tags: ["issue"],
    querystring: toJsonSchema(
      z.object({
        groupBy: IssueGroupBySchema,
        status: z.union([IssueStatusSchema, z.array(IssueStatusSchema)]).optional(),
        team: z.string().optional(),
        mine: z.enum(["true", "false"]).optional(),
        project: z.union([z.string(), z.array(z.string())]).optional(),
        assignee: z.union([z.string(), z.array(z.string())]).optional(),
        priority: z.union([IssuePrioritySchema, z.array(IssuePrioritySchema)]).optional(),
        cycle: z.union([z.string(), z.array(z.string())]).optional(),
        label: z.union([z.string(), z.array(z.string())]).optional(),
        parent: z.string().optional(),
        triage: z.enum(["true", "false"]).optional(),
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().optional(),
        q: z.string().min(1).max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Issue counts per group, largest first", ...toJsonSchema(IssueGroupCountsSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  get: {
    summary: "Get an issue",
    description:
      "One issue with its links, resolution, GitHub copy and durable history. `:id` is the issue id OR the " +
      "identifier its team minted (`ENG-12`, case-insensitive) — the same name the web URL uses, so a pasted " +
      "link resolves. Another workspace's id returns 404 (no existence leak). Requires issues:read.",
    tags: ["issue"],
    response: {
      200: { description: "The issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Edit an issue's content",
    description:
      "Title, description, labels, assignee, project, milestone, cycle, priority, estimate, due date, parent. " +
      "Status moves go through POST /issues/:id/status and team moves through POST /issues/:id/team, so " +
      "neither is ever a side effect of a rename — but joining an iteration is a plan change, so cycleId rides " +
      "this edit (the issue's own team's cycles only), as does milestoneId (its own project's checkpoints " +
      "only). null clears an optional field; re-parenting an issue under one of its own sub-issues is a 409. " +
      "Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(UpdateIssueBodySchema),
    response: {
      200: { description: "The updated issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setStatus: {
    summary: "Move an issue through the workflow",
    description:
      "Say where the issue should end up; the control plane picks the transition that fits its current state " +
      "(move / resolve / reopen). Closing requires a resolution — the scorecard that proved it, validated " +
      "against this workspace — which also becomes the baseline a later regression is measured against. " +
      "Reopening a done issue as `regressed` is how a fallen resolution is recorded. An illegal move is a 409. " +
      "Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(SetIssueStatusBodySchema),
    response: {
      200: { description: "The moved issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  link: {
    summary: "Link a capability to an issue",
    description:
      "Attach a harness, dataset, judge, scorecard, run, view — or a case (`type: case`, `id` = the case id, " +
      "`dataset` + `version` = the dataset version it lives in; a campaign opened with frame.fromIssue takes the " +
      "issue's cases as its targets). Links are pointers (resolved through the normal RBAC-gated reads), and the " +
      "dataset/harness ones widen the issue's evaluation history. Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(IssueLinkInputSchema),
    response: {
      200: { description: "The issue with the new link", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  unlink: {
    summary: "Remove a link from an issue",
    description: "Detach a capability from the issue. Requires issues:write.",
    tags: ["issue"],
    response: {
      200: { description: "The issue without the link", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  scorecards: {
    summary: "The issue's evaluation history",
    description:
      "The scorecards pinned to the issue as evidence UNION every batch its linked datasets/harnesses ran, " +
      "newest first — how the problem was verified over time, and where a regression against a closed issue " +
      "shows up. Requires scorecards:read.",
    tags: ["issue"],
    response: {
      200: { description: "Scorecards, newest first", ...toJsonSchema(IssueScorecardsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  delete: {
    summary: "Delete an issue",
    description: "Hard delete. Creator or workspace admin only (enforced in the service). Requires issues:write.",
    tags: ["issue"],
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404) },
  },
};
