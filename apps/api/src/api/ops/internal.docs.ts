import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { BatchCaseResponseSchema } from "./response/batch-case.js";
import { BatchPlanResponseSchema } from "./response/batch-plan.js";
import { OkResponseSchema } from "./response/ok.js";
import { ScheduleFireResponseSchema } from "./response/schedule-fire.js";
import { SchedulingDialsResponseSchema } from "./response/scheduling-dials.js";
import { ScorecardStatusResponseSchema } from "./response/scorecard-status.js";
import { TenantKeyResponseSchema } from "./response/tenant-key.js";

const batchIdParams = toJsonSchema(z.object({ id: z.string().describe("Scorecard (batch) id") }));
const scheduleIdParams = toJsonSchema(z.object({ id: z.string().describe("Schedule id") }));

// Doc-side mirrors of the inline route body schemas (internal routes validate inline; docs stay in sync by hand).
const schedulingBody = z.object({
  quotas: z
    .record(z.number().int().positive().nullable())
    .optional()
    .describe("Per-tenant in-flight quota overrides (null clears the override → env default)"),
  weights: z
    .record(z.number().positive().nullable())
    .optional()
    .describe("Per-tenant WFQ weight overrides (null clears the override → env default)"),
});

// OpenAPI descriptors for the internal control-plane surface — documentation only (no-op compilers;
// rule api-layer). Every /internal/** route is guarded by the x-internal-token header (constant-time
// compare, fail-closed 404 when the token is unset); there is no end-user auth context.
const internal = {
  schedulingSet: {
    summary: "Set scheduler fairness dials",
    description:
      "Operator plane: adjusts per-tenant quota/weight overrides without a restart (layered over the env " +
      "defaults; a restart falls back to env; null clears an override). Guarded by x-internal-token " +
      "(401 on mismatch here; fail-closed 404 when unset). Returns the effective dials.",
    tags: ["internal"],
    body: toJsonSchema(schedulingBody),
    response: {
      200: { description: "Effective dials after the patch", ...toJsonSchema(SchedulingDialsResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  schedulingGet: {
    summary: "Get scheduler fairness dials",
    description:
      "Operator plane: reads the effective per-tenant quota/weight dials. Guarded by x-internal-token " +
      "(401 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    response: {
      200: { description: "Effective dials", ...toJsonSchema(SchedulingDialsResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  tenantKeys: {
    summary: "Issue a workspace API key",
    description:
      "Issues an ak_… API key for a workspace (bootstrap / operator provisioning). Guarded by " +
      "x-internal-token (403 on mismatch; fail-closed 404 when unset). The plaintext key is returned only " +
      "once, in this response.",
    tags: ["internal"],
    body: toJsonSchema(z.object({ workspace: z.string().min(1) })),
    response: {
      201: { description: "The issued key (plaintext, shown once)", ...toJsonSchema(TenantKeyResponseSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  batchPlan: {
    summary: "Plan a Temporal batch (internal bridge)",
    description:
      "Batch-on-Temporal bridge: the workflow's plan activity asks the control plane for the batch's remaining " +
      "case ids + concurrency (idempotent — settled cases are excluded, so a re-plan after recovery is safe). " +
      "Guarded by x-internal-token (403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    params: batchIdParams,
    response: {
      200: { description: "The case plan", ...toJsonSchema(BatchPlanResponseSchema) },
      ...errorResponses(403, 404),
    },
  },
  batchCase: {
    summary: "Run one batch case (internal bridge)",
    description:
      "Batch-on-Temporal bridge: executes one case of the batch on the control plane (the CP owns " +
      "execution/scoring; the workflow owns driver-loop durability). Idempotent — an already-settled case " +
      "returns skipped=true without re-running. Guarded by x-internal-token (403 on mismatch; fail-closed 404).",
    tags: ["internal"],
    params: batchIdParams,
    body: toJsonSchema(z.object({ caseId: z.string().min(1) })),
    response: {
      200: { description: "Case settle outcome", ...toJsonSchema(BatchCaseResponseSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  batchFinalize: {
    summary: "Finalize a Temporal batch (internal bridge)",
    description:
      "Batch-on-Temporal bridge: seals the batch after all cases settle (summary/judges/export/notification). " +
      "Guarded by x-internal-token (403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    params: batchIdParams,
    response: {
      200: { description: "Finalized", ...toJsonSchema(OkResponseSchema) },
      ...errorResponses(403, 404),
    },
  },
  scheduleFire: {
    summary: "Fire a schedule (internal bridge)",
    description:
      "Called by the Temporal schedule workflow (workflow → activity → this route → ScheduleService.fire). " +
      "The tenant is baked into the workflow at schedule creation and arrives in the trusted body. Submits " +
      "the scheduled scorecard as the schedule's creator. Guarded by x-internal-token (403 on mismatch; " +
      "fail-closed 404 when unset).",
    tags: ["internal"],
    params: scheduleIdParams,
    body: toJsonSchema(z.object({ tenant: z.string().min(1) })),
    response: {
      200: { description: "The fired scorecard reference", ...toJsonSchema(ScheduleFireResponseSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  scheduleFinalize: {
    summary: "Finalize a schedule fire (internal bridge)",
    description:
      "Called by the workflow after poll-to-terminal: records the fire's final status on the schedule and " +
      "emits a regression notification vs the previous run when applicable. Guarded by x-internal-token " +
      "(403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    params: scheduleIdParams,
    body: toJsonSchema(
      z.object({
        tenant: z.string().min(1),
        scorecardId: z.string().min(1),
        previousScorecardId: z.string().optional(),
      }),
    ),
    response: {
      200: { description: "Finalized", ...toJsonSchema(OkResponseSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  scorecardStatus: {
    summary: "Get a fired scorecard's status (internal bridge)",
    description:
      "Poll-to-terminal read for the schedule workflow: the fired scorecard's current status (null when " +
      "unknown). Guarded by x-internal-token (403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    params: toJsonSchema(z.object({ scorecardId: z.string().describe("The fired scorecard id") })),
    response: {
      200: { description: "Current status", ...toJsonSchema(ScorecardStatusResponseSchema) },
      ...errorResponses(403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const internalDocs: Record<keyof typeof internal, FastifySchema> = internal;
