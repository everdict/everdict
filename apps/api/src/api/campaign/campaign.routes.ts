import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { teamCeiling } from "../../common/team-scope.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { campaignDocs } from "./campaign.docs.js";
import { AdoptCampaignBodySchema } from "./request/adopt-campaign.js";
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
          .send(
            await deps.campaignService.logRound(
              principal.workspace,
              req.params.id,
              body,
              principal.subject,
              await teamCeiling(deps, principal),
            ),
          );
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

  // What the close AUTHORIZED, and whether anybody spent it. Without this read the durable operation was
  // unreachable from every transport — `decided` was described as re-drivable by a comment and by nothing
  // else (arch-review 73).
  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/adoption",
    { schema: campaignDocs.adoption },
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
        const { campaign, operation } = await deps.campaignService.adoption(principal.workspace, req.params.id);
        // `operation: null` is an ANSWER — this campaign authorized nothing — never a 404 that reads as "no
        // such campaign". The state it closed in says which of the two absences this is.
        return reply.send({ campaignId: campaign.id, state: campaign.state, operation: operation ?? null });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Spend it. The registry effect lives at the composition root (this package owns no registry) and the
  // service is the ONE seam that turns "the gate authorized a version" into "this registry write is that
  // version" — arch-review 72's P0 was that no production code path reached it at all.
  app.post<{ Params: { id: string } }>("/campaigns/:id/adopt", { schema: campaignDocs.adopt }, async (req, reply) => {
    if (!deps.campaignAdoption)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign adoption not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // The EFFECT is a registry write, so the write action for the candidate's family is gated as well as
      // the campaign's own — spending an authorization must not be a way around `agents:write`.
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof AdoptCampaignBodySchema>;
    try {
      body = AdoptCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      gate(principal, body.proof.candidate.type === "agent" ? "agents:write" : "harnesses:register");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(
        await deps.campaignAdoption.adopt({
          tenant: principal.workspace,
          campaignId: req.params.id,
          proof: body.proof,
          // ⚠️ DERIVED FROM THE PRESENTED PROOF, so the service's coordinate comparison cannot fire on this
          // path — the proof digest already binds every one of these fields, and an edited coordinate is
          // refused as a proof the campaign never issued, one check earlier. That comparison is the SERVICE's
          // contract for callers that state a candidate independently; it is not what protects this route.
          //
          // What protects THIS route is three other things, and saying so is the point (a comment claiming a
          // check nobody performs is the failure this file's whole review series is about): the proof digest
          // vs the stored operation, the SPEC's own id/version vs the authorized ones (in
          // `composition/campaign-adoption.ts`), and the registry read-back vs what the campaign measured.
          candidate: {
            type: body.proof.candidate.type,
            id: body.proof.candidate.id,
            version: body.proof.candidate.version,
            ...(body.proof.candidate.specDigest !== undefined ? { specDigest: body.proof.candidate.specDigest } : {}),
          },
          spec: body.spec,
          by: principal.subject,
          via: "web",
        }),
      );
    } catch (err) {
      return sendError(reply, err); // no authorization → 404 · forged proof / wrong candidate / already spent → 409
    }
  });

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
