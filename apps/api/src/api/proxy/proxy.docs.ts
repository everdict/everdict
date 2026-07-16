import { WorkspaceProxySchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

const proxyView = toJsonSchema(
  z.object({
    name: z.string(),
    country: z.string(),
    url: z.string(),
    authSecretName: z.string().optional(),
  }),
);
const nameParams = toJsonSchema(z.object({ name: z.string().describe("Proxy name") }));

// OpenAPI descriptors for the workspace proxy routes (browser-profiles S4) — documentation only (rule api-layer).
const docs = {
  list: {
    summary: "List the workspace's egress proxies",
    description:
      "The BYO per-country proxies registered for this workspace (secrets redacted). Consumed by the interactive " +
      "browser-session geo picker; the auth secret value is never returned.",
    tags: ["proxy"],
    response: {
      200: {
        description: "Registered proxies",
        type: "object",
        properties: { proxies: { type: "array", items: proxyView } },
      },
      ...errorResponses(401),
    },
  },
  upsert: {
    summary: "Register or update an egress proxy",
    description:
      "Registers a BYO proxy for a country (upsert by name). Admin only (settings:write). authSecretName is a " +
      "SecretStore key holding the proxy 'user:pass' (optional); its value is never stored/returned.",
    tags: ["proxy"],
    body: toJsonSchema(WorkspaceProxySchema),
    response: {
      200: {
        description: "The registered proxy (+ missingSecrets when the referenced secret is not set yet)",
        type: "object",
        properties: { config: proxyView, missingSecrets: { type: "array", items: { type: "string" } } },
      },
      ...errorResponses(400, 401, 403),
    },
  },
  remove: {
    summary: "Remove an egress proxy",
    description: "Removes the named proxy. Admin only (settings:write).",
    tags: ["proxy"],
    params: nameParams,
    response: {
      204: { description: "Removed" },
      ...errorResponses(401, 403),
    },
  },
} satisfies Record<string, FastifySchema>;

export const proxyDocs: Record<keyof typeof docs, FastifySchema> = docs;
