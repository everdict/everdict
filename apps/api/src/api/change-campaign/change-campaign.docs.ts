import type { FastifySchema } from "fastify";
import { errorResponses } from "../openapi.js";

// OpenAPI descriptors for the `change` campaign routes (doc-only — never validates/serializes; see
// api/openapi.ts). Authz reuses the scorecard actions: a campaign is evaluation work, and whoever may read a
// workspace's evaluations may read what its changes were judged against.
export const changeCampaignDocs: Record<"open" | "round" | "close" | "get" | "list", FastifySchema> = {
  open: {
    summary: "Open a change campaign",
    description:
      "Open the `change` grade of campaign against an issue: the service being changed and the acceptance " +
      "criteria, DECLARED BEFORE the work. A criterion assembled afterwards from whatever happened to pass " +
      "describes the outcome instead of judging it, so the list is required here and immutable after. " +
      "Requires scorecards:write.",
    tags: ["campaigns"],
    ...errorResponses,
  },
  round: {
    summary: "Log a round",
    description:
      "Append one attempt: what it believed, the change set it produced (each service's commits), and the " +
      "agent's answer to every declared criterion — `met` | `not_met` | `not_run`, each marked `observed` " +
      "(a command ran) or `asserted` (read and concluded). The round's OUTCOME is derived from those " +
      "answers, never supplied: `not_run` is not `met`. Refused (400) when an answer set does not cover the " +
      "declaration exactly or a commit is already claimed by another round; 409 when another round landed " +
      "first. Requires scorecards:write.",
    tags: ["campaigns"],
    ...errorResponses,
  },
  close: {
    summary: "Close a change campaign",
    description:
      "End the campaign as adopted or abandoned. An adopted close names the round that carried it, and that " +
      "round must be one whose criteria all came back met. No campaign closes in silence: name the " +
      "knowledge entries it produced or decline with a reason. Requires scorecards:write.",
    tags: ["campaigns"],
    ...errorResponses,
  },
  get: { summary: "Read a change campaign", tags: ["campaigns"], ...errorResponses },
  list: {
    summary: "List change campaigns",
    description: "Newest first; `issueId` narrows to one request's attempts.",
    tags: ["campaigns"],
    ...errorResponses,
  },
};
