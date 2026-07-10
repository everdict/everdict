import { MeResponseSchema } from "@everdict/contracts/wire";
import { UserProfileResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the profile routes (doc-only — never validates/serializes; see api/openapi.ts).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const profileDocs: Record<"me" | "updateProfile", FastifySchema> = {
  me: {
    summary: "Who am I",
    description:
      "The resolved Principal for the presented credential — subject, active workspace, roles, auth channel — plus the caller's " +
      "workspace list and mutable profile when available. Self-scoped; no role gate. The web uses this to role-gate its UI " +
      "(the control plane still enforces on every call).",
    tags: ["profile"],
    response: {
      200: { description: "Identity + workspaces + profile", ...toJsonSchema(MeResponseSchema) },
      ...errorResponses(401),
    },
  },
  updateProfile: {
    summary: "Edit my profile",
    description:
      "Self-serve (subject = the caller; no role gate). email is an SSO claim and is not accepted here (immutable). " +
      "An empty string clears that field. Returns the updated profile.",
    tags: ["profile"],
    body: toJsonSchema(
      z.object({
        name: z.string().optional().describe("Display name (max 80 chars); empty string clears it"),
        username: z.string().optional().describe("Handle (2–39 chars of alphanumeric/_/-); empty string clears it"),
        avatarUrl: z.string().optional().describe("Avatar (http(s) URL or data:image base64); empty string clears it"),
      }),
    ),
    response: {
      200: { description: "Updated profile", ...toJsonSchema(UserProfileResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
};
