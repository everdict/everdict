import { MattermostActionReplySchema } from "@everdict/contracts/wire";
import { MattermostProbeResultSchema } from "@everdict/contracts/wire";
import { MattermostStatusResponseSchema, MattermostUpsertResponseSchema } from "@everdict/contracts/wire";
import { MattermostReplySchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// Doc-only OpenAPI descriptors for the workspace Mattermost integration + the public inbound surface
// (rule api-layer: schemas document, never validate/serialize — the compilers are no-ops).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  status: {
    summary: "Workspace Mattermost integration status",
    description:
      "Workspace-owned integration (an admin registers the workspace's bot + channel once — replaces personal " +
      "connected-account notifications). host is the operator-configured server URL (MATTERMOST_HOST env; absent = " +
      "unavailable); config is absent when the workspace hasn't registered a bot. All secret fields are SecretStore " +
      "name references, never values. Requires settings:read.",
    tags: ["mattermost"],
    response: {
      200: {
        description: "Operator server URL + workspace registration",
        ...toJsonSchema(MattermostStatusResponseSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  upsert: {
    summary: "Register or update the workspace Mattermost",
    description:
      "The server URL is operator env (MATTERMOST_HOST), not accepted here. Put the bot token (and optionally the " +
      "inbound verification token) into the SecretStore first, then pass only their names. The bot token (+ channel) " +
      "is verified against the live server before saving (strict — a failed connection is a 400). Setting " +
      "commandTokenSecretName activates the /everdict slash command and buttons. Requires settings:write (admin).",
    tags: ["mattermost"],
    body: toJsonSchema(
      z.object({
        botTokenSecretName: z.string().min(1).describe("SecretStore name of the bot access token"),
        defaultChannelId: z.string().min(1).optional(),
        commandTokenSecretName: z
          .string()
          .min(1)
          .optional()
          .describe("SecretStore name of the inbound (slash command/button) verification token"),
      }),
    ),
    response: {
      200: { description: "Stored config", ...toJsonSchema(MattermostUpsertResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  probe: {
    summary: "Test a Mattermost bot token + channel",
    description:
      "Connection test run before registration: the bot token authenticates against the operator server and, when a " +
      "channel is given, the channel's accessibility is checked. A classified failure (reason set, reachable=false) " +
      "is still a 200 — the web gates Save on reachable=true. No secrets echoed. Requires settings:write (admin).",
    tags: ["mattermost"],
    body: toJsonSchema(
      z.object({
        botTokenSecretName: z.string().min(1).describe("SecretStore name of the bot access token"),
        defaultChannelId: z.string().min(1).optional().describe("Channel to verify accessibility of"),
      }),
    ),
    response: {
      200: { description: "Connection-test outcome", ...toJsonSchema(MattermostProbeResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Remove the workspace Mattermost integration",
    description: "Clears the workspace Mattermost config (notifications stop). Requires settings:write (admin).",
    tags: ["mattermost"],
    response: { 204: { description: "Removed", type: "null" }, ...errorResponses(401, 403, 404) },
  },
  command: {
    summary: "Mattermost slash command inbound (public)",
    description:
      "Mattermost calls this directly (form-urlencoded, not a user session). The workspace is routed by ?ws=; " +
      "authenticity is a constant-time comparison of the request token against the workspace's inbound " +
      "verification token (fail-closed — unconfigured or mismatching tokens are 403).",
    tags: ["mattermost"],
    querystring: toJsonSchema(z.object({ ws: z.string().describe("Workspace slug (routing only — not auth)") })),
    body: toJsonSchema(
      z.object({
        token: z.string().optional().describe("Mattermost outgoing-command verification token"),
        text: z.string().optional().describe("Command text after /everdict"),
        user_name: z.string().optional(),
      }),
    ),
    response: {
      200: { description: "Slash-command reply rendered by Mattermost", ...toJsonSchema(MattermostReplySchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  action: {
    summary: "Mattermost interactive button inbound (public)",
    description:
      "Mattermost echoes back the context embedded in an interactive message (token/action/dataset/harness). " +
      "The verification token rides in context.token — same constant-time, fail-closed check as the slash command.",
    tags: ["mattermost"],
    querystring: toJsonSchema(z.object({ ws: z.string().describe("Workspace slug (routing only — not auth)") })),
    body: toJsonSchema(
      z.object({
        context: z
          .object({
            token: z.string().optional().describe("Inbound verification token embedded in the message"),
            action: z.string().optional().describe('Action name (currently "rerun")'),
            dataset: z.string().optional(),
            harness: z.string().optional(),
            userName: z.string().optional(),
          })
          .optional(),
      }),
    ),
    response: {
      200: { description: "Ephemeral reply for the clicking user", ...toJsonSchema(MattermostActionReplySchema) },
      ...errorResponses(400, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const mattermostDocs: Record<keyof typeof docs, FastifySchema> = docs;
