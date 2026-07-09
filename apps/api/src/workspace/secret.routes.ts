import { can } from "@everdict/auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { SecretNameSchema } from "./secret.schema.js";

// secrets (workspace + personal model/provider keys; encrypted at rest, never read back).
export function registerSecretRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- secrets (workspace model/provider key management; values are encrypted at rest + never read back) ---
  // Secret scopes: workspace (shared, admin-managed) + user (personal, self-managed). GET is accessible to any member, but
  // workspace secret names are admin-only (secrets:read), and personal secrets always show only your own.
  app.get("/secrets", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      const metas = await deps.secretStore.list(principal.workspace, principal.subject); // names + scopes only (no values)
      // Only admins see workspace (shared) secret names. Personal (user) secrets always contain only your own, so pass them through.
      const visible = can(principal, "secrets:read") ? metas : metas.filter((m) => m.scope === "user");
      return reply.send(visible);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A workspace-scope set is admin (secrets:write); a user-scope set is self-serve (no gate, owner=subject).
  app.put<{ Params: { name: string } }>("/secrets/:name", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const name = SecretNameSchema.safeParse(req.params.name);
    if (!name.success)
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "secret name must be env format (^[A-Z_][A-Z0-9_]*$)" });
    const body = z
      .object({ value: z.string().min(1), scope: z.enum(["user", "workspace"]).default("workspace") })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const owner = body.data.scope === "user" ? principal.subject : "";
      if (body.data.scope === "workspace") gate(principal, "secrets:write"); // only shared secrets are admin
      await deps.secretStore.set(principal.workspace, name.data, body.data.value, owner);
      return reply.code(204).send(); // the value is never returned again
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { name: string }; Querystring: { scope?: string } }>("/secrets/:name", async (req, reply) => {
    if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      const owner = req.query.scope === "user" ? principal.subject : "";
      if (req.query.scope !== "user") gate(principal, "secrets:write"); // only shared secrets are admin
      await deps.secretStore.remove(principal.workspace, req.params.name, owner);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
