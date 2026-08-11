import { timingSafeEqual } from "node:crypto";
import type { ChatMessage, PermissionDecision, PermissionHook } from "@everdict/agent-runtime";
import type { AgentRegistry, SubscriptionStore, TenantKeyStore } from "@everdict/application-control";
import type { AgentSessionRecord, HandoffCheckpoint } from "@everdict/contracts";
import {
  type AgentPermissionMode,
  AgentPermissionModeSchema,
  AgentReferenceSchema,
  AppError,
  CodeToolSpecSchema,
  TaskEnvelopeSchema,
} from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { isGuardedAction } from "./action-policy.js";
import { AgentActivator, type TurnOutcome } from "./agent-activation.js";
import { type AgentDraft, AgentDraftSchema } from "./agent-draft-tool.js";
import { AgentMailbox } from "./agent-mailbox.js";
import type { AgentTryEvent } from "./agent-try.js";
import { runAgentTry } from "./agent-try.js";
import { withChatTurnRun } from "./chat-run.js";
import { type ChatDeps, DEFAULT_SESSION_TITLE, runChat } from "./chat.js";
import { type CodeTryDeps, runCodeToolTry } from "./code-try.js";
import type { CommentActivityReporter } from "./comment-activity.js";
import { runDiscussionTurn } from "./discussion-turn.js";
import { LiveTurnRegistry } from "./live-turns.js";
import { PermissionRegistry } from "./permission-registry.js";
import { PermissionRules } from "./permission-rules.js";
import type { Authenticate, ForwardHeaders, Principal } from "./principal.js";
import { runReportTurn } from "./report-turn.js";
import type { AgentTurnUsage } from "./run-trace.js";
import { runSkillTry } from "./skill-try.js";
import { TeammateSupervisor } from "./teammate-supervisor.js";
import { runTeammateTurn } from "./teammate-turn.js";
import type { AgentRunEventReport } from "./usage.js";
import { runVerificationTurn } from "./verification-turn.js";
import { buildWakeResumer } from "./wake-resume.js";

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
  // E3 subscription registry — with the activator, reaction.kind="agent" rules wake their target agent
  // through the same guards as spec triggers. Absent → spec triggers only.
  subscriptions?: SubscriptionStore;
  // §5.1 activation admission — the CP tenant-budget ask every launch path passes (absent = unadmitted dev).
  admitRun?: (workspace: string) => Promise<{ admitted: boolean; reason?: string }>;
  // Publish a halted activation's handoff checkpoint to the control plane (ownership O6). Absent = no
  // handoff is written, which is the dev wiring; the halt itself is still a fact on the event log.
  publishCheckpoint?: (
    agentToken: string,
    checkpoint: Omit<HandoffCheckpoint, "id" | "createdAt" | "createdBy">,
  ) => Promise<void>;
  // Test seam: the activation run executor. Default = the teammate-turn machinery (one request-less loop turn).
  activationRunTurn?: (sessionId: string, agentToken: string, signal: AbortSignal) => Promise<TurnOutcome | undefined>;
  // (`reportRunEvent` — the agent.run.* lifecycle bridge — is declared on ChatDeps: every turn entry point
  // needs it, not just the ones this server hosts.)
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
  // HITL notification clear (N8): the parked ask this session's bell row announced was decided — ask the
  // control plane to delete the row. The park pings IMMEDIATELY (agent.run.awaiting_approval) and the
  // decision cleans up after itself, so an attended prompt costs at most a briefly flashing badge while an
  // absent member is pinged without delay. Absent = rows are never cleared (they still land correctly).
  clearApprovalNotice?: (workspace: string, sessionId: string) => Promise<void>;
}

// SSE heartbeat: a comment frame every 15s so intermediary proxies/LBs never see an idle stream and cut it — a
// long tool execution produces no events for minutes, and "long task → silent connection → severed connection"
// was a top disconnect cause for long-running turns. Comment frames (leading ':') are invisible to SSE parsers
// (the web's frame loop only reads `event:`/`data:` lines). Returns the stop fn; unref'd so it never holds the
// process open.
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
function startSseHeartbeat(raw: { destroyed: boolean; write: (chunk: string) => unknown }): () => void {
  const timer = setInterval(() => {
    if (!raw.destroyed) raw.write(":hb\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
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
  // Standing-rule durability (LESSON 059 P4): the in-memory map is the hot path; the session record is the
  // truth across restarts. Hydrate at most once per process per session; persist (best-effort) on every change.
  const hydrateRules = async (workspace: string, subject: string, sessionId: string): Promise<void> => {
    if (rules.has(workspace, sessionId)) return;
    const stored = await deps.sessions.getVisibleSession(workspace, subject, sessionId).catch(() => undefined);
    rules.hydrate(workspace, sessionId, stored?.permissionRules ?? {});
  };
  const persistRules = (workspace: string, sessionId: string): void => {
    void deps.sessions
      .setSessionPermissionRules(workspace, sessionId, rules.list(workspace, sessionId), deps.now())
      .catch(() => {});
  };
  // Live chat turns keyed by session: a turn OUTLIVES the request that started it (SSE responses are just
  // subscribers, a disconnect only detaches), GET /stream re-attaches, POST /stop is the explicit abort, and a
  // concurrent /chat on the same session 409s. See live-turns.ts.
  const liveTurns = new LiveTurnRegistry();
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
    // `ledger: true` — nothing above this opened a run (unlike the activation path), so without it a woken
    // teammate's whole turn happens outside the workspace's evidence.
    if (t) await runTeammateTurn(deps, deps.authenticate, mailbox, sessionId, t.token, undefined, undefined, true);
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
      origin: { type: "teammate" },
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
    // Durable half of the roster (LESSON 059 P2): the config lives on the session row so a restart can rebuild
    // the team; only the token stays process-memory (re-minted by the boot restore). Best-effort — a stamp
    // failure leaves a working (if restart-mortal) teammate rather than no teammate.
    await deps.sessions
      .setSessionTeammate(principal.workspace, sessionId, { name, task, watch, keyId }, deps.now())
      .catch(() => {});
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
  // Boot restore (LESSON 059 P2): re-register every standing teammate the previous process held — the roster's
  // durable half is the session rows; the volatile half (the execution token) is re-minted here and the stale
  // key revoked, so a restart changes nothing a teammate's owner can observe. Registered quietly: no wake, no
  // re-seeded standing task (the transcript already carries it) — the next message or watched event wakes it.
  const restoreTeammates = async (): Promise<number> => {
    if (!deps.keyStore) return 0;
    const keyStore = deps.keyStore;
    const rows = await deps.sessions.listTeammateSessions();
    let restored = 0;
    for (const session of rows) {
      const config = session.teammate;
      if (!config || teammates.has(session.id)) continue;
      try {
        const { token, id: keyId } = await issueAgentToken(
          keyStore,
          session.tenant,
          session.owner,
          ["write"],
          `teammate:${config.name}`,
        );
        await keyStore.revoke(session.tenant, config.keyId, session.owner).catch(() => {});
        await deps.sessions
          .setSessionTeammate(session.tenant, session.id, { ...config, keyId }, deps.now())
          .catch(() => {});
        teammates.set(session.id, {
          token,
          keyId,
          name: config.name,
          owner: session.owner,
          workspace: session.tenant,
          watch: new Set(config.watch),
        });
        supervisor.register(session.id, config.name);
        restored += 1;
      } catch (err) {
        console.error(
          `[agent] teammate restore failed for ${session.id} (${config.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return restored;
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
  // Task-ledger facts fan out ACTIONABLY (LESSON 059 P1 — the executor half of the delegation cycle): the fact's
  // payload carries the task id, and a teammate woken by one needs the id to act. task.created additionally
  // carries the work-pull recipe — claim, do, complete WITH output — because a bare "Task created: X" wakes the
  // teammate with nothing to hold on to. Every other kind fans out as the fact's own message.
  const taskFanContent = (kind: string, message: string, payload: Record<string, unknown> | undefined): string => {
    if (!kind.startsWith("task.")) return message;
    const id = payload?.id;
    if (typeof id !== "string" || id.length === 0) return message;
    if (kind === "task.created") {
      const ownerValue = payload?.owner;
      const assignment = typeof ownerValue === "string" ? `assigned to ${ownerValue}` : "unassigned";
      return [
        `${message} [task ${id}, ${assignment}].`,
        "If this task is yours to do (assigned to you, or unassigned work in your remit): read it with get_task,",
        "claim it (update_task status=in_progress — a 409 means someone else already claimed it; stand down), do",
        "the work, then complete it with update_task status=completed and your results in `output`. Whoever",
        "delegated it is woken by the completion and reads that output.",
      ].join(" ");
    }
    return `${message} [task ${id}]`;
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
          ...(deps.subscriptions ? { subscriptions: deps.subscriptions } : {}),
          ...(deps.admitRun ? { admitRun: deps.admitRun } : {}),
          runTurn:
            deps.activationRunTurn ??
            ((sessionId, agentToken, signal, permit, envelope) =>
              // `ledger: false` — the activation already opened this run; the envelope rides through to the
              // kernel, which is what turns spec-declared autonomy into an enforced boundary.
              runTeammateTurn(
                deps,
                deps.authenticate,
                mailbox,
                sessionId,
                agentToken,
                signal,
                permit,
                false,
                envelope,
              )),
          ...(deps.publishCheckpoint ? { publishCheckpoint: deps.publishCheckpoint } : {}),
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
            // N8: the decision deletes the ask's bell row (the awaiting report pinged at the park). The
            // human's decision latency dwarfs the report's round trip, so no ordering chain is needed here.
            void deps.clearApprovalNotice?.(ctx.workspace, ctx.sessionId).catch(() => {});
            return decision;
          },
          now: deps.now,
          newId: deps.newId,
          ...(deps.reportRunEvent ? { reportRunEvent: deps.reportRunEvent } : {}),
        })
      : undefined;
  app.decorate("agentActivator", activator);

  // Resuming parked conversations (LESSON 051). Distinct from the activator above: that one starts a NEW run when a
  // fact matches a crafted agent's triggers; this one continues the EXISTING conversation that asked to be woken by
  // exactly this fact — the agent finishing what it started, where the member is already looking.
  const resumer = deps.keyStore
    ? buildWakeResumer({
        chat: deps,
        authenticate: deps.authenticate,
        keyStore: deps.keyStore,
        isLive: (workspace, sessionId) => liveTurns.isLive(workspace, sessionId),
      })
    : undefined;

  app.decorate("wakeResumer", resumer);
  // Boot restore for the standing-teammate roster (LESSON 059 P2) — main.ts invokes it once at startup.
  app.decorate("teammateRestorer", { restore: restoreTeammates });

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
    // `live` is a computed view field (a turn is streaming in this process right now), decorated per response —
    // never persisted on the record. The history menu renders it as the "running" badge.
    return reply.send({
      sessions: sessions.map((s) => (liveTurns.isLive(principal.workspace, s.id) ? { ...s, live: true } : s)),
    });
  });

  app.get("/agent/sessions/:id", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    // Visibility-aware: the owner OR any member of the workspace a "workspace"-visible session belongs to
    // (discussion sessions — the comment thread's shared transcript). Private sessions stay owner-only.
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    // Same computed `live` decoration as the list — the panel checks it before deciding to re-attach.
    return reply.send(liveTurns.isLive(principal.workspace, id) ? { ...session, live: true } : session);
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
    if (body.data.permissionMode !== undefined) {
      await deps.sessions.setSessionPermissionMode(principal.workspace, id, body.data.permissionMode, now);
      // Mid-turn application, part 2 (part 1 = the live permit hook consulting the record per ask): an ask that
      // is ALREADY parked was created under the old mode — if the new mode would never have asked, resolve it
      // now (bypass → allow everything; auto → allow the non-guarded). The resolution flows through the loop's
      // permission event → SSE permission_resolved, so an attached panel dismisses its prompt.
      const nextMode = body.data.permissionMode;
      if (nextMode === "bypass") permissions.resolveWhere(id, () => "allow");
      else if (nextMode === "auto")
        permissions.resolveWhere(id, (name, effects) =>
          name.length > 0 && !isGuardedAction(name, effects) ? "allow" : undefined,
        );
    }
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
    const headers = forwardHeaders(req);
    const { message, references, attachments, canvas, agentDraft } = body.data;
    // The turn's effective mode: an explicit body.mode (API callers / one-off overrides) pins the WHOLE turn,
    // else the session's standing mode (the chat-header picker, persisted on the record), else "default" (ask).
    // The session-picker half is LIVE: each write-tool ask re-reads the record via liveMode(), so flipping the
    // picker mid-turn applies to the very next tool call — not just the next turn. (Plan mode is the exception:
    // it shapes the loop from the start, so picking it mid-turn takes effect on the next turn.) A missing session
    // is left to runChat's own NotFound so this stays a pure mode lookup. Visibility-aware: any member may
    // continue a workspace-visible (discussion) session.
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    const modeOverride = body.data.mode;
    const mode = modeOverride ?? session?.permissionMode ?? "default";
    const liveMode = async (): Promise<AgentPermissionMode> => {
      if (modeOverride !== undefined) return modeOverride;
      const fresh = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
      return fresh?.permissionMode ?? "default";
    };
    // One live turn per session (the duplicate-turn guard): claim the slot BEFORE starting the loop; a concurrent
    // /chat is refused with 409, so a panel that lost its stream re-attaches via GET /stream instead of
    // double-running the loop. The turn is NOT tied to this request — a client disconnect only detaches the SSE
    // subscriber below; stopping is the explicit POST /stop. An unknown/invisible session skips the claim and
    // lets runChat's own NotFound answer (a 409 must not leak another member's private session).
    const controller = session ? liveTurns.begin(principal.workspace, id) : new AbortController();
    if (controller === null)
      return reply.code(409).send({ code: "CONFLICT", message: "A turn is already running for this conversation." });

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
    // A fine-grained rule (allow/deny for a tool in this session) short-circuits the human prompt. Hydrated
    // from the session record first, so "always allow" answered before a restart still holds (LESSON 059 P4).
    await hydrateRules(principal.workspace, principal.subject, id);
    const withRules =
      (base: PermissionHook): PermissionHook =>
      (request) => {
        const ruled = rules.get(principal.workspace, id, request.name);
        return ruled ?? base(request);
      };

    // Non-streaming clients (tests / API callers) get the buffered JSON tail. No human channel: writes auto-allow
    // (bypass/auto alike) or follow the session rules (default/plan), and plan mode auto-approves (onPlan absent).
    // The turn still feeds the live-turn fan-out (records only), so a web panel that attaches mid-turn follows it.
    if (!(req.headers.accept ?? "").includes("text/event-stream")) {
      try {
        // O1: this turn is a run on the ledger (opened here, settled with its transcript-as-trace).
        const result = await withChatTurnRun(
          deps,
          principal,
          id,
          (collectFailure) =>
            runChat(
              deps,
              principal,
              headers,
              id,
              message,
              references,
              attachments,
              controller.signal,
              {
                onRecord: (r) => liveTurns.broadcast(principal.workspace, id, "message", r),
                onFailedTurn: collectFailure,
                drainInput,
                sendMessage,
                spawnTeammate,
                listTeammates,
                ...(mode === "bypass" ? {} : { permit: withRules((): PermissionDecision => "allow") }),
                ...(mode === "plan" ? { planMode: true } : {}),
              },
              canvas,
            ),
          controller.signal,
        );
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err);
      } finally {
        liveTurns.broadcast(principal.workspace, id, "done", {});
        liveTurns.end(principal.workspace, id);
      }
    }

    // SSE: stream the loop's text deltas + each persisted message record live, then a terminal `done`. This
    // response is just the live turn's FIRST subscriber — every event goes through the registry broadcast, so a
    // late GET /stream attacher receives the same feed, and this client disconnecting (the web switching
    // conversations or unmounting the tab) only detaches the subscriber while the loop keeps running.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const subscriber = (event: string, data: unknown): void => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stopHeartbeat = startSseHeartbeat(reply.raw);
    const detach = session ? liveTurns.attach(principal.workspace, id, subscriber) : null;
    req.raw.on("close", () => {
      stopHeartbeat();
      detach?.();
    });
    const write = (event: string, data: unknown): void => {
      // Unknown session → no registered turn (broadcast no-ops): write the error tail directly instead.
      if (session) liveTurns.broadcast(principal.workspace, id, event, data);
      else subscriber(event, data);
    };
    // HITL: a write tool call parks here — emit a `permission` ask (with a fresh id) and await the human's POST.
    // A timeout or an explicit /stop resolves to "deny" (the registry's safe default); a mere disconnect no longer
    // denies — the ask survives for a re-attaching panel (GET /stream replays it via pendingFor). Wrapped by
    // withRules so a standing "always allow/deny" rule for the tool answers without prompting. In "auto" mode,
    // routine mutations run without asking — only the guarded (destructive/governance/credential) actions park.
    //
    // N8: a park is a turn WAITING ON A HUMAN who may be in another of their conversations (or gone) — report
    // it IMMEDIATELY (agent.run.awaiting_approval, cause "chat"), which pings the member's bell with a link
    // that opens THIS conversation; the decision then clears the row again, so an attended prompt costs at
    // most a briefly flashing badge. The clear chains AFTER the notice so an instant decision can never
    // overtake the row it deletes. Best-effort on both legs, like every ledger report.
    const noticeParkedApproval = (tool?: string): Promise<void> => {
      const report = deps.reportRunEvent;
      if (!report || !session) return Promise.resolve();
      return report({
        workspace: principal.workspace,
        kind: "agent.run.awaiting_approval",
        sessionId: id,
        agentId: session.origin?.agentId ?? "default",
        eventKind: "chat",
        message:
          tool !== undefined
            ? `Chat turn is waiting for approval to run ${tool} in conversation ${id}.`
            : `Chat turn is waiting for plan approval in conversation ${id}.`,
        creator: principal.subject,
        cause: "chat",
        ...(tool !== undefined ? { tool } : {}),
      }).catch(() => {});
    };
    const clearAfter = (noticed: Promise<void>): void => {
      void noticed.then(() => deps.clearApprovalNotice?.(principal.workspace, id)).catch(() => {});
    };
    const ask = (request: { name: string; input: unknown }): Promise<PermissionDecision> => {
      const requestId = deps.newId();
      write("permission", { requestId, name: request.name, input: request.input });
      const noticed = noticeParkedApproval(request.name);
      return permissions.wait(requestId, id, controller.signal, request).finally(() => clearAfter(noticed));
    };
    // The hook consults the CURRENT mode per ask (liveMode) — bypass auto-allows, auto asks only for guarded
    // (destructive/governance/credential) actions, default/plan ask. Wired unconditionally (see below): a turn
    // started under bypass could otherwise never regain the gate when the member flips the picker back mid-turn.
    const permit: PermissionHook = withRules(async (request) => {
      const current = await liveMode();
      if (current === "bypass") return "allow";
      if (current === "auto" && !isGuardedAction(request.name, request.effects)) return "allow";
      return ask(request);
    });
    // Plan approval reuses the same park-and-await channel: emit a `plan` ask, resolve via POST /permission.
    // Approval pre-authorizes the plan's DECLARED write tools (LESSON 059 P4, allowedPrompts reinterpreted):
    // the member read exactly what the plan will do, so "plan then execute" no longer stalls at each step —
    // except guarded (destructive/governance/credential) actions, whose consent is never bundled.
    const onPlan = async (plan: string, expectedTools?: string[]): Promise<boolean> => {
      const requestId = deps.newId();
      write("plan", {
        requestId,
        plan,
        ...(expectedTools !== undefined && expectedTools.length > 0 ? { expectedTools } : {}),
      });
      const noticed = noticeParkedApproval(); // no tool = the CP words the ping as a plan review
      const decision = await permissions.wait(requestId, id, controller.signal).finally(() => clearAfter(noticed));
      if (decision === "allow") {
        if (expectedTools !== undefined && expectedTools.length > 0) {
          for (const tool of expectedTools) {
            if (isGuardedAction(tool)) continue;
            rules.set(principal.workspace, id, tool, "allow");
          }
          persistRules(principal.workspace, id);
        }
        // Plan durability (LESSON 059 P6): approval promotes the plan to standing session state — it keeps
        // steering after the memory fold and across a restart; a newer approval replaces it. Best-effort:
        // a stamp failure leaves an approved-but-restart-mortal plan, never a blocked approval.
        void deps.sessions
          .setSessionPlan(principal.workspace, id, { content: plan, approvedAt: deps.now() }, deps.now())
          .catch(() => {});
      }
      return decision === "allow";
    };
    try {
      // O1: same ledger run for the streaming path — the turn outlives this request, so the run settles with
      // the loop, not with the SSE connection.
      await withChatTurnRun(
        deps,
        principal,
        id,
        (collectFailure) =>
          runChat(
            deps,
            principal,
            headers,
            id,
            message,
            references,
            attachments,
            controller.signal,
            {
              onFailedTurn: collectFailure,
              onEvent: (e) => {
                if (e.type === "text_delta") write("delta", { text: e.delta });
                // Live extended-thinking tokens — grow the transcript's reasoning block before the answer streams in.
                else if (e.type === "reasoning_delta") write("reasoning", { text: e.delta });
                // The post-decision event: forward it so the web dismisses the prompt even when the decision was the
                // registry's timeout/disconnect default rather than a click.
                else if (e.type === "permission") write("permission_resolved", { name: e.name, decision: e.decision });
                else if (e.type === "plan") write("plan_presented", { plan: e.plan });
                // The loop is waiting out a transient model failure — surface it so the panel can say WHY the turn
                // is quiet instead of looking frozen (the wait can be minutes under persistentRetry).
                else if (e.type === "retry")
                  write("retry", {
                    attempt: e.attempt,
                    delayMs: e.delayMs,
                    ...(e.persistent === true ? { persistent: true } : {}),
                  });
                // The run switched to the fallback model after sustained failure — one informational line.
                else if (e.type === "fallback") write("fallback", { from: e.from, to: e.to });
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
              // The permit hook is ALWAYS wired — it reads the live mode per ask (bypass auto-allow · auto → ask
              // only guarded · default/plan → HITL + rules), so the chat-header picker applies mid-turn in both
              // directions. plan → planMode + onPlan approval (turn-scoped by construction).
              permit,
              ...(mode === "plan" ? { planMode: true, onPlan } : {}),
              drainInput,
              // Soft interrupt: park the loop's step trigger on the live turn so POST /interrupt can fire it —
              // with queued input (POST /input) the turn continues REDIRECTED; bare it ends "interrupted".
              onInterruptReady: (interrupt) => liveTurns.setInterrupt(principal.workspace, id, interrupt),
              sendMessage,
              spawnTeammate,
              listTeammates,
            },
            canvas,
            agentDraft,
          ),
        controller.signal,
      );
      write("done", {});
    } catch (err) {
      write("error", { message: err instanceof AppError ? err.message : "Internal error" });
    } finally {
      stopHeartbeat();
      liveTurns.end(principal.workspace, id);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  // Re-attach to the session's LIVE turn (the panel switched conversations and came back, another tab, or a
  // recovered network drop — the turn kept running headless). 204 = nothing live. Replays what the attacher
  // missed — the in-flight assistant buffers plus every parked ask still awaiting a decision — then subscribes
  // until the turn's terminal done/error. Persisted records are NOT replayed here (GET /messages owns those;
  // the panel hydrates and merges by id). Visibility-aware like the transcript reads.
  app.get("/agent/sessions/:id/stream", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    const snapshot = liveTurns.snapshot(principal.workspace, id);
    if (!snapshot) return reply.code(204).send();
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (event: string, data: unknown): void => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stopHeartbeat = startSseHeartbeat(reply.raw);
    if (snapshot.streamingReasoning.length > 0) write("reasoning", { text: snapshot.streamingReasoning });
    if (snapshot.streamingText.length > 0) write("delta", { text: snapshot.streamingText });
    // Parked write-tool asks (a plan ask parks nameless — it is replayed from the snapshot instead).
    for (const p of permissions.pendingFor(id)) if (p.name.length > 0) write("permission", p);
    if (snapshot.pendingPlan) write("plan", snapshot.pendingPlan);
    // An in-progress retry wait — the attacher should see WHY the turn is quiet, not a frozen panel.
    if (snapshot.pendingRetry) write("retry", snapshot.pendingRetry);
    const detach = liveTurns.attach(principal.workspace, id, (event, data) => {
      write(event, data);
      if (event === "done" || event === "error") {
        stopHeartbeat();
        reply.raw.end();
      }
    });
    if (!detach) {
      // The turn settled between the snapshot and the subscribe — nothing more will come.
      write("done", {});
      stopHeartbeat();
      reply.raw.end();
      return;
    }
    req.raw.on("close", () => {
      stopHeartbeat();
      detach();
    });
  });

  // Explicitly stop the session's live turn — the web's Stop button (a client disconnect no longer aborts the
  // loop). The abort settles the loop, whose terminal event closes every attached stream. 404 when nothing is
  // live. Visibility-aware like /permission: any member may stop a workspace-visible discussion session's turn.
  app.post("/agent/sessions/:id/stop", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    // Force-kill authority: an ADMIN may stop any conversation's turn in their workspace — the safety
    // control cannot be gated on visibility (a runaway agent in a private session must be stoppable by
    // someone other than its owner). The live-turn registry is keyed by (workspace, id), so an admin stop
    // can never reach across workspaces; for everyone else the visibility rule answers 404 as before.
    if (!session && !principal.roles.includes("admin"))
      return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    if (!liveTurns.stop(principal.workspace, id))
      return reply.code(404).send({ code: "NOT_FOUND", message: "No live turn for that conversation." });
    // A redirect (POST /interrupt with a message) queues into the mailbox and the loop absorbs it at its next
    // boundary — a stop that lands first means that boundary never comes. Drop what is still queued and hand the
    // member's own messages back: undrained, they would silently prepend themselves to some LATER turn, and
    // dropped silently they would exist nowhere at all. The caller puts them back in the composer.
    const dropped = mailbox
      .clear(principal.workspace, id)
      .filter((envelope) => envelope.from === "user")
      .map((envelope) => envelope.content);
    return reply.send({ ok: true, dropped });
  });

  // Soft-interrupt the session's live turn (Claude Code's ESC): abort only the IN-FLIGHT step — the loop
  // survives and either continues REDIRECTED (input was queued via POST /input first) or ends "interrupted"
  // (bare — stop and wait for the user). Distinct from /stop, which kills the whole turn. 404 when nothing is
  // live or the loop hasn't parked its trigger yet. Visibility-aware like /stop.
  app.post("/agent/sessions/:id/interrupt", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const { id } = idParams.parse(req.params);
    const parsed = z.object({ message: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const session = await deps.sessions.getVisibleSession(principal.workspace, principal.subject, id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    // Liveness FIRST, queue second (atomic redirect): a redirect that raced a finishing turn must queue NOTHING —
    // an orphaned mailbox message would silently prepend itself to some future turn. 404 → the caller falls back
    // to a normal send.
    if (!liveTurns.hasInterrupt(principal.workspace, id))
      return reply.code(404).send({ code: "NOT_FOUND", message: "No interruptible turn for that conversation." });
    if (parsed.data.message !== undefined)
      deliver(principal.workspace, id, { from: "user", content: parsed.data.message });
    liveTurns.interrupt(principal.workspace, id);
    return reply.send({ ok: true });
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
    // Dismissal clears the durable config too — otherwise the boot restore would resurrect the teammate.
    await deps.sessions.setSessionTeammate(principal.workspace, id, null, deps.now()).catch(() => {});
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
      const { workspace, recipient, kind, source, message, payload } = parsed.data;
      const notified =
        recipient !== undefined
          ? fanEvent(workspace, recipient, kind, source, taskFanContent(kind, message, payload))
          : 0;
      const activated = activator ? await activator.onEvent({ workspace, ...eventOf(parsed.data) }) : 0;
      // Third consumer of the same fact: conversations that PARKED on it. Awaited like the activation so the caller's
      // 200 means "delivered everywhere", and failures inside are already contained per-session.
      const resumed = resumer
        ? await resumer.onEvent({
            workspace,
            kind,
            message,
            ...(source ? { source } : {}),
            ...(payload ? { payload } : {}),
          })
        : 0;
      return reply.send({ notified, activated, resumed });
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
      taskFanContent(parsed.data.kind, parsed.data.message, parsed.data.payload),
    );
    // A member-driven event also matches the registry (the manual "fire this at my agent" path).
    const activated = activator
      ? await activator.onEvent({ workspace: principal.workspace, ...eventOf(parsed.data) })
      : 0;
    const resumed = resumer
      ? await resumer.onEvent({
          workspace: principal.workspace,
          kind: parsed.data.kind,
          message: parsed.data.message,
          ...(parsed.data.source ? { source: parsed.data.source } : {}),
          ...(parsed.data.payload ? { payload: parsed.data.payload } : {}),
        })
      : 0;
    return reply.send({ notified, activated, resumed });
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

  // CP → agent (T-d): run ONE agent for ONE reaction-step key, now. Idempotent — a retry returns the
  // EXISTING session (durable (agent, eventId) dedup), so the workflow keeps watching instead of
  // double-running. 200 {sessionId} = watch it; 200 {skipped} = permanently not runnable (chain stops);
  // 503 = transiently busy (the activity retries later).
  // The envelope is passed THROUGH, not rebuilt: it is produced by `verifierEnvelopeFor` on the control
  // plane, where the evidence lives. A runner that assembled its own scope would put the guarantee in
  // whichever implementation happened to be wired — the arrangement the protocol doc refused to write.
  // THE WIRE IS A BOUNDARY, and the envelope is the boundary's whole point (arch-review 24 P1). Accepting it
  // as an opaque record and casting it into the turn meant every structural guarantee the caller built —
  // writes empty, resources pinned to the evidence, role verifier — was a property of the SENDER, re-asserted
  // nowhere. An envelope arriving with `reads: "all"` and no resources would have run as a verification.
  const verifySchema = z.object({
    workspace: z.string().min(1),
    actingAs: z.string().min(1),
    // THE PROCEDURE, not a question (arch-review 25 P0-4). The caller sends the platform's constitution
    // verbatim and this turn renders exactly that, echoing its digest so the caller can refuse a verdict
    // reached under anything else. A free-form instruction from the requester used to be the whole prompt.
    policy: z.object({
      version: z.number().int().positive(),
      text: z.string().min(1),
      digest: z.string().min(1),
    }),
    // The requester's focus: where to look. Bounded, and rendered subordinate to the policy.
    focus: z.string().min(1).max(600).optional(),
    // The exact artifacts this verification was planned against (arch-review 26 P0). Enforced at the READER:
    // a read observing a different identity is refused, so the model never reasons over evidence from a world
    // the plan did not see.
    evidencePins: z
      .array(
        z.object({
          type: z.string().min(1),
          id: z.string().min(1),
          identity: z.object({
            scoringRevision: z.number().int().nonnegative().optional(),
            scorePlaneDigest: z.string().optional(),
          }),
        }),
      )
      .optional(),
    envelope: TaskEnvelopeSchema,
    // The claim under review, carried verbatim so the verifier can be shown WHAT is asserted and not only the
    // artifacts. Its digest is echoed back and compared by the caller.
    claim: z.object({
      subject: z.object({ type: z.literal("checkpoint"), id: z.string().min(1) }),
      goal: z.string().min(1),
      statements: z
        .array(
          z.object({
            statement: z.string().min(1),
            refs: z.array(z.object({ type: z.string().min(1), id: z.string().min(1) })),
          }),
        )
        .min(1),
      digest: z.string().min(1),
    }),
  });
  const directActivationSchema = z.object({
    workspace: z.string().min(1),
    agentId: z.string().min(1),
    eventId: z.string().min(1),
    eventKind: z.string().min(1),
    message: z.string().min(1),
    payload: z.record(z.unknown()).optional(),
    subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
    instruction: z.string().min(1).optional(),
  });
  app.post("/internal/activations", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
    if (!activator) return reply.code(404).send({ code: "NOT_FOUND", message: "Activations are not configured." });
    const parsed = directActivationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await activator.activateDirect(parsed.data));
    } catch (err) {
      return reply
        .code(503)
        .send({ code: "UNAVAILABLE", message: err instanceof Error ? err.message : "activation busy" });
    }
  });

  // CP → agent (T-d): a reaction step's watch poll. "pending" = the session row does not exist yet (the run
  // is still queued behind the per-agent chain) — the workflow keeps polling under its own step budget.
  app.get<{ Params: { sessionId: string }; Querystring: { workspace?: string } }>(
    "/internal/activations/:sessionId/status",
    async (req, reply) => {
      const presented = req.headers["x-internal-token"];
      if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
        return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
      const workspace = req.query.workspace;
      if (workspace === undefined || workspace === "")
        return reply.code(400).send({ code: "BAD_REQUEST", message: "workspace query is required." });
      const session = await deps.sessions.getVisibleSession(workspace, "everdict", req.params.sessionId);
      return reply.send({ status: session?.status ?? "pending" });
    },
  );

  // Acks 202 and runs the turn DETACHED (a HITL approval can park it for minutes — never a held request);
  // progress lands on the placeholder comment via the /internal/comment-activity bridge, not this response.
  // THE VERIFIER RUNTIME (ownership protocol, third enforcement site). The control plane builds the
  // evidence-only envelope and asks for a verdict; this runs one bounded turn inside it and reports what came
  // back — including what the RUNTIME saw consumed, which is the half a model cannot be asked about itself.
  //
  // Synchronous on purpose, unlike an activation: a verification's whole product is its verdict, and a
  // fire-and-forget spawn would leave the caller with a session id and no answer.
  app.post("/internal/verify", async (req, reply) => {
    const presented = req.headers["x-internal-token"];
    if (typeof presented !== "string" || !constantTimeEq(presented, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid internal token." });
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    // …and the SHAPE is not enough: a well-formed envelope can still describe something that is not a
    // verification. These four refusals are the separation itself, checked where the bytes arrive rather than
    // trusted from where they were built.
    const envelope = parsed.data.envelope;
    const violation =
      envelope.role !== "verifier"
        ? "an envelope that is not role 'verifier' is not a verification"
        : envelope.scope.writes.length > 0
          ? "a verifier that can write is an actor, not a verifier"
          : envelope.scope.reads === "all"
            ? "a verifier reading the whole workspace is reviewing the executor's context, not its artifact"
            : (envelope.scope.resources ?? []).length === 0
              ? "a verifier with no pinned resources has nothing it is allowed to look at"
              : undefined;
    if (violation)
      return reply.code(400).send({ code: "BAD_REQUEST", message: `refusing this verification: ${violation}.` });
    try {
      const result = await runVerificationTurn({ ...deps, persistentRetry: true } as never, deps.authenticate, {
        workspace: parsed.data.workspace,
        actingAs: parsed.data.actingAs,
        envelope,
        claim: parsed.data.claim,
        policy: parsed.data.policy,
        ...(parsed.data.focus !== undefined ? { focus: parsed.data.focus } : {}),
        ...(parsed.data.evidencePins !== undefined ? { evidencePins: parsed.data.evidencePins } : {}),
      });
      return reply.send(result);
    } catch (err) {
      // A verification that could not RUN is not a verdict — the caller must be able to tell the two apart,
      // so this is an error rather than an `inconclusive` the ledger would file as a judgment.
      return reply
        .code(503)
        .send({ code: "UNAVAILABLE", message: err instanceof Error ? err.message : "verification failed" });
    }
  });

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
        anchorId: z.string().min(1),
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
    rules.hydrate(principal.workspace, id, session.permissionRules ?? {});
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
    // Hydrate BEFORE mutating, so the write-through below persists the stored rules PLUS this one — not just this one.
    rules.hydrate(principal.workspace, id, session.permissionRules ?? {});
    rules.set(principal.workspace, id, parsed.data.tool, parsed.data.decision);
    persistRules(principal.workspace, id);
    return reply.send({ rules: rules.list(principal.workspace, id) });
  });

  app.delete("/agent/sessions/:id/rules/:tool", async (req, reply) => {
    const principal = await principalOf(req, reply);
    if (!principal) return reply;
    const params = z.object({ id: z.string().min(1), tool: z.string().min(1) }).parse(req.params);
    const session = await deps.sessions.getSession(principal.workspace, principal.subject, params.id);
    if (!session) return reply.code(404).send({ code: "NOT_FOUND", message: "Conversation not found." });
    rules.hydrate(principal.workspace, params.id, session.permissionRules ?? {});
    rules.clear(principal.workspace, params.id, params.tool);
    persistRules(principal.workspace, params.id);
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
