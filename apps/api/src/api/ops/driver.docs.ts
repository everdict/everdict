import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

const driverParams = toJsonSchema(
  z.object({
    family: z
      .enum(["batch", "score", "approval", "reaper", "reaction"])
      .describe(
        "workflow family — batch (driver loop) | score (detached scoring) | approval (durable WAIT) | reaper (session teardown timer) | reaction (multi-step reaction chain)",
      ),
    id: z.string().describe("LEDGER id (the scorecard/group/approval id) — never a raw workflowId"),
  }),
);

const statusSchema = z.object({
  family: z.string(),
  ledgerId: z.string(),
  workflowId: z.string(),
  runId: z.string(),
  status: z.string(),
  startTime: z.string().optional(),
  closeTime: z.string().optional(),
  historyLength: z.number().optional(),
  pendingActivities: z.array(
    z.object({ activityType: z.string(), attempt: z.number().optional(), lastFailure: z.string().optional() }),
  ),
});

// OpenAPI descriptors for the Driver ops surface v0 (docs/orchestration.md — the 044 adoption gate: every
// durable workflow readable/controllable through the everdict wrap, addressed by ledger vocabulary).
const docs = {
  describe: {
    summary: "Describe a driver workflow (ops surface)",
    description:
      "The durable driver's lifecycle for a LEDGER id: status, history pressure, and each pending activity's " +
      "retry state with its last failure — the log-level read an ops agent needs to answer 'where is this " +
      "stuck, and why'. Addressed by the scorecard/group id (the deterministic workflowId family does the " +
      "mapping); the ledger record must belong to the caller's workspace (404 otherwise). Requires " +
      "runtimes:read. 404 when the id never ran on Temporal (in-process batches have no workflow).",
    tags: ["ops"],
    params: driverParams,
    response: {
      200: { description: "The workflow's diagnostic status", ...toJsonSchema(statusSchema) },
      ...errorResponses(401, 403, 404, 502),
    },
  },
  cancel: {
    summary: "Cancel a driver workflow (ops surface)",
    description:
      "Cooperative cancellation of the durable driver — the ledger record settles through the control plane's " +
      "own terminal guards (this never writes the ledger directly). Destructive → requires runtimes:control " +
      "(admin-only), same posture as live-cluster runtime control.",
    tags: ["ops"],
    params: driverParams,
    response: {
      200: { description: "Cancellation requested", ...toJsonSchema(z.object({ ok: z.literal(true) })) },
      ...errorResponses(401, 403, 404, 502),
    },
  },
} satisfies Record<string, FastifySchema>;

export const driverDocs: Record<keyof typeof docs, FastifySchema> = docs;
