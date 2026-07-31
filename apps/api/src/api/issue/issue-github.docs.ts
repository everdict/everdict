import { IssueRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import {
  ImportGithubIssuesBodySchema,
  IssueGithubSyncBodySchema,
  PullGithubIssuesBodySchema,
} from "./request/import-github-issues.js";

// OpenAPI descriptors for the tracker's GitHub import + manual sync (doc-only; see api/openapi.ts).
// Everdict is the CLIENT here: no inbound webhook exists, and there is no periodic sweep — a pull happens when
// someone calls sync, a push happens as the effect of a local transition on a push-enabled copy.
const SyncOutcomeSchema = z.object({
  id: z.string(),
  number: z.number(),
  changed: z.boolean(),
  error: z.string().optional(),
});

const GithubCandidateSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
  body: z.string().optional(),
});

export const issueGithubDocs: Record<
  "candidates" | "import" | "pullRepository" | "pullIssue" | "setSync" | "detach",
  FastifySchema
> = {
  candidates: {
    summary: "GitHub issues available to import",
    description:
      "A repo's issues minus pull requests minus the ones this workspace already imported — the picker's data. " +
      "Reads through the workspace GitHub App's installation, so a repo the App is not installed on is a 404. " +
      "Requires issues:write.",
    tags: ["issue"],
    querystring: toJsonSchema(
      z.object({
        repository: z.string().describe('"owner/name"'),
        host: z.string().optional().describe("GitHub Enterprise host; unset = github.com"),
        state: z.enum(["open", "closed", "all"]).optional(),
      }),
    ),
    response: {
      200: { description: "Importable issues", ...toJsonSchema(z.array(GithubCandidateSchema)) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  import: {
    summary: "Import GitHub issues as tracker issues",
    description:
      "Copy the named issues into the workspace tracker. Idempotent by the remote identity: a number already " +
      "imported is skipped, never duplicated. An open issue lands as `todo`; a closed one lands as `done` with a " +
      "note and deliberately WITHOUT a scorecard — claiming evidence we do not have would poison every later " +
      "regression comparison. Sync defaults to pull-on / push-off. Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(ImportGithubIssuesBodySchema),
    response: {
      201: {
        description: "Created issues plus what was skipped and why",
        ...toJsonSchema(
          z.object({
            created: z.array(IssueRecordSchema),
            skipped: z.array(z.object({ number: z.number(), reason: z.enum(["already_imported", "pull_request"]) })),
          }),
        ),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  pullRepository: {
    summary: "Pull a repo's synced issues from GitHub",
    description:
      "One incremental list call (watermarked by the oldest copy's last-seen remote timestamp) over the repo's " +
      "pull-enabled copies, then per-issue apply. GitHub wins on title/description/labels/comments; an open↔closed " +
      "change reconciles through the normal resolve/reopen transitions, so a sync-driven close emits the same fact " +
      "a member's close does. One issue's failure is recorded on that issue and the batch continues. " +
      "Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(PullGithubIssuesBodySchema),
    response: {
      200: { description: "Per-issue outcomes", ...toJsonSchema(z.array(SyncOutcomeSchema)) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  pullIssue: {
    summary: "Pull one issue from GitHub",
    description:
      "Refresh a single imported copy. A remote that has not changed since the last pull is a no-op — the same " +
      "watermark check that swallows the echo of our own push. Requires issues:write.",
    tags: ["issue"],
    response: {
      200: { description: "The refreshed issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setSync: {
    summary: "Set an imported issue's sync direction",
    description:
      "Turn pull and push on or off for this copy. Push writes the open/closed state plus an explanatory comment " +
      "back to GitHub when the issue is resolved, cancelled or reopened locally. Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(IssueGithubSyncBodySchema),
    response: {
      200: { description: "The updated issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  detach: {
    summary: "Detach an issue from its GitHub copy",
    description: "Drop the remote link. The local issue and its whole history stay. Requires issues:write.",
    tags: ["issue"],
    response: {
      200: { description: "The detached issue", ...toJsonSchema(IssueRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
};
