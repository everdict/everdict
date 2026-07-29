import { timingSafeEqual } from "node:crypto";
import type { ChatMessage, PermissionDecision, PermissionHook } from "@everdict/agent-runtime";
import type { AgentRegistry, TenantKeyStore } from "@everdict/application-control";
import type { AgentSessionRecord } from "@everdict/contracts";
import { AgentPermissionModeSchema, AgentReferenceSchema, AppError, CodeToolSpecSchema } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { isGuardedAction } from "./action-policy.js";
import { AgentActivator } from "./agent-activation.js";
import { type AgentDraft, AgentDraftSchema } from "./agent-draft-tool.js";
import { AgentMailbox } from "./agent-mailbox.js";
import type { AgentTryEvent } from "./agent-try.js";
import { runAgentTry } from "./agent-try.js";
import { type ChatDeps, DEFAULT_SESSION_TITLE, runChat } from "./chat.js";
import { type CodeTryDeps, runCodeToolTry } from "./code-try.js";
import type { CommentActivityReporter } from "./comment-activity.js";
import { runDiscussionTurn } from "./discussion-turn.js";
import { PermissionRegistry } from "./permission-registry.js";
import { PermissionRules } from "./permission-rules.js";
import type { Authenticate, ForwardHeaders, Principal } from "./principal.js";
import { runReportTurn } from "./report-turn.js";
import { runSkillTry } from "./skill-try.js";
import { TeammateSupervisor } from "./teammate-supervisor.js";
import { runTeammateTurn } from "./teammate-turn.js";

export interface AgentServerDeps extends ChatDeps {
  authenticate: Authenticate;
  // Verify the CALLER can see a View (its private|workspace gate lives in the control plane) — the view-artifacts
  // route consults it with the forwarded bearer before listing (analysis-studio V3). Absent → the route is 404.
  checkViewAccess?: (headers: ForwardHeaders, viewId: string) => Promise<boolean>;
  // Tenant key store — needed to issue a teammate's agt_ execution token (S3). Absent (no DB) → teammate spawn is 404.
  keyStore?: TenantKeyStore;
  // Agent registry — with keyStore, powers registry-driven trigger activation (agent-automation A3): a platform
  // event matching an ENABLED agent's triggers launches a headless run. Absent → events only wake teammates.
  agentRegistry?: AgentRegistry;
  // Test seam: the activation run executor. Default = the teammate-turn machinery (one request-less loop turn).
  activationRunTurn?: (sessionId: string, agentToken: string, signal: AbortSignal) => Promise<void>;
  // agent.run.* lifecycle facts → the control plane's event log (fleet observability, agent-automation A5).
  reportRunEvent?: (input: {
    workspace: string;
    kind:
      | "agent.run.started"
      | "agent.run.awaiting_approval"
      | "agent.run.completed"
      | "agent.run.failed"
      | "agent.run.cancelled";
    sessionId: string;
    agentId: string;
    eventKind: string;
    message: string;
    // P3 ledger correlation: one run id per activation/turn — the CP opens/settles Run{kind:"agent"} on it.
    runId?: string;
    agentVersion?: string;
    eventId?: string;
    creator?: string;
    budgetUsd?: number;
  }) => Promise<void>;
  // Shared secret the control plane presents (x-internal-token) to POST /agent/events on a recipient's behalf (S4 —
  // the monitoring→agent bridge). Absent → the internal event path is disabled (only user-authenticated events).
  internalToken?: string;
  // Durable-approval bridge to the control plane (A6): register the park (survives our restart) + settle the
  // ledger after the in-process wait resolves. Absent = the legacy in-process-only park (10-minute window).
  approvalBridge?: {
    register(input: {
      tenant: string;
      sessionId: string;
      agentId?: string;
      requestId: string;
      request: { name: string; input?: unknown };
    }): Promise<{ id: string; expiresAt: string }>;
    settle(id: string, tenant: string, decision: "approve" | "deny"): Promise<void>;
  };
  // Code-tool verification (check/run before publish or adopt) — the runtime + stores POST /agent/code-tools/try
  // needs. Absent → the route is 404.
  codeTry?: CodeTryDeps;
  // Comment-lifecycle bridge back to the control plane (/internal/comment-activity) — the discussion turn reports
  // its placeholder comment's progress through it. Absent → POST /internal/discussion-turn is disabled.
  commentActivity?: CommentActivityReporter;
}

// Constant-time equality for the internal token (fail-closed: no secret configured OR length mismatch → false).
function constantTimeEq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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

// How long a headless run's parked mutation waits for a member decision before the registry's deny-on-expiry
// settles it (same window as the discussion turn's park).
const ACTIVATION_APPROVAL_TIMEOUT_MS = 10 * 60_000;

// Project the parsed event-body fields into an ActivationEvent tail (workspace is supplied by the caller).
function eventOf(data: {
  kind: string;
  message: string;
  source?: string;
  eventId?: string;
  subject?: { type: string; id: string };
  payload?: Record<string, unknown>;
  causedBy?: string;
}) {
  return {
    kind: data.kind,
    message: data.message,
    ...(data.source !== undefined ? { source: data.source } : {}),
    ...(data.eventId !== undefined ? { eventId: data.eventId } : {}),
    ...(data.subject !== undefined ? { subject: data.subject } : {}),
    ...(data.payload !== undefined ? { payload: data.payload } : {}),
    ...(data.causedBy !== undefined ? { causedBy: data.causedBy } : {}),
  };
}

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
  // The teammate registry — sessionId → its execution token (+ key id for revoke), owner/workspace scope, and the
  // platform event kinds it watches (S4: a matching event wakes it proactively, like a peer's message).
  interface TeammateMeta {
    token: string;
    keyId: string;
    name: string;
    owner: string;
    workspace: string;
    watch: Set<string>;
  }
  const teammates = new Map<string, TeammateMeta>();
  const supervisor = new TeammateSupervisor(async (sessionId) => {
    const t = teammates.get(sessionId);
    if (t) await runTeammateTurn(deps, deps.authenticate, mailbox, sessionId, t.token);
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
    watch: string[] = [],
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
    teammates.set(sessionId, {
      token,
      keyId,
      name,
      owner: principal.subject,
      workspace: principal.workspace,
      watch: new Set(watch),
    });
    supervisor.register(sessionId, name);
    deliver(principal.workspace, sessionId, {
      from: "user",
      content: `You are "${name}", an autonomous teammate. Your standing task:\n${task}`,
    });
    return { id: sessionId };
  };
  // Fan a platform event out to a (workspace, owner)'s teammates that watch its kind, waking each. Returns the count.
  const fanEvent = (
    workspace: string,
    owner: string,
    kind: string,
    source: string | undefined,
    message: string,
  ): number => {
    let notified = 0;
    for (const [sessionId, t] of teammates) {
      if (t.workspace !== workspace || t.owner !== owner || !t.watch.has(kind)) continue;
      deliver(workspace, sessionId, { from: "event", sender: source ?? kind, content: message });
      notified += 1;
    }
    return notified;
  };

  // Registry-driven activation (agent-automation A3): the same events that wake teammates also match ENABLED
  // crafted agents' triggers workspace-wide, each match launching a headless trigger-origin run.
  const activator =
    deps.agentRegistry && deps.keyStore
      ? new AgentActivator({
          registry: deps.agentRegistry,
          keyStore: deps.keyStore,
          sessions: deps.sessions,
          mailbox,
          runTurn:
            deps.activationRunTurn ??
            ((sessionId, agentToken, signal, permit) =>
              runTeammateTurn(deps, deps.authenticate, mailbox, sessionId, agentToken, signal, permit)),
          // Approval parking (A6): register the ask DURABLY on the control plane first (it survives our
          // restart and gives members the days-long window), then wait in-process — the CP decide path
          // delivers back via POST /internal/deliver-approval, and the legacy fleet channel (GET /pending →
          // POST /permission) still resolves the same wait; the post-wait settle converges the ledger either
          // way. No bridge (or a failed registration) degrades to the 10-minute in-process park.
          waitApproval: async (ctx, request, signal) => {
            const requestId = deps.newId();
            const bridge = deps.approvalBridge;
            let registered: { id: string; expiresAt: string } | undefined;
            if (bridge) {
              try {
                registered = await bridge.register({
                  tenant: ctx.workspace,
                  sessionId: ctx.sessionId,
                  ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
                  requestId,
                  request: { name: request.name, input: request.input },
                });
              } catch {
                // best-effort — the in-process park still guards the mutation
              }
            }
            const timeoutMs = registered
              ? Math.max(60_000, new Date(registered.expiresAt).getTime() - Date.now())
              : ACTIVATION_APPROVAL_TIMEOUT_MS;
            const decision = await permissions.wait(requestId, ctx.sessionId, signal, request, timeoutMs);
            if (registered && bridge) {
              const settled = registered.id;
              void bridge.settle(settled, ctx.workspace, decision === "allow" ? "approve" : "deny").catch(() => {});
            }
            return decision;
          },
          now: deps.now,
          newId: deps.newId,
          ...(deps.reportRunEvent ? { reportRunEvent: deps.reportRunEvent } : {}),
        })
      : undefined;
  app.decorate("agentActivator", activator);

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
      .object({
        title: z.string().optional(),
        model: z.string().min(1).optional(),
        permissionMode: AgentPermissionModeSchema.optional(), // a draft picked before the first send carries over
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const now = deps.now();
    const record: AgentSessionRecord = {
      id: deps.newId(),
      tenant: principal.workspace,
      owner: principal.subject,
      title: body.data.title && body.data.title.length > 0 ? body.data.title : DEFAULT_SESSION_TITLE,
      ...(body.data.model !== undefined ? { model: body.data.model } : {}),
      ...(body.data.permissionMode !== undefined ? { permissionMode: body.data.permissionMode } : {}),
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
    // Visibility-aware: the owner OR any member of the workspace a "workspace"-visible session belongs to
    // (discussion sessions — the comment thread's shared transcript). Private sessions stay owner-only.
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
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
        // The session's standing permission mode; null clears it (→ "default": ask for every mutation).
        permissionMode: AgentPermissionModeSchema.nullable().optional(),
      })
      .refine((b) => b.title !== undefined || b.model !== undefined || b.permissionMode !== undefined, {
        message: "Nothing to update.",
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const now = deps.now();
    if (body.data.title !== undefined) await deps.sessions.touchSession(principal.workspace, id, now, body.data.title);
    if (body.data.model !== undefined)
      await deps.sessions.setSessionModel(principal.workspace, id, body.data.model, now);
    if (body.data.permissionMode !== undefined)
      await deps.sessions.setSessionPermissionMode(principal.workspace, id, body.data.permissionMode, now);
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
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const query = z.object({ since: z.coerce.number().int().nonnegative().optional() }).parse(req.query);
    const messages = await deps.sessions.listMessages(principal.workspace, id, query.since);
    return reply.send({ messages });
  });

  // The session's parked write-tool approvals — lets a panel opened DURING a background (discussion) turn discover
  // the asks the turn is awaiting; answering goes through the normal POST /permission route.
  app.get("/agent/sessions/:id/pending", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    return reply.send({ pending: permissions.pendingFor(id) });
  });

  // The conversation's analysis artifacts (charts/tables/reports the agent emitted) — createdAt ascending, so the
  // web can interleave them with the transcript on reload (live delivery is the SSE `artifact` event).
  app.get("/agent/sessions/:id/artifacts", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const artifacts = deps.artifacts ? await deps.artifacts.listBySession(principal.workspace, id) : [];
    return reply.send({ artifacts });
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
        // The analysis canvas the member currently sees (stored-form config + the open View, if saved) —
        // captured by the web right before send, so multi-turn "change the viz / regroup" requests ground on
        // the live state including manual picker changes (analysis-studio C).
        canvas: z.object({ config: z.record(z.string()), viewId: z.string().min(1).optional() }).optional(),
        // The agent-crafting canvas the member currently sees (the draft + the registered agent it edits, if
        // any) — captured right before send like the analysis canvas, so multi-turn crafting grounds on the
        // live draft including manual edits (agent-automation B2/B3).
        agentDraft: z.object({ draft: AgentDraftSchema, agentId: z.string().min(1).optional() }).optional(),
        // Permission mode for this turn: default = ask on every write tool (HITL) · auto = auto-allow routine writes,
        // ask only for guarded (destructive/governance/credential) actions · bypass = auto-allow everything · plan =
        // read-only until the agent presents a plan and it is approved. (Coarse RBAC still gates every call.)
        mode: AgentPermissionModeSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    // Client disconnect (the web's Stop button aborts the fetch) → abort the loop mid-turn. Fires harmlessly on
    // normal completion too (the loop has already finished by then).
    const controller = new AbortController();
    req.raw.on("close", () => controller.abort());
    const headers = forwardHeaders(req);
    const { message, references, attachments, canvas, agentDraft } = body.data;
    // The turn's effective mode: an explicit body.mode (API callers / one-off overrides) wins, else the session's
    // standing mode (the chat-header picker, persisted on the record), else "default" (ask). A missing session is
    // left to runChat's own NotFound so this stays a pure mode lookup. Visibility-aware: any member may continue a
    // workspace-visible (discussion) session.
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    const mode = body.data.mode ?? session?.permissionMode ?? "default";

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
    const spawnTeammate = (name: string, task: string, watch: string[]): Promise<{ id: string } | { error: string }> =>
      spawnTeammateFor(principal, name, task, watch);
    // list_teammates for this run — the caller's live teammates, so the agent can coordinate them.
    const listTeammates = async (): Promise<{ id: string; name: string; watch: string[] }[]> =>
      [...teammates.entries()]
        .filter(([, t]) => t.owner === principal.subject && t.workspace === principal.workspace)
        .map(([id, t]) => ({ id, name: t.name, watch: [...t.watch] }));
    // A fine-grained rule (allow/deny for a tool in this session) short-circuits the human prompt.
    const withRules =
      (base: PermissionHook): PermissionHook =>
      (request) => {
        const ruled = rules.get(principal.workspace, id, request.name);
        return ruled ?? base(request);
      };

    // Non-streaming clients (tests / API callers) get the buffered JSON tail. No human channel: writes auto-allow
    // (bypass/auto alike) or follow the session rules (default/plan), and plan mode auto-approves (onPlan absent).
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
            listTeammates,
            ...(mode === "bypass" ? {} : { permit: withRules((): PermissionDecision => "allow") }),
            ...(mode === "plan" ? { planMode: true } : {}),
          },
          canvas,
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
    // standing "always allow/deny" rule for the tool answers without prompting. In "auto" mode, routine mutations
    // run without asking — only the guarded (destructive/governance/credential) actions still park for approval.
    const ask = (request: { name: string; input: unknown }): Promise<PermissionDecision> => {
      const requestId = deps.newId();
      write("permission", { requestId, name: request.name, input: request.input });
      return permissions.wait(requestId, id, controller.signal, request);
    };
    const permit: PermissionHook = withRules((request) =>
      mode === "auto" && !isGuardedAction(request.name) ? "allow" : ask(request),
    );
    // Plan approval reuses the same park-and-await channel: emit a `plan` ask, resolve via POST /permission.
    const onPlan = async (plan: string): Promise<boolean> => {
      const requestId = deps.newId();
      write("plan", { requestId, plan });
      const decision = await permissions.wait(requestId, id, controller.signal);
      return decision === "allow";
    };
    try {
      await runChat(
        deps,
        principal,
        headers,
        id,
        message,
        references,
        attachments,
        controller.signal,
        {
          onEvent: (e) => {
            if (e.type === "text_delta") write("delta", { text: e.delta });
            // Live extended-thinking tokens — grow the transcript's reasoning block before the answer streams in.
            else if (e.type === "reasoning_delta") write("reasoning", { text: e.delta });
            // The post-decision event: forward it so the web dismisses the prompt even when the decision was the
            // registry's timeout/disconnect default rather than a click.
            else if (e.type === "permission") write("permission_resolved", { name: e.name, decision: e.decision });
            else if (e.type === "plan") write("plan_presented", { plan: e.plan });
          },
          // An emitted analysis artifact (chart/table/report) — push the record so the web renders it live.
          onArtifact: (artifact) => write("artifact", artifact),
          // The agent drove the analysis canvas — push the stored-form config so the web applies it live.
          onViewConfig: (config) => write("view_config", config),
          // Crafting canvas open → the agent gets craft_agent (patches stream to the web) + try_agent_draft
          // (shadow run under the CALLER's own headers, so the try is RBAC-bounded exactly like the member).
          ...(agentDraft
            ? {
                onAgentDraft: (draft: AgentDraft) => write("agent_draft", draft),
                tryAgentDraft: (draft: AgentDraft, event: AgentTryEvent) =>
                  runAgentTry(
                    { ...deps, maxTurns: 10 },
                    principal,
                    headers,
                    {
                      draft: {
                        ...(draft.instructions !== undefined ? { instructions: draft.instructions } : {}),
                        ...(draft.task !== undefined ? { task: draft.task } : {}),
                      },
                    },
                    event,
                    controller.signal,
                  ),
              }
            : {}),
          onRecord: (r) => write("message", r),
          // bypass → no permit (auto-allow writes); default/plan → HITL + rules; auto → ask only guarded actions
          // (folded into `permit` above). plan → planMode + onPlan approval.
          ...(mode === "bypass" ? {} : { permit }),
          ...(mode === "plan" ? { planMode: true, onPlan } : {}),
          drainInput,
          sendMessage,
          spawnTeammate,
          listTeammates,
        },
        canvas,
        agentDraft,
      );
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
    // Visibility-aware: any workspace member may answer a workspace-visible (discussion) session's parked ask.
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
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
    const parsed = z
      .object({ name: z.string().min(1).max(60), task: z.string().min(1), watch: z.array(z.string()).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const result = await spawnTeammateFor(principal, parsed.data.name, parsed.data.task, parsed.data.watch ?? []);
    if ("error" in result) return reply.code(404).send({ code: "NOT_FOUND", message: result.error });
    return reply.code(201).send({ id: result.id, name: parsed.data.name });
  });

  // The caller's teammate roster — their live teammates, with the event kinds each watches.
  app.get("/agent/teammates", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const roster = [...teammates.entries()]
      .filter(([, t]) => t.workspace === principal.workspace && t.owner === principal.subject)
      .map(([id, t]) => ({ id, name: t.name, watch: [...t.watch] }));
    return reply.send({ teammates: roster });
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
    const t = teammates.get(id);
    if (t && deps.keyStore) await deps.keyStore.revoke(principal.workspace, t.keyId, principal.subject);
    teammates.delete(id);
    return reply.code(204).send();
  });

  // S4 — fan a platform EVENT out to teammates that watch its kind, waking each to react proactively. Two callers:
  //  · INTERNAL (the control plane's notification emitter) presents x-internal-token and drives events for a
  //    recipient in a workspace — this is what auto-wires monitoring → the proactive team.
  //  · USER (a member) drives events for their OWN teammates (authenticated normally).
  // Nothing watches the kind → a harmless 200 with notified:0.
  // Try-drive (agent-automation B3): fire a (replayed or hand-built) platform event at a saved agent or an
  // instruction draft in SHADOW mode — reads run for real (caller's bearer), mutations are captured as
  // would-have-done and denied. Stateless; returns the transcript + captured intents.
  app.post("/agent/agents/try", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const parsed = z
      .object({
        agentId: z.string().min(1).optional(),
        draft: z.object({ instructions: z.string().optional(), task: z.string().optional() }).optional(),
        event: z.object({
          kind: z.string().min(1),
          message: z.string().min(1),
          subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
          payload: z.record(z.unknown()).optional(),
        }),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const { agentId, draft, event } = parsed.data;
      const result = await runAgentTry(
        deps,
        principal,
        forwardHeaders(req),
        { ...(agentId !== undefined ? { agentId } : {}), ...(draft !== undefined ? { draft } : {}) },
        event,
      );
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Fleet view (agent-automation A5): every agent RUN in the caller's workspace (sessions with an origin),
  // newest first — trigger activations, teammates, discussion turns. Workspace observability, any member.
  app.get("/agent/runs", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const query = z
      .object({ limit: z.coerce.number().int().positive().max(200).optional() })
      .safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const runs = await deps.sessions.listRuns(principal.workspace, {
      ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
    });
    return reply.send({ runs });
  });

  // Stop a live headless run (fleet control) — aborts its loop; the wrapper settles it as cancelled. Viewer
  // roles can watch but not stop. 404 when there is no live run for that session in this process.
  app.post("/agent/runs/:id/stop", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    if (!principal.roles.some((r) => r === "member" || r === "admin"))
      return reply.code(403).send({ code: "FORBIDDEN", message: "Stopping a run requires the member role." });
    const { id } = idParams.parse(req.params);
    if (!activator?.stop(id))
      return reply.code(404).send({ code: "NOT_FOUND", message: "No live run for that session." });
    return reply.send({ ok: true });
  });

  // The event body — kind/message plus the platform-event identity + matching context (agent-automation A1/A3):
  // eventId (durable activation dedup), subject/payload (declarative trigger filters), causedBy (loop guard).
  const eventFieldsSchema = z.object({
    kind: z.string().min(1),
    message: z.string().min(1),
    source: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
    payload: z.record(z.unknown()).optional(),
    causedBy: z.string().min(1).optional(),
  });
  app.post("/agent/events", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented === "string") {
      if (!constantTimeEq(presented, deps.internalToken))
        return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
      const parsed = eventFieldsSchema
        .extend({
          workspace: z.string().min(1),
          // Teammate compatibility: the creator whose chat-spawned teammates also wake. Absent → registry
          // activation only (workspace-scoped facts have no single recipient).
          recipient: z.string().min(1).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      const { workspace, recipient, kind, source, message } = parsed.data;
      const notified = recipient !== undefined ? fanEvent(workspace, recipient, kind, source, message) : 0;
      const activated = activator ? await activator.onEvent({ workspace, ...eventOf(parsed.data) }) : 0;
      return reply.send({ notified, activated });
    }
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const parsed = eventFieldsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const notified = fanEvent(
      principal.workspace,
      principal.subject,
      parsed.data.kind,
      parsed.data.source,
      parsed.data.message,
    );
    // A member-driven event also matches the registry (the manual "fire this at my agent" path).
    const activated = activator
      ? await activator.onEvent({ workspace: principal.workspace, ...eventOf(parsed.data) })
      : 0;
    return reply.send({ notified, activated });
  });

  // A View's pinned artifacts (the Studio gallery / report archive — analysis-studio V3). The view's
  // private|workspace visibility is enforced by the control plane: we forward the caller's bearer to the views
  // read and 404 when it can't see the view (no existence leak).
  app.get("/agent/views/:viewId/artifacts", async (req, reply) => {
    if (!deps.checkViewAccess || !deps.artifacts)
      return reply.code(404).send({ code: "NOT_FOUND", message: "View artifacts are not configured." });
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { viewId } = z.object({ viewId: z.string().min(1) }).parse(req.params);
    if (!(await deps.checkViewAccess(forwardHeaders(req), viewId)))
      return reply.code(404).send({ code: "NOT_FOUND", message: "View not found." });
    return reply.send({ artifacts: await deps.artifacts.listByView(principal.workspace, viewId) });
  });

  // Pin a conversation artifact to a View (the Studio gallery). Only the artifact's creator pins their own
  // conversation output; the target View's private|workspace gate is the control plane's (checkViewAccess).
  app.post("/agent/artifacts/:id/pin", async (req, reply) => {
    if (!deps.checkViewAccess || !deps.artifacts)
      return reply.code(404).send({ code: "NOT_FOUND", message: "Artifact pinning is not configured." });
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const body = z.object({ viewId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const artifact = await deps.artifacts.get(principal.workspace, id);
    if (!artifact || artifact.createdBy !== principal.subject)
      return reply.code(404).send({ code: "NOT_FOUND", message: "Artifact not found." });
    if (!(await deps.checkViewAccess(forwardHeaders(req), body.data.viewId)))
      return reply.code(404).send({ code: "NOT_FOUND", message: "View not found." });
    await deps.artifacts.attachToView(principal.workspace, id, body.data.viewId);
    return reply.send(await deps.artifacts.get(principal.workspace, id));
  });

  app.delete("/agent/artifacts/:id/pin", async (req, reply) => {
    if (!deps.artifacts)
      return reply.code(404).send({ code: "NOT_FOUND", message: "Artifact pinning is not configured." });
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const artifact = await deps.artifacts.get(principal.workspace, id);
    if (!artifact || artifact.createdBy !== principal.subject)
      return reply.code(404).send({ code: "NOT_FOUND", message: "Artifact not found." });
    await deps.artifacts.detachFromView(principal.workspace, id);
    return reply.code(204).send();
  });

  // Per-view artifact rollup (count + newest report time) for the views list — one workspace-wide query,
  // answered ONLY for the ids the caller already holds (its own visible views list) so the response never
  // discloses other views' ids (the private-view no-existence-leak discipline).
  app.get("/agent/views/artifacts-summary", async (req, reply) => {
    if (!deps.artifacts)
      return reply.code(404).send({ code: "NOT_FOUND", message: "View artifacts are not configured." });
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const query = z.object({ ids: z.string().min(1) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: "ids query param is required." });
    const requested = new Set(query.data.ids.split(",").filter(Boolean));
    const all = await deps.artifacts.summarizeByView(principal.workspace);
    const summary: typeof all = {};
    for (const [viewId, entry] of Object.entries(all)) if (requested.has(viewId)) summary[viewId] = entry;
    return reply.send({ summary });
  });

  // Discussion-turn fire (@everdict in a comment thread) — INTERNAL ONLY (the control plane's comment slice).
  // CP → agent: deliver a durable-approval decision to the live in-process wait (A6). delivered:false =
  // no live wait exists (the loop died with a restart) — the control plane keeps the decision on the record
  // for the resume leg. Same internal-token discipline as the other /internal routes.
  const deliverApprovalSchema = z.object({
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
  });
  app.post("/internal/deliver-approval", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
    const parsed = deliverApprovalSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const delivered = permissions.respond(parsed.data.requestId, parsed.data.sessionId, parsed.data.decision);
    return reply.send({ delivered });
  });

  // CP → agent: RESUME a run whose park died with a restart (A6 resume leg) — one continuation turn on the
  // same session, seeded with the decision; an approve pre-authorizes the first re-ask of that tool. Returns
  // resumed:false with a reason when the run is live (deliver instead) or the session isn't a trigger run.
  const resumeApprovalSchema = z.object({
    workspace: z.string().min(1),
    sessionId: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
    request: z.object({ name: z.string().min(1), input: z.unknown().optional() }),
    decidedBy: z.string().min(1).optional(),
  });
  app.post("/internal/resume-approval", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
    if (!activator) return reply.code(404).send({ code: "NOT_FOUND", message: "Activations are not configured." });
    const parsed = resumeApprovalSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    return reply.send(await activator.resumeApproval(parsed.data));
  });

  // Acks 202 and runs the turn DETACHED (a HITL approval can park it for minutes — never a held request);
  // progress lands on the placeholder comment via the /internal/comment-activity bridge, not this response.
  app.post("/internal/discussion-turn", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
    if (!deps.commentActivity || !deps.keyStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "Discussion turns are not configured." });
    const parsed = z
      .object({
        workspace: z.string().min(1),
        askedBy: z.string().min(1),
        resourceType: z.string().min(1),
        resourceId: z.string().min(1),
        commentId: z.string().min(1),
        sessionId: z.string().min(1),
        thread: z
          .array(z.object({ author: z.string(), authorName: z.string(), body: z.string(), at: z.string() }))
          .max(500),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    void runDiscussionTurn(deps, permissions, parsed.data).catch((err) => {
      // The turn already marked its comment failed (best-effort) — this log is for the operator.
      console.error("[agent] discussion turn failed:", err);
    });
    return reply.code(202).send({ accepted: true });
  });

  // Scheduled-report fire (analysis-studio V4) — INTERNAL ONLY (the control plane's report-mode schedule fire).
  // Runs one budgeted, request-less analysis turn acting AS the schedule creator and returns the report artifact.
  app.post("/internal/report", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
    const parsed = z
      .object({
        workspace: z.string().min(1),
        createdBy: z.string().min(1),
        scheduleId: z.string().min(1),
        scheduleName: z.string().min(1),
        view: z.string().min(1),
        instructions: z.string().min(1).optional(),
        compare: z.enum(["previous-period"]).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await runReportTurn(deps, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
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
          files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
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

  // Code-tool verification — `check` (parse-only compile validation) or `run` (execute against an example input,
  // under the same sandbox gate as the agent) for a DRAFT spec (the wizard, pre-publish) or a PUBLISHED capability
  // ref (the store's try panel — resolved + visibility-re-checked server-side; the client never asserts trust).
  app.post("/agent/code-tools/try", async (req, reply) => {
    if (!deps.codeTry) return reply.code(404).send({ code: "NOT_FOUND", message: "code-tool try is not configured" });
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const body = z
      .object({
        mode: z.enum(["check", "run"]),
        name: z.string().min(1).max(60).optional(), // draft tool name (spec mode)
        spec: CodeToolSpecSchema.optional(),
        ref: z.object({ source: z.string().min(1), id: z.string().min(1), version: z.string().min(1) }).optional(),
        input: z.record(z.unknown()).optional(), // run mode: the example input (the tool's argument object)
      })
      .refine((b) => (b.spec !== undefined) !== (b.ref !== undefined), {
        message: "exactly one of spec or ref is required",
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const { spec, ref } = body.data;
    const target =
      spec !== undefined
        ? { kind: "spec" as const, name: body.data.name ?? "draft-tool", spec }
        : ref !== undefined
          ? { kind: "ref" as const, source: ref.source, id: ref.id, version: ref.version }
          : undefined;
    if (!target) return reply.code(400).send({ code: "BAD_REQUEST", message: "spec or ref is required" });
    try {
      return reply.send(await runCodeToolTry(deps.codeTry, principal, body.data.mode, target, body.data.input));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return app;
}
