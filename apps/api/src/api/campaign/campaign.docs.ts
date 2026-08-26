import { EvolutionCampaignRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { LogCampaignRoundBodySchema } from "./request/log-campaign-round.js";
import { OpenCampaignBodySchema } from "./request/open-campaign.js";

// OpenAPI descriptors for the evolution-campaign routes (doc-only — never validates/serializes; see
// api/openapi.ts). A campaign is the SETTLEMENT behind the agent-evolve loop: a frame frozen at open, an
// append-only round trace whose verdicts are derived from the production diff, and a close that carries the
// pure adoption gate's answer. Authz reuses the scorecard actions (no new action): read = scorecards:read,
// write = scorecards:run. Design: docs/architecture/evolution-lineage.md (Track D).
export const campaignDocs: Record<"open" | "list" | "get" | "logRound" | "decision" | "settle", FastifySchema> = {
  open: {
    summary: "Open an evolution campaign",
    description:
      "Freeze the campaign frame (subject, scenarios with held-out marked, judges, trials, budget, " +
      "significance, the identity waiver) and record its digest. The frame is immutable from here — " +
      "changing it is a new campaign. The issue is the campaign's journal and must exist.",
    tags: ["campaign"],
    body: toJsonSchema(OpenCampaignBodySchema),
    response: {
      201: { description: "The opened campaign", ...toJsonSchema(EvolutionCampaignRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List the workspace's campaigns",
    tags: ["campaign"],
    response: {
      200: { description: "Campaigns, newest first", ...toJsonSchema(z.array(EvolutionCampaignRecordSchema)) },
      ...errorResponses(401, 403),
    },
  },
  get: {
    summary: "Read one campaign",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The campaign", ...toJsonSchema(EvolutionCampaignRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  logRound: {
    summary: "Log a campaign round (verdict derived, never accepted)",
    description:
      "Record one tested hypothesis. The round's verdict is derived from the production scorecard diff — " +
      "trial statistics (Fisher/z + FDR + minDelta as frozen in the frame) and experiment identity — so the " +
      "loop cannot write its own report card. Appending CASes on the round count: a concurrent round " +
      "answers 409, re-read and retry. The response carries the pure gate's answer over the new trace.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(LogCampaignRoundBodySchema),
    response: {
      201: { description: "The logged round + the gate's answer" },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  decision: {
    summary: "Ask the adoption gate (pure read)",
    description:
      "The pure gate over the frame and the rounds: adopt (the latest candidate is significantly better " +
      "with zero regressions over a verifiable world) | continue | halt (no_improvement, budget_exhausted, " +
      "or identity_unverified — which refuses adoption but keeps the campaign open).",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: { 200: { description: "The gate's answer" }, ...errorResponses(401, 403, 404) },
  },
  settle: {
    summary: "Settle the campaign per the gate's answer",
    description:
      "Close as adopted (recording the version, the proving scorecard, and any waived identity axes) or as " +
      "the gate's own ending (no_improvement / budget_exhausted). A gate answering continue or " +
      "identity_unverified REFUSES the settle with 409 — the campaign is not done, or the fix is another " +
      "round. First terminal wins; a lost race reads what won.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The settled campaign + the gate answer it carries" },
      ...errorResponses(401, 403, 404, 409),
    },
  },
};
