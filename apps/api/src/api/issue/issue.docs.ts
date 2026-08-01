import { IssueLinkTypeSchema, IssueRecordSchema, IssueStatusSchema } from "@everdict/contracts";
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
  "create" | "list" | "get" | "update" | "setStatus" | "link" | "unlink" | "scorecards" | "delete",
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
      "The workspace's issues, newest activity first. Filter by status, project, assignee, or by the capability " +
      "an issue links (linkType + linkId — 'which issues watch this harness'). Requires issues:read.",
    tags: ["issue"],
    querystring: toJsonSchema(
      z.object({
        status: IssueStatusSchema.optional(),
        project: z.string().optional(),
        assignee: z.string().optional(),
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Issues, newest activity first", ...toJsonSchema(z.array(IssueRecordSchema)) },
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
      "Title, description, labels, assignee, project. Status moves go through POST /issues/:id/status so a " +
      "transition is never a side effect of a rename. null clears an optional field. Requires issues:write.",
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
      "Attach a harness, dataset, judge, scorecard, run or view. Links are pointers (resolved through the " +
      "normal RBAC-gated reads), and the dataset/harness ones widen the issue's evaluation history. Requires issues:write.",
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
