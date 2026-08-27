import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { assertTeamVisible, teamCeiling, teamOfEntity } from "../../common/team-scope.js";
import { agentAttributionFrom } from "../fs/fs-actor.js";
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
    let body: z.infer<typeof OpenCampaignBodySchema>;
    try {
      body = OpenCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      // ── OPENING A CAMPAIGN IS A WRITE INTO THE ISSUE'S TEAM (arch-review 78 P1-security) ────────────
      //
      // The campaign inherits the issue's team, so opening one against another team's private issue
      // CREATES a row in that team's space — a write authorized by nothing but a workspace-level action.
      // `IssueService.get` takes a tenant and a ref; team visibility is not one of its inputs, so knowing
      // the id was enough. The team is resolved here and both questions are asked of it: may this caller
      // SEE it (privacy), and may they WRITE to it (membership).
      // ⚠️ NOT `deps.issueService?.get(...)` — and this file had that spelling for the length of one fix
      // (arch-review 79). The optional call makes the whole team check evaporate when the tracker is absent:
      // `undefined` reads as UNOWNED, which is allowed. A campaign whose authority cannot be established
      // must not be opened.
      if (!deps.issueService)
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "issue service not configured — a campaign's team cannot be established",
        });
      const issue = await deps.issueService.get(principal.workspace, body.issueId);
      if (issue === undefined) return reply.code(404).send({ code: "NOT_FOUND", message: "issue not found" });
      // …and now the gate's input is unambiguous. An `issue?.teamId` here would hand authorization an
      // `undefined` that means "the issue is missing" while authz reads it as "no team constraint" — the
      // permissive arm, reached for a reason that has nothing to do with the resource (arch-review 79).
      await assertTeamVisible(deps, principal, issue.teamId, "Issue");
      gate(principal, "scorecards:run", { teamId: issue.teamId });
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
    // The caller's team ceiling, applied in the store's query — a private team's campaigns are answered as
    // nonexistent to everybody else (arch-review 76 P1-security).
    const { visibleTeams } = await teamCeiling(deps, principal);
    return reply.send(await deps.campaignService.list(principal.workspace, visibleTeams));
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
      const record = await deps.campaignService.get(principal.workspace, req.params.id);
      // A private team's campaign reads as nonexistent to everybody else — the same 404 an absent one gets,
      // so the surface does not leak which ids exist (arch-review 76 P1-security).
      await assertTeamVisible(deps, principal, record.teamId, "Campaign");
      // ⚠️ THE ROW CHECKED IS THE ROW RETURNED (arch-review 83). This read the campaign twice — once to
      // authorize, once to answer — so the value the check passed on was not the value the caller received.
      // A campaign's team happens to be immutable after open, which makes this harmless TODAY and not a
      // property to build on: rule `protocol` L1 asks the decision and the effect to rest on one read, and a
      // second `get` is a second moment.
      return reply.send(record);
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
      let body: z.infer<typeof LogCampaignRoundBodySchema>;
      try {
        body = LogCampaignRoundBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        // Appending a round MUTATES the campaign's append-only evidence, so it is gated against the
        // campaign's own team — not just a workspace action (arch-review 78 P1-security).
        const record = await deps.campaignService.get(principal.workspace, req.params.id);
        await assertTeamVisible(deps, principal, record.teamId, "Campaign");
        gate(principal, "scorecards:run", record.teamId !== undefined ? { teamId: record.teamId } : {});
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
        const record = await deps.campaignService.get(principal.workspace, req.params.id);
        // A private team's campaign reads as nonexistent to everybody else — the same 404 an absent one gets,
        // so the surface does not leak which ids exist (arch-review 76 P1-security).
        await assertTeamVisible(deps, principal, record.teamId, "Campaign");
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
        await assertTeamVisible(deps, principal, campaign.teamId, "Campaign");
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
    // The agent that acted, read ONCE from the request — two calls are two reads of the same headers (L1).
    const actingAgent = agentAttributionFrom(req.headers);
    let body: z.infer<typeof AdoptCampaignBodySchema>;
    try {
      body = AdoptCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    // ── …AND AGAINST THE TEAM THAT OWNS THE THING BEING WRITTEN (arch-review 76 P1-security) ────────
    //
    // Preserving the owner team and being ALLOWED to write to it are different questions, and the first
    // version answered only the first: the composition read the entity's team and registered the successor
    // under it, while the route gated a workspace-level action with no resource scope. So a member of Team B
    // holding `agents:write` could adopt a candidate owned by Team A and mint a Team-A-owned successor.
    //
    // The team model is explicit that READ is decided by team privacy and WRITE by team membership; a write
    // gated without `{ teamId }` has asked neither question about the resource it is about to change.
    try {
      // ⚠️ NOT `deps.campaignService?.get(...)` (arch-review 78). The optional call made the campaign's team
      // check vanish whenever the settlement service was absent — `undefined` reads as UNOWNED, which is
      // allowed. That is the law this very wave wrote, broken by the security fix that carries it: a
      // capability a protocol depends on is REQUIRED at the deciding seam, or its absence is a NAMED
      // outcome. An adoption cannot be gated against a campaign nobody can read.
      if (!deps.campaignService)
        return reply
          .code(404)
          .send({ code: "NOT_FOUND", message: "campaign service not configured — an adoption cannot be authorized" });
      const campaign = await deps.campaignService.get(principal.workspace, req.params.id);
      // Two authorities, both required: the campaign this proof came from, and the entity being written.
      // The proof carries the team frozen at open, so a later ownership move cannot widen what it authorizes.
      await assertTeamVisible(deps, principal, campaign.teamId, "Campaign");
      if (body.proof.teamId !== undefined) gate(principal, "scorecards:run", { teamId: body.proof.teamId });
      const candidate = body.proof.candidate;
      const owner =
        candidate.type === "agent"
          ? await teamOfEntity(deps.agentRegistry, principal.workspace, candidate.id)
          : await teamOfEntity(deps.harnessInstances, principal.workspace, candidate.id);
      gate(principal, candidate.type === "agent" ? "agents:write" : "harnesses:register", owner);
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
          // The agent that acted, from the same attribution headers every other write reads — an agent
          // drives this door over HTTP too, and a fact without the loop guard's key wakes its own author
          // (arch-review 85). Read ONCE: two calls are two reads of the same request (L1).
          ...(actingAgent !== undefined ? { agent: actingAgent } : {}),
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
      const record = await deps.campaignService.get(principal.workspace, req.params.id);
      // Settling is a WRITE on the campaign, so the gate carries its team — not just the workspace action.
      await assertTeamVisible(deps, principal, record.teamId, "Campaign");
      gate(principal, "scorecards:run", record.teamId !== undefined ? { teamId: record.teamId } : {});
      return reply.send(await deps.campaignService.settle(principal.workspace, req.params.id, principal.subject));
    } catch (err) {
      return sendError(reply, err); // continue/identity_unverified refusals + lost settle races → 409
    }
  });
}
