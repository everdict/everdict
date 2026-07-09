import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { mattermostDocs } from "./mattermost.docs.js";

// workspace-owned Mattermost integration (bot notifications) + the public inbound surface (slash commands / interactive buttons, constant-time commandToken check).
export function registerMattermostRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspace-owned Mattermost integration (replaces personal-connection notifications) — post completion/regression notifications to a channel via a bot token ---
  // Read settings:read / register·unregister settings:write. The bot token value lives only in the SecretStore (here it's a name reference only).
  app.get("/workspace/mattermost", { schema: mattermostDocs.status }, async (req, reply) => {
    if (!deps.mattermostService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      const config = await deps.mattermostService.get(principal.workspace);
      return reply.send({ ...(config ? { config } : {}) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/mattermost", { schema: mattermostDocs.upsert }, async (req, reply) => {
    if (!deps.mattermostService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        host: z.string().url(),
        botTokenSecretName: z.string().min(1),
        defaultChannelId: z.string().min(1).optional(),
        commandTokenSecretName: z.string().min(1).optional(), // SecretStore name of the inbound (slash command/button) verification token
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const config = await deps.mattermostService.set(principal.workspace, {
        host: body.data.host,
        botTokenSecretName: body.data.botTokenSecretName,
        ...(body.data.defaultChannelId !== undefined ? { defaultChannelId: body.data.defaultChannelId } : {}),
        ...(body.data.commandTokenSecretName !== undefined
          ? { commandTokenSecretName: body.data.commandTokenSecretName }
          : {}),
      });
      return reply.send({ config });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/mattermost", { schema: mattermostDocs.remove }, async (req, reply) => {
    if (!deps.mattermostService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      await deps.mattermostService.clear(principal.workspace);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
  // --- Mattermost inbound (slash commands + interactive buttons) — public route. Workspace = ?ws=, authenticity = constant-time commandToken check (fail-closed) ---
  // MM calls this directly (not a user session). Verification failure is ForbiddenError→403. Slash commands are form-urlencoded, button actions are JSON.
  app.post<{ Querystring: { ws?: string } }>(
    "/integrations/mattermost/command",
    { schema: mattermostDocs.command },
    async (req, reply) => {
      if (!deps.mattermostCommandService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost inbound not configured" });
      const ws = req.query.ws;
      if (!ws) return reply.code(400).send({ code: "BAD_REQUEST", message: "ws query is required" });
      const body = z
        .object({ token: z.string().optional(), text: z.string().optional(), user_name: z.string().optional() })
        .safeParse(req.body ?? {});
      if (!body.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
      try {
        const out = await deps.mattermostCommandService.handleCommand(ws, {
          ...(body.data.token !== undefined ? { token: body.data.token } : {}),
          ...(body.data.text !== undefined ? { text: body.data.text } : {}),
          ...(body.data.user_name !== undefined ? { userName: body.data.user_name } : {}),
        });
        return reply.send(out); // { response_type, text } rendered by Mattermost
      } catch (err) {
        return sendError(reply, err); // verification failure → 403
      }
    },
  );

  app.post<{ Querystring: { ws?: string } }>(
    "/integrations/mattermost/action",
    { schema: mattermostDocs.action },
    async (req, reply) => {
      if (!deps.mattermostCommandService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "mattermost inbound not configured" });
      const ws = req.query.ws;
      if (!ws) return reply.code(400).send({ code: "BAD_REQUEST", message: "ws query is required" });
      // An MM interactive action echoes back the context we embedded (token/action/dataset/harness). The verification token is context.token.
      const body = z
        .object({
          context: z
            .object({
              token: z.string().optional(),
              action: z.string().optional(),
              dataset: z.string().optional(),
              harness: z.string().optional(),
              userName: z.string().optional(),
            })
            .optional(),
        })
        .safeParse(req.body ?? {});
      if (!body.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
      const c = body.data.context ?? {};
      try {
        const out = await deps.mattermostCommandService.handleAction(ws, {
          ...(c.token !== undefined ? { token: c.token } : {}),
          ...(c.action !== undefined ? { action: c.action } : {}),
          context: {
            ...(c.dataset !== undefined ? { dataset: c.dataset } : {}),
            ...(c.harness !== undefined ? { harness: c.harness } : {}),
            ...(c.userName !== undefined ? { userName: c.userName } : {}),
          },
        });
        return reply.send(out);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
