import { grantFromBasicAuth, scopeValues } from "@everdict/images";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { imagesDocs } from "./images.docs.js";

// The managed image store's HTTP surface. Design: docs/architecture/managed-image-store.md
export function registerImagesRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // The Docker Registry v2 auth realm. NOT part of the Principal chain: the caller is a docker client (or a
  // containerd/kaniko puller), it has never heard of our Bearer tokens, and it authenticates with the grant it was
  // given — possession of a signed, scoped, short-lived grant IS the permission. Everything this route can issue is
  // bounded by that grant, so there is nothing here for an unauthenticated caller to reach.
  app.get<{ Querystring: { scope?: string | string[]; service?: string } }>(
    "/v2/token",
    { schema: imagesDocs.token },
    async (req, reply) => {
      if (!deps.imageTokenService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "managed image store not configured" });
      try {
        const exchange = await deps.imageTokenService.exchange({
          credential: grantFromBasicAuth(req.headers.authorization),
          scopes: scopeValues(req.query.scope),
          ...(req.query.service ? { service: req.query.service } : {}),
        });
        // `token` is what distribution reads; `access_token` is the OAuth2 spelling other clients look for.
        // Both carry the same value — a client that understands either one works without a second exchange.
        return reply.send({
          token: exchange.token,
          access_token: exchange.token,
          expires_in: exchange.expiresIn,
          issued_at: exchange.issuedAt,
        });
      } catch (err) {
        // The WWW-Authenticate header is what makes a docker client re-prompt for credentials instead of
        // reporting an opaque failure — the realm it should retry against is this endpoint.
        reply.header("www-authenticate", `Basic realm="everdict image registry"`);
        return sendError(reply, err);
      }
    },
  );

  // Mint a push authorization for one repository in the caller's namespace (`everdict image push`). images:push is
  // the same member-gated action the BYO path uses — it is the one action whose response IS a usable credential,
  // which is why it was named separately in the first place. The repository is created by the first push.
  app.post("/workspace/images/push-grant", { schema: imagesDocs.pushGrant }, async (req, reply) => {
    if (!deps.images) return reply.code(404).send({ code: "NOT_FOUND", message: "managed image store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ repository: z.string().min(1) }).safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "repository is required", data: zodIssues(body.error) });
    try {
      gate(principal, "images:push");
      const grant = await deps.images.mintPushGrant(principal.workspace, body.data.repository);
      return reply.send({
        grant,
        imagePrefix: `${deps.images.endpoint}/${deps.images.namespaceFor(principal.workspace)}/`,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The workspace's managed repositories — what Settings › Images lists. Read-gated with harnesses:read, the
  // same action the BYO catalog uses: knowing which images a workspace published is provenance, not a credential.
  // Usage rides along because the panel renders both in one header (see ImageCatalogResponseSchema).
  app.get("/workspace/images", { schema: imagesDocs.catalog }, async (req, reply) => {
    if (!deps.images) return reply.code(404).send({ code: "NOT_FOUND", message: "managed image store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const [repositories, usage] = await Promise.all([
        deps.images.listRepositories(principal.workspace),
        deps.images.usage(principal.workspace),
      ]);
      return reply.send({
        endpoint: deps.images.endpoint,
        namespace: deps.images.namespaceFor(principal.workspace),
        repositories,
        usage,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Tags of ONE repository. Separate from the catalog by design: resolving tags is a registry call per
  // repository, so the listing stays one call and the drill-in pays for what it opens.
  app.get<{ Params: { repository: string } }>(
    "/workspace/images/:repository/tags",
    { schema: imagesDocs.tags },
    async (req, reply) => {
      if (!deps.images)
        return reply.code(404).send({ code: "NOT_FOUND", message: "managed image store not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "harnesses:read");
        const tags = await deps.images.listTags(principal.workspace, req.params.repository);
        return reply.send({ repository: req.params.repository, tags });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Unpublish a repository from the caller's namespace. Gated with images:push, not settings:write: this is the
  // inverse of publishing, and the member who may push their workspace's images is the one who may retract them —
  // routing cleanup through an admin would leave authors unable to undo their own mistakes.
  app.delete<{ Params: { repository: string } }>(
    "/workspace/images/:repository",
    { schema: imagesDocs.remove },
    async (req, reply) => {
      if (!deps.images)
        return reply.code(404).send({ code: "NOT_FOUND", message: "managed image store not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "images:push");
        const removed = await deps.images.remove(principal.workspace, req.params.repository);
        return reply.send({ repository: req.params.repository, removed });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Manifest of a reference in the caller's namespace — the authoritative digest a just-pushed image should be
  // pinned by. Read-gated with harnesses:read like the BYO inspect: a manifest summary is provenance, not a credential.
  app.get<{ Querystring: { repository?: string; reference?: string } }>(
    "/workspace/images/manifest",
    { schema: imagesDocs.manifest },
    async (req, reply) => {
      if (!deps.images)
        return reply.code(404).send({ code: "NOT_FOUND", message: "managed image store not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { repository, reference } = req.query;
      if (!repository || !reference)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "repository and reference are required" });
      try {
        gate(principal, "harnesses:read");
        return reply.send(await deps.images.inspect(principal.workspace, repository, reference));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
