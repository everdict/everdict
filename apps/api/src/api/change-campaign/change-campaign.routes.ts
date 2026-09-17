import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { changeCampaignDocs } from "./change-campaign.docs.js";
import {
  CloseChangeCampaignBodySchema,
  LogChangeRoundBodySchema,
  OpenChangeCampaignBodySchema,
} from "./request/change-campaign-requests.js";

// The `change` grade of campaign (docs/architecture/change-campaign-spec.md) — the HTTP half of the slice;
// `change-campaign.mcp.ts` is the other, and both call the same service functions.
//
// ⚠️ Bodies are `safeParse`d, never `.parse()`d. `sendError` maps an `AppError` to its own status and
// EVERYTHING ELSE to 500, so a raw `ZodError` thrown out of `.parse()` reports the caller's malformed body as
// our internal failure — a 500 tells a client to retry and tells us to go looking for an outage, and neither
// is true. These four handlers did exactly that until a counterexample sent an answer with no `reason` and
// got `500 INTERNAL` where 400 was the whole point.
export function registerChangeCampaignRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const service = () => deps.changeCampaignService;

  app.post("/change-campaigns", { schema: changeCampaignDocs.open }, async (req, reply) => {
    const svc = service();
    if (!svc) return reply.code(404).send({ code: "NOT_FOUND", message: "change campaign service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
      const parsed = OpenChangeCampaignBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      const body = parsed.data;
      return reply.code(201).send(await svc.open(principal.workspace, principal.subject, body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/change-campaigns/:id/rounds",
    { schema: changeCampaignDocs.round },
    async (req, reply) => {
      const svc = service();
      if (!svc) return reply.code(404).send({ code: "NOT_FOUND", message: "change campaign service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:run");
        const parsed = LogChangeRoundBodySchema.safeParse(req.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
        const body = parsed.data;
        const { record, round } = await svc.logRound(principal.workspace, principal.subject, req.params.id, body);
        return reply.code(201).send({ campaign: record, round });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/change-campaigns/:id/close",
    { schema: changeCampaignDocs.close },
    async (req, reply) => {
      const svc = service();
      if (!svc) return reply.code(404).send({ code: "NOT_FOUND", message: "change campaign service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:run");
        const parsed = CloseChangeCampaignBodySchema.safeParse(req.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
        const body = parsed.data;
        return reply.send(await svc.close(principal.workspace, principal.subject, req.params.id, body));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/change-campaigns/:id",
    { schema: changeCampaignDocs.get },
    async (req, reply) => {
      const svc = service();
      if (!svc) return reply.code(404).send({ code: "NOT_FOUND", message: "change campaign service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
        return reply.send(await svc.get(principal.workspace, req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Querystring: { issueId?: string; limit?: string } }>(
    "/change-campaigns",
    { schema: changeCampaignDocs.list },
    async (req, reply) => {
      const svc = service();
      if (!svc) return reply.code(404).send({ code: "NOT_FOUND", message: "change campaign service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
        const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
        return reply.send(
          await svc.list(principal.workspace, {
            ...(req.query.issueId !== undefined ? { issueId: req.query.issueId } : {}),
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
