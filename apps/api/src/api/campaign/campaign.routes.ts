import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { campaignDocs } from "./campaign.docs.js";
import { AdoptCampaignBodySchema } from "./request/adopt-campaign.js";
import { BuildCampaignBodySchema } from "./request/build-campaign.js";
import { CampaignSubjectQuerySchema } from "./request/list-campaigns.js";
import { LogCampaignRoundBodySchema } from "./request/log-campaign-round.js";
import { MergeCampaignBodySchema } from "./request/merge-campaign.js";
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
      // A campaign journals into an issue, so the issue is READ before the campaign opens — a campaign
      // against an issue that is not there is a campaign about nothing, and the service would fail the same
      // way, later and with a worse message.
      // ⚠️ NOT `deps.issueService?.get(...)`: a `?.` here would make the read evaporate when the tracker is
      // absent and open the campaign anyway, against nothing. If the service is not wired, refuse.
      if (!deps.issueService)
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "issue service not configured — a campaign's issue cannot be resolved",
        });
      const issue = await deps.issueService.get(principal.workspace, body.issueId);
      if (issue === undefined) return reply.code(404).send({ code: "NOT_FOUND", message: "issue not found" });
      gate(principal, "scorecards:run");
      return reply.code(201).send(await deps.campaignService.open(principal.workspace, { ...body }, principal.subject));
    } catch (err) {
      return sendError(reply, err); // unknown issue → 404
    }
  });

  app.get<{ Querystring: { subjectType?: string; subjectId?: string } }>(
    "/campaigns",
    { schema: campaignDocs.list },
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
      // `subjectType` + `subjectId` = one capability's evolution memory (evolution-routing-spec.md §5). Both or
      // neither: a type without an id (or the reverse) names nothing and is refused rather than read as "all".
      const subject = CampaignSubjectQuerySchema.safeParse(req.query);
      if (!subject.success) return reply.code(400).send({ code: "BAD_REQUEST", message: subject.error.message });
      return reply.send(await deps.campaignService.list(principal.workspace, subject.data));
    },
  );

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
      // ONE read, and it is the row returned (arch-review 83): a door that reads once to check and once to
      // answer has passed its check on a value the caller never receives. `get` is tenant-scoped, so another
      // workspace's id is the same 404 an absent one gets and the surface leaks no existence.
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
      let body: z.infer<typeof LogCampaignRoundBodySchema>;
      try {
        body = LogCampaignRoundBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        gate(principal, "scorecards:run");
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
    // The agent that acted, read ONCE from the request — two calls are two reads of the same headers (L1).
    const actingAgent = agentAttributionFrom(req.headers);
    let body: z.infer<typeof AdoptCampaignBodySchema>;
    try {
      body = AdoptCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      // ⚠️ NOT `deps.campaignService?.get(...)` (arch-review 78). A capability a protocol depends on is
      // REQUIRED at the deciding seam, or its absence is a NAMED outcome — an optional call turns "we cannot
      // read the campaign" into "there was nothing to check". An adoption cannot be spent against a campaign
      // nobody can read.
      if (!deps.campaignService)
        return reply
          .code(404)
          .send({ code: "NOT_FOUND", message: "campaign service not configured — an adoption cannot be authorized" });
      gate(principal, "scorecards:run");
      const candidate = body.proof.candidate;
      // THREE subject types, three registries, three actions (harness-definability-spec.md §2). This was
      // `agent ? … : harness`, so an environment candidate would have had its owner read from — and its
      // write authorized against — the HARNESS registry, which is the "a new lane inherits every constraint"
      // failure rule `protocol` names. The registry that answers here is the one the effect writes through.
      const action = { agent: "agents:write", environment: "datasets:write", harness: "harnesses:register" } as const;
      gate(principal, action[candidate.type]);
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

  // ── BUILD THE CANDIDATE, INTO EVERDICT'S OWN STORE (docs/architecture/code-evolution-loop.md, D2) ──
  //
  // A build session boots the harness slot's base image, checks out the commit, runs the template's frozen
  // build steps, and publishes the result as one layer in the managed registry — Everdict builds it, no outside
  // CI. Gated like a re-pin — the harness family's write action — because the build mints a new harness
  // instance version. The heavy work runs in the BACKGROUND after the record is created;
  // the caller gets the `building` record and waits on `campaign.candidate_built`.
  app.post<{ Params: { id: string } }>("/campaigns/:id/builds", { schema: campaignDocs.build }, async (req, reply) => {
    if (!deps.campaignBuild || !deps.campaignService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign build is not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof BuildCampaignBodySchema>;
    try {
      body = BuildCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      gate(principal, "scorecards:run");
      // Minting the candidate version is a harness register, so the harness family's write action is required
      // too — a build is a re-pin that also compiles.
      gate(principal, "harnesses:register");
      const build = deps.campaignBuild;
      // A build SET (evolution-routing-spec.md §4): every slot from one head, one minted version.
      if (body.slots !== undefined) {
        const set = await build.startSet(
          principal.workspace,
          {
            campaignId: req.params.id,
            ref: body.ref,
            ...(body.repo !== undefined ? { repo: body.repo } : {}),
            ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
            slots: body.slots,
          },
          principal.subject,
        );
        void build.runSet(principal.workspace, set.id).catch(() => undefined);
        return reply.code(202).send(set);
      }
      const record = await build.start(
        principal.workspace,
        {
          campaignId: req.params.id,
          ref: body.ref,
          ...(body.repo !== undefined ? { repo: body.repo } : {}),
          ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
          ...(body.slot !== undefined ? { slot: body.slot } : {}),
        },
        principal.subject,
      );
      void build.run(principal.workspace, record.id).catch(() => undefined);
      return reply.code(202).send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── THE NEXT ROUND'S HANDOFF, SO A DELEGATION IS A CONTRACT AND NOT A PARAGRAPH ───────────────────
  //
  // The read an agent makes before it opens a sandbox: `GET /campaigns/:id/brief` → `create_sandbox({profile,
  // brief})`. Same action as every other campaign read (`scorecards:read`) — a brief names what the platform
  // already served through the evidence and campaign doors, arranged for a delegate, so it grants nothing new.
  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/brief",
    { schema: campaignDocs.roundBrief },
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
        return reply.send(await deps.campaignService.roundBrief(principal.workspace, req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── THE EVIDENCE A ROUND SEALED (docs/architecture/benchmark-evidence-spec.md §3) ──────────────────
  app.get<{ Params: { id: string; seq: string } }>(
    "/campaigns/:id/rounds/:seq/evidence",
    { schema: campaignDocs.roundEvidence },
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
      const seq = Number(req.params.seq);
      if (!Number.isInteger(seq) || seq < 1)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "seq must be a positive integer." });
      try {
        return reply.send(await deps.campaignService.roundEvidence(principal.workspace, req.params.id, seq));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // The build SETS of a campaign (evolution-routing-spec.md §4) — each: its members, the one version it minted.
  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/build-sets",
    { schema: campaignDocs.buildSets },
    async (req, reply) => {
      if (!deps.campaignBuild || !deps.campaignService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "campaign build is not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        // The campaign is READ so an id from another workspace is a 404: the build reads below are
        // tenant-scoped in the store, so they answer an EMPTY LIST rather than refusing, and an empty list is
        // indistinguishable from a campaign that has simply built nothing.
        await deps.campaignService.get(principal.workspace, req.params.id);
        return reply.send(await deps.campaignBuild.setsForCampaign(principal.workspace, req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/campaigns/:id/builds", { schema: campaignDocs.builds }, async (req, reply) => {
    if (!deps.campaignBuild || !deps.campaignService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign build is not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      // The campaign is READ so an id from another workspace is a 404: the build reads below are
      // tenant-scoped in the store, so they answer an EMPTY LIST rather than refusing, and an empty list is
      // indistinguishable from a campaign that has simply built nothing.
      await deps.campaignService.get(principal.workspace, req.params.id);
      return reply.send(await deps.campaignBuild.forCampaign(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── PAY THE CODE DEBT (docs/architecture/code-evolution-loop.md, D5) ─────────────────────────────
  //
  // The other half of `adopt`: the pull request the adopted bytes were built from lands on the default branch.
  // Gated exactly like adopt — the candidate family's write action — because it is the same authorization
  // being spent on its second effect. The repository and
  // pull request are read off the STORED operation by the service; the body carries only the proof.
  app.post<{ Params: { id: string } }>("/campaigns/:id/merge", { schema: campaignDocs.merge }, async (req, reply) => {
    if (!deps.campaignAdoption)
      return reply.code(404).send({ code: "NOT_FOUND", message: "campaign adoption not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    const actingAgent = agentAttributionFrom(req.headers);
    let body: z.infer<typeof MergeCampaignBodySchema>;
    try {
      body = MergeCampaignBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      if (!deps.campaignService)
        return reply
          .code(404)
          .send({ code: "NOT_FOUND", message: "campaign service not configured — a merge cannot be authorized" });
      gate(principal, "scorecards:run");
      const candidate = body.proof.candidate;
      // THREE subject types, three registries, three actions (harness-definability-spec.md §2). This was
      // `agent ? … : harness`, so an environment candidate would have had its owner read from — and its
      // write authorized against — the HARNESS registry, which is the "a new lane inherits every constraint"
      // failure rule `protocol` names. The registry that answers here is the one the effect writes through.
      const action = { agent: "agents:write", environment: "datasets:write", harness: "harnesses:register" } as const;
      gate(principal, action[candidate.type]);
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(
        await deps.campaignAdoption.merge({
          tenant: principal.workspace,
          campaignId: req.params.id,
          proof: body.proof,
          by: principal.subject,
          via: "web",
          ...(actingAgent !== undefined ? { agent: actingAgent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // no authorization → 404 · forged proof / unregistered / no debt → 409
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
      gate(principal, "scorecards:run");
      return reply.send(await deps.campaignService.settle(principal.workspace, req.params.id, principal.subject));
    } catch (err) {
      return sendError(reply, err); // continue/identity_unverified refusals + lost settle races → 409
    }
  });
}
