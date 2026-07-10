import { BudgetResponseSchema } from "@everdict/contracts/wire";
import { UsageResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { BudgetLimitInputSchema } from "../../common/budget-tracker.js";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the billing routes — documentation only (no-op compilers; rule api-layer).
// Attached by billing.routes.ts as { schema: billingDocs.<key> }.
const docs = {
  usage: {
    summary: "Get metered LLM usage",
    description:
      "The workspace's metered LLM cost (orchestration + verdict; own-pays self-hosted runs excluded). " +
      "Meter-only — it never blocks a run. Readable by members (viewer+, reuses scorecards:read — usage is " +
      "part of the eval read surface). 404 when the usage meter is not configured.",
    tags: ["billing"],
    response: {
      200: { description: "Tenant usage with per-source breakdown", ...toJsonSchema(UsageResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  getBudget: {
    summary: "Get the enforcement budget",
    description:
      "Committed usage + the per-tenant limit of the enforcement budget (the one that blocks runs with 402 at " +
      "a cap — distinct from the meter-only /usage). Readable by members (viewer+, reuses scorecards:read). " +
      "404 when the budget is not configured.",
    tags: ["billing"],
    response: {
      200: { description: "Budget usage and limit", ...toJsonSchema(BudgetResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  setBudget: {
    summary: "Set the enforcement budget limit",
    description:
      "Replaces the workspace's whole budget limit (an omitted dimension = unlimited). Admin only " +
      "(settings:write). Returns the current usage plus the new limit. 404 when the budget is not configured.",
    tags: ["billing"],
    body: toJsonSchema(BudgetLimitInputSchema),
    response: {
      200: { description: "Budget usage and the updated limit", ...toJsonSchema(BudgetResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const billingDocs: Record<keyof typeof docs, FastifySchema> = docs;
