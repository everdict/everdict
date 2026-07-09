import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Shared plumbing for the doc-only OpenAPI descriptors (<resource>.docs.ts). Rule api-layer: schemas document,
// never validate/serialize — the compilers in server.ts are no-ops, so nothing here can change behavior.

// zod → OpenAPI 3 JSON Schema. $refStrategy "none" inlines sub-schemas so each descriptor is self-contained.
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
}

// The flat error envelope every failure funnels through (AppError.toEnvelope → sendError).
export const errorEnvelope: Record<string, unknown> = {
  type: "object",
  properties: {
    code: { type: "string", description: "Stable machine-readable code (BAD_REQUEST, NOT_FOUND, FORBIDDEN, …)" },
    message: { type: "string" },
    data: { type: "object", additionalProperties: true, description: "Optional structured error context" },
  },
  required: ["code", "message"],
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid request body/params (flat envelope)",
  401: "Missing or unverifiable credential",
  402: "Budget exceeded",
  403: "Role/scope denies the action",
  404: "Not found (including another workspace's resource — no existence leak)",
  409: "Conflict (immutable version already exists / last admin)",
  429: "Queue backpressure / rate limited",
};

// Standard error entries for a descriptor's `response` map: errorResponses(400, 403, 404).
export function errorResponses(...statuses: number[]): Record<number, Record<string, unknown>> {
  const out: Record<number, Record<string, unknown>> = {};
  for (const status of statuses)
    out[status] = { description: ERROR_DESCRIPTIONS[status] ?? "Error (flat envelope)", ...errorEnvelope };
  return out;
}
