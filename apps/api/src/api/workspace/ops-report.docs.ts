import { GateAuditSchema, OpsReportSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptor for the workspace ops report (doc-only — never validates/serializes; see api/openapi.ts).
export const opsReportDocs: Record<"read" | "gateAudit", FastifySchema> = {
  read: {
    summary: "Read the workspace ops report",
    description:
      "The workspace's own execution health over a window — the platform's failure share separated from the " +
      "product's: batch fates, case-fate sums (the CaseOutcome vocabulary), infra-failure/unmeasured/seal " +
      "rates, and the evidence-plane tallies. Derived from THIS workspace's ledger only. Every rate is ABSENT " +
      "when its denominator is zero — a window with no executed cases has no infra-failure rate, not a 0% " +
      "one. Requires scorecards:read.",
    tags: ["workspace"],
    querystring: toJsonSchema(
      z.object({
        from: z.string().optional().describe("ISO lower bound on createdAt (inclusive)"),
        to: z.string().optional().describe("ISO upper bound on createdAt (inclusive)"),
      }),
    ),
    response: {
      200: { description: "The ops report for the window", ...toJsonSchema(OpsReportSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  gateAudit: {
    summary: "Read the workspace gate audit",
    description:
      "Every recorded release-gate decision in the window, counted by outcome, plus every override with its " +
      "stated reason (catalog R7 — the governance read). `overrideRate` = overrides/blocks, ABSENT when no " +
      "block landed in the window. Requires scorecards:read.",
    tags: ["workspace"],
    querystring: toJsonSchema(
      z.object({
        from: z.string().optional().describe("ISO lower bound on decidedAt (inclusive)"),
        to: z.string().optional().describe("ISO upper bound on decidedAt (inclusive)"),
      }),
    ),
    response: {
      200: { description: "The gate audit for the window", ...toJsonSchema(GateAuditSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
};
