import { BatchCaseResponseSchema } from "@everdict/contracts/wire";
import { BatchPlanResponseSchema } from "@everdict/contracts/wire";
import { OkResponseSchema } from "@everdict/contracts/wire";
import { ScheduleFireResponseSchema } from "@everdict/contracts/wire";
import { SchedulingDialsResponseSchema } from "@everdict/contracts/wire";
import { ScorecardStatusResponseSchema } from "@everdict/contracts/wire";
import { TenantKeyResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

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
  usage: {
    summary: "Report metered LLM usage (internal)",
    description:
      "Agent server → meter bridge: the agent loop yields TOKENS per conversation; the control plane prices them " +
      'into USD and records + settles them against the workspace (source "agent"), so agent-conversation cost lands ' +
      "in the SAME meter + enforcement budget as evals. Guarded by x-internal-token (403 on mismatch; fail-closed " +
      "404 when unset).",
    tags: ["internal"],
    body: toJsonSchema(
      z.object({
        tenant: z.string().min(1),
        source: z.enum(["harness", "judge", "agent"]),
        model: z.string(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
    ),
    response: {
      200: { description: "Recorded", ...toJsonSchema(OkResponseSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  commentActivity: {
    summary: "Report a discussion-agent comment's lifecycle (internal)",
    description:
      "Agent server → placeholder-comment bridge: the detached discussion turn (@everdict in a resource's comment " +
      "thread) reports its progress — activity token while running, awaiting_approval on a HITL park, the final " +
      "markdown body on complete (or failed). The control plane stays the only comment mutator. Guarded by " +
      "x-internal-token (403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    body: toJsonSchema(
      z.object({
        tenant: z.string().min(1),
        commentId: z.string().min(1),
        status: z.enum(["running", "awaiting_approval", "complete", "failed"]).optional(),
        activity: z
          .string()
          .nullable()
          .optional()
          .describe('machine token ("thinking"|"writing"|"tool:<name>"); null clears the line'),
        body: z.string().optional().describe("final markdown answer (terminal patch)"),
      }),
    ),
    response: {
      200: { description: "Applied", ...toJsonSchema(OkResponseSchema) },
      ...errorResponses(400, 403, 404),
    },
  },
  events: {
    summary: "Read the platform-event log from a cursor (internal)",
    description:
      "Agent-service reconcile bridge (docs/architecture/agent-automation.md): platform events (lifecycle facts) " +
      "are pushed best-effort as they happen; the agent service walks `seq > after` per workspace at startup/interval " +
      "so a missed push is recovered (at-least-once + event-id dedup). Ascending by seq. Guarded by x-internal-token " +
      "(403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    querystring: toJsonSchema(
      z.object({
        workspace: z.string().min(1).optional().describe("omit for the deployment-wide cursor (one reconcile loop)"),
        after: z.coerce.number().int().nonnegative().optional().describe("reconcile cursor — events with seq > after"),
        kinds: z.string().optional().describe("comma-separated kind filter"),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
    ),
    response: {
      200: { description: "Events (ascending by seq)" },
      ...errorResponses(400, 403, 404),
    },
  },
  admitActivation: {
    summary: "Admit an agent activation against the tenant budget (internal)",
    description:
      "Agent service → gate bridge (execution-model §5.1): the activation itself is admitted before the run " +
      "launches, exactly like an eval dispatch — 402 BUDGET_EXCEEDED past the tenant cap, a pass reserves one " +
      "run (settled later through the usage bridge). Guarded by x-internal-token.",
    tags: ["internal"],
    body: toJsonSchema(z.object({ tenant: z.string().min(1) })),
    response: {
      200: { description: "Admitted", ...toJsonSchema(z.object({ admitted: z.literal(true) })) },
      ...errorResponses(400, 402, 403, 404),
    },
  },
  agentRunEvents: {
    summary: "Record an agent-run lifecycle fact (internal)",
    description:
      "Agent service → event-log bridge (docs/architecture/agent-automation.md A5): the activation wrapper reports " +
      "agent.run.started/completed/failed/cancelled so the fleet view + audit read one durable record. These kinds " +
      "are never trigger-matchable. Guarded by x-internal-token (403 on mismatch; fail-closed 404 when unset)." +
      " With runId (P3), the same report also maintains the universal ledger: started opens Run{kind:agent}, a terminal report settles it (idempotent, at-least-once).",
    tags: ["internal"],
    body: toJsonSchema(
      z.object({
        tenant: z.string().min(1),
        kind: z.enum([
          "agent.run.started",
          "agent.run.awaiting_approval",
          "agent.run.completed",
          "agent.run.failed",
          "agent.run.cancelled",
        ]),
        sessionId: z.string().min(1),
        agentId: z.string().min(1),
        eventKind: z.string().min(1).describe("the platform-event kind that woke the run"),
        message: z.string().min(1),
        runId: z.string().min(1).optional().describe("P3 ledger correlation — opens/settles Run{kind:agent}"),
        agentVersion: z.string().min(1).optional(),
        eventId: z.string().min(1).optional(),
        creator: z.string().min(1).optional().describe("the member the activation acts as"),
        budgetUsd: z.number().positive().optional().describe("the delegated envelope slice (A7/§5.2)"),
        trace: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("O2: the turn transcript as TraceEvent[] — sealed as the run's trajectory (terminal reports)"),
      }),
    ),
    response: {
      200: { description: "Recorded", ...toJsonSchema(OkResponseSchema) },
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
  scorePlan: {
    summary: "Plan a detached scoring pass (internal bridge)",
    description:
      "Score-on-Temporal bridge (score:<groupId>): returns the (case, trial) child keys still missing at least " +
      "one selected judge's verdict — idempotent, so a resumed/continued workflow gets exactly the remainder " +
      "(zero duplicate judging). Guarded by x-internal-token.",
    tags: ["internal"],
    params: batchIdParams,
    body: toJsonSchema(z.object({ judges: z.array(z.object({ id: z.string(), version: z.string() })).min(1) })),
    response: {
      200: {
        description: "Unfinished child keys + lane concurrency",
        ...toJsonSchema(z.object({ keys: z.array(z.string()), concurrency: z.number() })),
      },
      ...errorResponses(400, 403, 404, 409),
    },
  },
  scoreCase: {
    summary: "Judge one case of a scoring pass (internal bridge)",
    description:
      "Score-on-Temporal bridge: judges ONE (case, trial) child and writes the verdicts back to its child run. " +
      "Idempotent — an already-judged case returns skipped. Guarded by x-internal-token.",
    tags: ["internal"],
    params: batchIdParams,
    body: toJsonSchema(
      z.object({
        key: z.string().describe("child key <caseId>#<trial>"),
        judges: z.array(z.object({ id: z.string(), version: z.string() })).min(1),
        submittedBy: z.string().optional(),
      }),
    ),
    response: {
      200: {
        description: "Whether the case was judged (skipped = already done)",
        ...toJsonSchema(z.object({ scored: z.boolean(), skipped: z.boolean().optional() })),
      },
      ...errorResponses(400, 403, 404),
    },
  },
  scoreFinalize: {
    summary: "Finalize a detached scoring pass (internal bridge)",
    description:
      "Score-on-Temporal bridge: re-aggregates from the re-scored children and settles through the rescore " +
      "transition (scorecard.scored fact via the E0 outbox; an experiment promotes). Guarded by x-internal-token.",
    tags: ["internal"],
    params: batchIdParams,
    body: toJsonSchema(
      z.object({
        judges: z.array(z.object({ id: z.string(), version: z.string() })).min(1),
        submittedBy: z.string().optional(),
      }),
    ),
    response: {
      200: { description: "Finalized", ...toJsonSchema(OkResponseSchema) },
      ...errorResponses(400, 403, 404, 409),
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
      "Called by the workflow after poll-to-terminal: records the fired scorecard's terminal status on the " +
      "schedule. Guarded by x-internal-token (403 on mismatch; fail-closed 404 when unset).",
    tags: ["internal"],
    params: scheduleIdParams,
    body: toJsonSchema(z.object({ tenant: z.string().min(1), scorecardId: z.string().min(1) })),
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
