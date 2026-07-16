import { can } from "@everdict/auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { SecretNameSchema } from "./request/secret-name.js";
import { secretDocs } from "./secret.docs.js";

// secrets (workspace + personal model/provider keys; encrypted at rest, never read back).
export function registerSecretRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- secrets (workspace model/provider key management; values are encrypted at rest + never read back) ---
  // Secret scopes: workspace (shared, admin-managed) + user (personal, self-managed). GET is accessible to any member, but
  // workspace secret names are admin-only (secrets:read), and personal secrets always show only your own.
  app.get("/secrets", { schema: secretDocs.list }, async (req, reply) => {
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

  // Reverse-usage index — each workspace secret + the live sites that reference it (harness env/trace, runtime auth,
  // model api-key, settings integrations). Computed fresh per request, so a removed reference disappears. Admin-only
  // (secrets:read) since it reveals workspace configuration; unused secrets come back with refs=[] (orphans).
  app.get("/secrets/usage", { schema: secretDocs.usage }, async (req, reply) => {
    if (!deps.secretUsageService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "secret usage not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "secrets:read");
      return reply.send(await deps.secretUsageService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A workspace-scope set is admin (secrets:write); a user-scope set is self-serve (no gate, owner=subject).
  app.put<{ Params: { name: string } }>("/secrets/:name", { schema: secretDocs.set }, async (req, reply) => {
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
      // Workspace secrets feed cached runtime backends (secretEnv baked at build) — drop the cache so the next dispatch sees the new value.
      if (body.data.scope === "workspace") deps.invalidateTenantBackends?.(principal.workspace);
      return reply.code(204).send(); // the value is never returned again
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { name: string }; Querystring: { scope?: string } }>(
    "/secrets/:name",
    { schema: secretDocs.remove },
    async (req, reply) => {
      if (!deps.secretStore) return reply.code(404).send({ code: "NOT_FOUND", message: "secret store not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        const owner = req.query.scope === "user" ? principal.subject : "";
        if (req.query.scope !== "user") gate(principal, "secrets:write"); // only shared secrets are admin
        await deps.secretStore.remove(principal.workspace, req.params.name, owner);
        if (req.query.scope !== "user") deps.invalidateTenantBackends?.(principal.workspace);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
