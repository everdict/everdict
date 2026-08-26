import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { campaignDocs } from "./campaign.docs.js";
import { LogCampaignRoundBodySchema } from "./request/log-campaign-round.js";
import { OpenCampaignBodySchema } from "./request/open-campaign.js";

// Evolution campaigns — the settlement behind the agent-evolve loop (docs/architecture/evolution-lineage.md,
// Track D). Reuses the scorecard actions (no new authz action): read = scorecards:read, write = scorecards:run.
export function registerCampaignRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/campaigns", { schema: campaignDocs.open }, async (req, reply) => {
    if (!deps.campaignService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof OpenCampaignBodySchema>;
    try {
      body = OpenCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(await deps.campaignService.open(principal.workspace, body, principal.subject));
    } catch (err) {
      return sendError(reply, err); // unknown issue → 404
    }
  });

  app.get("/campaigns", { schema: campaignDocs.list }, async (req, reply) => {
    if (!deps.campaignService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(await deps.campaignService.list(principal.workspace));
  });

  app.get<{ Params: { id: string } }>("/campaigns/:id", { schema: campaignDocs.get }, async (req, reply) => {
    if (!deps.campaignService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.campaignService.get(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/campaigns/:id/rounds",
    { schema: campaignDocs.logRound },
    async (req, reply) => {
      if (!deps.campaignService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "campaign service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:run");
      } catch (err) {
        return sendError(reply, err);
      }
      let body: z.infer<typeof LogCampaignRoundBodySchema>;
      try {
        body = LogCampaignRoundBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply
          .code(201)
          .send(await deps.campaignService.logRound(principal.workspace, req.params.id, body, principal.subject));
      } catch (err) {
        return sendError(reply, err); // missing scorecard 404 / concurrent round · closed campaign 409
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/decision",
    { schema: campaignDocs.decision },
    async (req, reply) => {
      if (!deps.campaignService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "campaign service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        return reply.send(await deps.campaignService.decision(principal.workspace, req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/campaigns/:id/settle", { schema: campaignDocs.settle }, async (req, reply) => {
    if (!deps.campaignService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.campaignService.settle(principal.workspace, req.params.id, principal.subject));
    } catch (err) {
      return sendError(reply, err); // continue/identity_unverified refusals + lost settle races → 409
    }
  });
}
