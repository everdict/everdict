import type { AgentSessionRecord } from "@everdict/contracts";
import { AppError } from "@everdict/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type ChatDeps, DEFAULT_SESSION_TITLE, runChat } from "./chat.js";
import type { Authenticate, ForwardHeaders, Principal } from "./principal.js";

export interface AgentServerDeps extends ChatDeps {
  authenticate: Authenticate;
}

function forwardHeaders(req: FastifyRequest): ForwardHeaders {
  const h = req.headers;
  const authorization = typeof h.authorization === "string" ? h.authorization : undefined;
  const workspace = typeof h["x-everdict-workspace"] === "string" ? h["x-everdict-workspace"] : undefined;
  const tenant = typeof h["x-everdict-tenant"] === "string" ? h["x-everdict-tenant"] : undefined;
  return {
    ...(authorization ? { authorization } : {}),
    ...(workspace ? { workspace } : {}),
    ...(tenant ? { tenant } : {}),
  };
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) {
    reply.code(err.status).send(err.toEnvelope());
    return reply;
  }
  reply.log.error(err);
  reply.code(500).send({ code: "INTERNAL_ERROR", message: "Internal error" });
  return reply;
}

const idParams = z.object({ id: z.string().min(1) });

export function buildServer(deps: AgentServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  // Resolve the caller to a workspace-scoped Principal via the control plane, or reply with the mapped error.
  const principalOf = async (req: FastifyRequest, reply: FastifyReply): Promise<Principal | undefined> => {
    try {
      return await deps.authenticate(forwardHeaders(req));
    } catch (err) {
      sendError(reply, err);
      return undefined;
    }
  };

  app.post("/agent/sessions", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const body = z.object({ title: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const now = deps.now();
    const record: AgentSessionRecord = {
      id: deps.newId(),
      tenant: principal.workspace,
      owner: principal.subject,
      title: body.data.title && body.data.title.length > 0 ? body.data.title : DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
    };
    await deps.sessions.createSession(record);
    return reply.code(201).send(record);
  });

  app.get("/agent/sessions", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const sessions = await deps.sessions.listSessions(principal.workspace, principal.subject);
    return reply.send({ sessions });
  });

  app.get("/agent/sessions/:id", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    return reply.send(session);
  });

  app.delete("/agent/sessions/:id", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    await deps.sessions.deleteSession(principal.workspace, principal.subject, id);
    return reply.code(204).send();
  });

  app.get("/agent/sessions/:id/messages", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const query = z.object({ since: z.coerce.number().int().nonnegative().optional() }).parse(req.query);
    const messages = await deps.sessions.listMessages(principal.workspace, id, query.since);
    return reply.send({ messages });
  });

  app.post("/agent/sessions/:id/chat", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const body = z.object({ message: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const result = await runChat(deps, principal, forwardHeaders(req), id, body.data.message);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return app;
}
