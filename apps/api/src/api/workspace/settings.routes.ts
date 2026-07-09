import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { WorkspaceSettingsBodySchema } from "./request/workspace-settings.js";
import { settingsDocs } from "./settings.docs.js";

// workspace settings (metering policy, default judge, notify target; admin only).
export function registerWorkspaceSettingsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspace settings (metering policy, etc.; admin only) ---
  app.get("/workspace/settings", { schema: settingsDocs.get }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "settings store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      return reply.send((await deps.settingsStore.get(principal.workspace)) ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/settings", { schema: settingsDocs.put }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "settings store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = WorkspaceSettingsBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "settings:write");
      // The notify target points at a personal-owned connection, so the server stamps the setter (subject) as ownerSubject (the client can't send it → anti-spoofing).
      const patch = body.data.notify
        ? { ...body.data, notify: { ...body.data.notify, ownerSubject: principal.subject } }
        : body.data;
      return reply.send(await deps.settingsStore.set(principal.workspace, patch)); // return the merged settings
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
