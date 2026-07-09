import { API_KEY_SCOPES } from "@everdict/auth";
import { issueKey } from "@everdict/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// personal API key self-serve (no role gate — personal-owned; a key acts with the issuer's identity/permissions).
export function registerApiKeyRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- personal API key self-serve (no role gate — personal-owned. A key acts with the issuer's identity·permissions) ---
  // Self-scoped like connections·personal secrets: each user sees/issues/revokes only their own (subject) keys.
  app.get("/keys", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "key store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deps.keyStore.list(principal.workspace, principal.subject)); // only my key metadata (no plaintext/hash)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/keys", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "key store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ label: z.string().max(80).optional(), scopes: z.array(z.enum(API_KEY_SCOPES)).nonempty().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      // scope unset = the issuer's role as-is (Full Access within role). If specified, narrow to that scope (never exceeds the role).
      const scopes = body.data.scopes ?? ["admin"];
      // owner = the issuer subject → this key acts with the issuer's permissions (a member key = member perms).
      const apiKey = await issueKey(deps.keyStore, principal.workspace, body.data.label, scopes, principal.subject);
      return reply.code(201).send({ apiKey }); // the plaintext is returned only once here
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/keys/:id", async (req, reply) => {
    if (!deps.keyStore) return reply.code(404).send({ code: "NOT_FOUND", message: "key store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Revoke only my (subject) keys — someone else's key / a machine key (owner="") is a no-op (always 204, no existence leak).
      await deps.keyStore.revoke(principal.workspace, req.params.id, principal.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
