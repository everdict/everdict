import type { ChatMessage, PermissionDecision, PermissionHook } from "@everdict/agent-runtime";
import type { TenantKeyStore } from "@everdict/application-control";
import type { AgentSessionRecord } from "@everdict/contracts";
import { AgentReferenceSchema, AppError } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentMailbox } from "./agent-mailbox.js";
import { type ChatDeps, DEFAULT_SESSION_TITLE, runChat } from "./chat.js";
import { PermissionRegistry } from "./permission-registry.js";
import { PermissionRules } from "./permission-rules.js";
import type { Authenticate, ForwardHeaders, Principal } from "./principal.js";
import { runSkillTry } from "./skill-try.js";
import { TeammateSupervisor } from "./teammate-supervisor.js";
import { runTeammateTurn } from "./teammate-turn.js";

export interface AgentServerDeps extends ChatDeps {
  authenticate: Authenticate;
  // Tenant key store — needed to issue a teammate's agt_ execution token (S3). Absent (no DB) → teammate spawn is 404.
  keyStore?: TenantKeyStore;
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
  // The message substrate (agent-teams.md S1): a per-session mailbox the streaming turn drains at each turn boundary.
  // POST /input delivers a user steering message; POST /event delivers a platform event (both absorbed mid-run).
  const mailbox = new AgentMailbox();
  // Fine-grained "always allow / deny this tool" rules (per session) that short-circuit the HITL prompt.
  const rules = new PermissionRules();
  // S3 teammates — long-lived agents the supervisor wakes when a message lands in their mailbox; each runs a
  // request-less turn authenticated by its own agt_ token (runTeammateTurn). Turns are serialized per teammate.
  const teammateTokens = new Map<string, { token: string; keyId: string }>(); // sessionId → its agt_ token + key id (for revoke)
  const supervisor = new TeammateSupervisor(async (sessionId) => {
    const entry = teammateTokens.get(sessionId);
    if (entry) await runTeammateTurn(deps, deps.authenticate, mailbox, sessionId, entry.token);
  });
  // Deliver to a session's mailbox and, if it is a teammate, wake it to process the message (no-op for plain sessions).
  const deliver = (workspace: string, sessionId: string, envelope: Parameters<AgentMailbox["enqueue"]>[2]): void => {
    mailbox.enqueue(workspace, sessionId, envelope);
    if (supervisor.isTeammate(sessionId)) supervisor.wake(sessionId);
  };
  // Spawn a persistent teammate for a principal: mint its execution token (acts AS the creator), create its session,
  // register it with the supervisor, seed the standing task, and wake it. Shared by POST /teammates AND the
  // spawn_teammate agent tool (so an agent, not just the web, spawns teammates). No key store → soft error.
  const spawnTeammateFor = async (
    principal: Principal,
    name: string,
    task: string,
  ): Promise<{ id: string } | { error: string }> => {
    if (!deps.keyStore) return { error: "Teammate execution tokens are not configured." };
    const now = deps.now();
    const sessionId = deps.newId();
    await deps.sessions.createSession({
      id: sessionId,
      tenant: principal.workspace,
      owner: principal.subject,
      title: name,
      createdAt: now,
      updatedAt: now,
    });
    const { token, id: keyId } = await issueAgentToken(
      deps.keyStore,
      principal.workspace,
      principal.subject,
      ["write"],
      `teammate:${name}`,
    );
    teammateTokens.set(sessionId, { token, keyId });
    supervisor.register(sessionId, name);
    deliver(principal.workspace, sessionId, {
      from: "user",
      content: `You are "${name}", an autonomous teammate. Your standing task:\n${task}`,
    });
    return { id: sessionId };
  };

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
        // Permission mode for this turn: default = ask on write tools (HITL) · bypass = auto-allow writes ·
        // plan = read-only until the agent presents a plan and it is approved. (Coarse RBAC still gates every call.)
        mode: z.enum(["default", "bypass", "plan"]).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    // Client disconnect (the web's Stop button aborts the fetch) → abort the loop mid-turn. Fires harmlessly on
    // normal completion too (the loop has already finished by then).
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
    const headers = forwardHeaders(req);
    const { message, references, attachments } = body.data;
    const mode = body.data.mode ?? "default";

    const drainInput = (): ChatMessage[] => mailbox.drain(principal.workspace, id);
    // Route send_message to another of the caller's conversations (S2 generalization): delivered to that session's
    // mailbox (agent-attributed), absorbed on its next turn. Owner-scoped — an agent only messages its owner's sessions.
    const sendMessage = async (to: string, message: string): Promise<{ ok: boolean; error?: string }> => {
      const target = await deps.sessions.getSession(principal.workspace, principal.subject, to);
      if (!target) return { ok: false, error: `No conversation "${to}" you own to message.` };
      deliver(principal.workspace, to, { from: "agent", sender: id, content: message });
      return { ok: true };
    };
    // spawn_teammate for this run — an agent can spin up an autonomous teammate (owned by the same principal).
    const spawnTeammate = (name: string, task: string): Promise<{ id: string } | { error: string }> =>
      spawnTeammateFor(principal, name, task);
    // A fine-grained rule (allow/deny for a tool in this session) short-circuits the human prompt.
    const withRules =
      (base: PermissionHook): PermissionHook =>
      (request) => {
        const ruled = rules.get(principal.workspace, id, request.name);
        return ruled ?? base(request);
      };

    // Non-streaming clients (tests / API callers) get the buffered JSON tail. No human channel: writes auto-allow
    // (bypass) or follow the session rules (default/plan), and plan mode auto-approves (onPlan absent).
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
            sendMessage,
            spawnTeammate,
            ...(mode === "bypass" ? {} : { permit: withRules((): PermissionDecision => "allow") }),
            ...(mode === "plan" ? { planMode: true } : {}),
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
    // client disconnect or timeout resolves to "deny" (the registry's safe default). Wrapped by withRules so a
    // standing "always allow/deny" rule for the tool answers without prompting.
    const permit: PermissionHook = withRules((request) => {
      const requestId = deps.newId();
      write("permission", { requestId, name: request.name, input: request.input });
      return permissions.wait(requestId, id, controller.signal);
    });
    // Plan approval reuses the same park-and-await channel: emit a `plan` ask, resolve via POST /permission.
    const onPlan = async (plan: string): Promise<boolean> => {
      const requestId = deps.newId();
      write("plan", { requestId, plan });
      const decision = await permissions.wait(requestId, id, controller.signal);
      return decision === "allow";
    };
    try {
      await runChat(deps, principal, headers, id, message, references, attachments, controller.signal, {
        onEvent: (e) => {
          if (e.type === "text_delta") write("delta", { text: e.delta });
          // Live extended-thinking tokens — grow the transcript's reasoning block before the answer streams in.
          else if (e.type === "reasoning_delta") write("reasoning", { text: e.delta });
          // The post-decision event: forward it so the web dismisses the prompt even when the decision was the
          // registry's timeout/disconnect default rather than a click.
          else if (e.type === "permission") write("permission_resolved", { name: e.name, decision: e.decision });
          else if (e.type === "plan") write("plan_presented", { plan: e.plan });
        },
        onRecord: (r) => write("message", r),
        // bypass → no permit (auto-allow writes); default/plan → HITL + rules. plan → planMode + onPlan approval.
        ...(mode === "bypass" ? {} : { permit }),
        ...(mode === "plan" ? { planMode: true, onPlan } : {}),
        drainInput,
        sendMessage,
        spawnTeammate,
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
    deliver(principal.workspace, id, { from: "user", content: parsed.data.message });
    return reply.code(202).send({ queued: true });
  });

  // Deliver a platform EVENT into a conversation's mailbox (agent-teams.md S1 — the seed of message-based monitoring).
  // The running turn absorbs it attributed as an Everdict event, so the agent can react. Scoped to the session owner
  // (the cross-process monitoring→agent bridge is a later stage; this is the same substrate an event will use).
  app.post("/agent/sessions/:id/event", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const parsed = z.object({ message: z.string().min(1), source: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    deliver(principal.workspace, id, {
      from: "event",
      ...(parsed.data.source !== undefined ? { sender: parsed.data.source } : {}),
      content: parsed.data.message,
    });
    return reply.code(202).send({ queued: true });
  });

  // S3 — spawn a persistent TEAMMATE: a long-lived agent (its own session) that runs autonomously, reacting to
  // messages (send_message from peers, /event from monitoring) without a human prompt. It gets its own agt_ execution
  // token (acts AS the creator, capped to write scope) so its request-less turns are authenticated + RBAC-bounded. The
  // supervisor wakes it whenever a message lands in its mailbox. Owner-scoped; requires the key store (DB).
  app.post("/agent/teammates", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const parsed = z.object({ name: z.string().min(1).max(60), task: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const result = await spawnTeammateFor(principal, parsed.data.name, parsed.data.task);
    if ("error" in result) return reply.code(404).send({ code: "NOT_FOUND", message: result.error });
    return reply.code(201).send({ id: result.id, name: parsed.data.name });
  });

  // The caller's teammate roster — their sessions that are registered, running teammates.
  app.get("/agent/teammates", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const sessions = await deps.sessions.listSessions(principal.workspace, principal.subject);
    const teammates = sessions.filter((s) => supervisor.isTeammate(s.id)).map((s) => ({ id: s.id, name: s.title }));
    return reply.send({ teammates });
  });

  // Stop a teammate: unregister it (no more wakes), revoke its execution token, and drop it. Owner-scoped; its session
  // (transcript) is kept. A no-op-safe 204 if it isn't a live teammate.
  app.delete("/agent/teammates/:id", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Teammate not found." });
    supervisor.unregister(id);
    const entry = teammateTokens.get(id);
    if (entry && deps.keyStore) await deps.keyStore.revoke(principal.workspace, entry.keyId, principal.subject);
    teammateTokens.delete(id);
    return reply.code(204).send();
  });

  // Fine-grained permission rules for a conversation — the "always allow / always deny this tool" layer above the
  // coarse RBAC. The HITL prompt consults them, so the web's "always allow" button posts a rule here. Scoped to owner.
  app.get("/agent/sessions/:id/rules", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    return reply.send({ rules: rules.list(principal.workspace, id) });
  });

  app.post("/agent/sessions/:id/rules", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const parsed = z.object({ tool: z.string().min(1), decision: z.enum(["allow", "deny"]) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    rules.set(principal.workspace, id, parsed.data.tool, parsed.data.decision);
    return reply.send({ rules: rules.list(principal.workspace, id) });
  });

  app.delete("/agent/sessions/:id/rules/:tool", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const params = z.object({ id: z.string().min(1), tool: z.string().min(1) }).parse(req.params);
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, params.id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    rules.clear(principal.workspace, params.id, params.tool);
    return reply.code(204).send();
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
