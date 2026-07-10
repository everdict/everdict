import { UpsertCiLinkBodySchema } from "@everdict/application-control";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { baseUrl } from "../route-context.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { ciLinkDocs } from "./ci-link.docs.js";

// CI repo links (repository ↔ harness slot = GitHub Actions OIDC trust policy) + the setup-PR generator.
export function registerCiLinkRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- CI repo links (repository ↔ harness slot mapping = GitHub Actions OIDC trust policy) ---
  // Read is harnesses:read (benign metadata exposed on the harness detail), create/delete is settings:write (link = granting trust — admin).
  app.get("/workspace/ci/links", { schema: ciLinkDocs.list }, async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send({ links: await deps.ciLinkService.list(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/ci/links", { schema: ciLinkDocs.upsert }, async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = UpsertCiLinkBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write"); // a link's existence = trusting that repo's OIDC token (trust grant) → admin
      return reply.send({ links: await deps.ciLinkService.upsert(principal.workspace, principal.subject, body.data) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // repository is "owner/name" (contains a slash) — taken as a query rather than a path parameter. host unset = github.com link.
  app.delete<{ Querystring: { repository?: string; host?: string } }>(
    "/workspace/ci/links",
    { schema: ciLinkDocs.remove },
    async (req, reply) => {
      if (!deps.ciLinkService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      if (!req.query.repository)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "repository query parameter is required." });
      try {
        gate(principal, "settings:write");
        return reply.send({
          links: await deps.ciLinkService.remove(principal.workspace, req.query.repository, req.query.host),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // setup-PR — synthesize the link's workflow YAML and open a branch+commit+PR on the target repo (workspace GitHub App token).
  // Since the link already granted trust, this is harnesses:read (the PR still needs merge approval on GitHub — not a run permission).
  app.post("/workspace/ci/links/setup-pr", { schema: ciLinkDocs.setupPr }, async (req, reply) => {
    if (!deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ repository: z.string().min(1), host: z.string().url().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:read");
      return reply.send(
        await deps.ciLinkService.openSetupPr(principal.workspace, body.data.repository, {
          ...(body.data.host !== undefined ? { host: body.data.host } : {}),
          requestBaseUrl: baseUrl(req),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // missing link 404 / zero shared runners 400 (D6 fail-closed) / App not installed 404 / GitHub failure 502
    }
  });

  // GitHub Actions runner self-registration — in one admin action, generate an install script that stands up both a GitHub runner and an
  // Everdict workspace-shared runner on the build server (design doc §4). Newly pairs a workspace-shared runner (rnr_ once) + mints a registration
}
