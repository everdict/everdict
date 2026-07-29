import { grantFromBasicAuth, scopeValues } from "@everdict/images";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, sendError } from "../route-context.js";
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
}
