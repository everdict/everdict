import type { ChatMessage, PermissionHook } from "@everdict/agent-runtime";
import type { AgentSessionRecord } from "@everdict/contracts";
import { AgentReferenceSchema, AppError } from "@everdict/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type ChatDeps, DEFAULT_SESSION_TITLE, runChat } from "./chat.js";
import { InputQueue } from "./input-queue.js";
import { PermissionRegistry } from "./permission-registry.js";
import type { Authenticate, ForwardHeaders, Principal } from "./principal.js";
import { runSkillTry } from "./skill-try.js";

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
  // Unexpected (non-AppError) failure — log to stderr since the Fastify logger is off, so operators can see it.
  console.error("[agent] unhandled error:", err);
  reply.code(500).send({ code: "INTERNAL_ERROR", message: "Internal error" });
  return reply;
}

const idParams = z.object({ id: z.string().min(1) });

// A chat attachment as sent by the web: metadata + the read text `content` (content is folded into the model
// context, not persisted).
const attachmentInputSchema = z.object({
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  content: z.string().optional(),
});

export function buildServer(deps: AgentServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  // Human-in-the-loop approvals: a write-tool call in an SSE turn parks here until POST /permission resolves it.
  const permissions = new PermissionRegistry();
  // Mid-run steering: POST /input queues a user message the streaming turn's loop drains at the next turn boundary.
  const inputQueue = new InputQueue();

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
    const body = z
      .object({ title: z.string().optional(), model: z.string().min(1).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const now = deps.now();
    const record: AgentSessionRecord = {
      id: deps.newId(),
      tenant: principal.workspace,
      owner: principal.subject,
      title: body.data.title && body.data.title.length > 0 ? body.data.title : DEFAULT_SESSION_TITLE,
      ...(body.data.model !== undefined ? { model: body.data.model } : {}),
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

  app.patch("/agent/sessions/:id", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        // A registered model id pins this conversation's model; null clears the override (→ workspace/server default).
        model: z.string().min(1).nullable().optional(),
      })
      .refine((b) => b.title !== undefined || b.model !== undefined, { message: "Nothing to update." })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const now = deps.now();
    if (body.data.title !== undefined) await deps.sessions.touchSession(principal.workspace, id, now, body.data.title);
    if (body.data.model !== undefined)
      await deps.sessions.setSessionModel(principal.workspace, id, body.data.model, now);
    // Return the fresh persisted record — the single source of truth after the write(s).
    const fresh = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    return reply.send(fresh ?? session);
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
    const body = z
      .object({
        message: z.string().min(1),
        references: z.array(AgentReferenceSchema).optional(),
        attachments: z.array(attachmentInputSchema).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    // Client disconnect (the web's Stop button aborts the fetch) → abort the loop mid-turn. Fires harmlessly on
    // normal completion too (the loop has already finished by then).
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
    const headers = forwardHeaders(req);
    const { message, references, attachments } = body.data;

    const drainInput = (): ChatMessage[] => inputQueue.drain(principal.workspace, id);

    // Non-streaming clients (tests / API callers) get the buffered JSON tail.
    if (!(req.headers.accept ?? "").includes("text/event-stream")) {
      try {
        const result = await runChat(
          deps,
          principal,
          headers,
          id,
          message,
          references,
          attachments,
          controller.signal,
          {
            drainInput,
          },
        );
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    }

    // SSE: stream the loop's text deltas + each persisted message record live, then a terminal `done`.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // HITL: a write tool call parks here — emit a `permission` ask (with a fresh id) and await the human's POST. A
    // client disconnect or timeout resolves to "deny" (the registry's safe default).
    const permit: PermissionHook = (request) => {
      const requestId = deps.newId();
      write("permission", { requestId, name: request.name, input: request.input });
      return permissions.wait(requestId, id, controller.signal);
    };
    try {
      await runChat(deps, principal, headers, id, message, references, attachments, controller.signal, {
        onEvent: (e) => {
          if (e.type === "text_delta") write("delta", { text: e.delta });
          // The post-decision event: forward it so the web dismisses the prompt even when the decision was the
          // registry's timeout/disconnect default rather than a click.
          else if (e.type === "permission") write("permission_resolved", { name: e.name, decision: e.decision });
        },
        onRecord: (r) => write("message", r),
        permit,
        drainInput,
      });
      write("done", {});
    } catch (err) {
      write("error", { message: err instanceof AppError ? err.message : "Internal error" });
    } finally {
      reply.raw.end();
    }
  });

  // HITL decision: resolve a parked write-tool approval the SSE turn is awaiting. Scoped to the session owner + the
  // request id, so a stale or cross-session id can't approve someone else's tool call.
  app.post("/agent/sessions/:id/permission", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const parsed = z.object({ requestId: z.string().min(1), decision: z.enum(["allow", "deny"]) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const ok = permissions.respond(parsed.data.requestId, id, parsed.data.decision);
    if (!ok) return reply.code(404).send({ code: "NOT_FOUND", message: "No pending approval for that request." });
    return reply.send({ ok: true });
  });

  // Mid-run steering: queue a user message for an in-flight streaming turn of this session. The running loop drains it
  // at its next turn boundary (no restart). If nothing is running the message simply waits; the web only posts while a
  // turn streams, otherwise it starts a normal /chat turn. Scoped to the session owner.
  app.post("/agent/sessions/:id/input", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const parsed = z.object({ message: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    inputQueue.enqueue(principal.workspace, id, parsed.data.message);
    return reply.code(202).send({ queued: true });
  });

  // Skill test-drive — run a stateless agent turn with just this (possibly unsaved) skill + the read-only tools, and
  // return the transcript so the member can verify the skill actually drives the agent before saving it.
  app.post("/agent/skills/try", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const body = z
      .object({
        skill: z.object({
          name: z.string().min(1),
          description: z.string(),
          instructions: z.string().min(1),
        }),
        message: z.string().min(1),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
    try {
      const result = await runSkillTry(
        deps,
        principal,
        forwardHeaders(req),
        body.data.skill,
        body.data.message,
        controller.signal,
      );
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return app;
}
