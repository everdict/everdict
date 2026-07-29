import type { PermissionDecision, PermissionHook, PermissionRequest } from "@everdict/agent-runtime";
import type { AgentRegistry, AgentSessionStore, TenantKeyStore } from "@everdict/application-control";
import type { AgentSpec, AgentTrigger, AgentTriggerFilter } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import { isGuardedAction } from "./action-policy.js";
import type { AgentMailbox } from "./agent-mailbox.js";

// Registry-driven activation (docs/architecture/agent-automation.md A3): a platform event matches an ENABLED
// crafted agent's declarative triggers → one headless run (a trigger-origin session) executes under an agt_
// token minted as the agent's creator. Durable by construction — subscriptions live in the registry and the
// activation dedup lives on the session record, so an agent-service restart loses nothing.

export interface ActivationEvent {
  workspace: string;
  kind: string;
  message: string;
  eventId?: string;
  subject?: { type: string; id: string };
  payload?: Record<string, unknown>;
  // Provenance chain: "agent:<agentId>:<sessionId>" when an agent run's action caused this fact. An agent
  // never reacts to its own causation (loop guard #1).
  causedBy?: string;
  source?: string;
}

// Pure predicate: one trigger subscribes to this event when the kind is listed AND every filter passes
// against the event's pointer payload.
export function triggerMatches(trigger: AgentTrigger, event: ActivationEvent): boolean {
  if (!(trigger.kinds as readonly string[]).includes(event.kind)) return false;
  const payload = event.payload ?? {};
  return trigger.filters.every((filter) => filterPasses(filter, payload));
}

function filterPasses(filter: AgentTriggerFilter, payload: Record<string, unknown>): boolean {
  const actual = payload[filter.field];
  switch (filter.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return actual === filter.value;
    case "neq":
      return actual !== filter.value;
    default: {
      if (typeof actual !== "number" || typeof filter.value !== "number") return false;
      if (filter.op === "lt") return actual < filter.value;
      if (filter.op === "lte") return actual <= filter.value;
      if (filter.op === "gt") return actual > filter.value;
      return actual >= filter.value;
    }
  }
}

export interface AgentActivatorDeps {
  registry: AgentRegistry;
  keyStore: TenantKeyStore;
  sessions: AgentSessionStore;
  mailbox: AgentMailbox;
  // One request-less turn over the run's session (the teammate-turn machinery) — injected so tests own it.
  // permit is the run's mode-derived approval hook (undefined = bypass: no gate).
  runTurn: (sessionId: string, agentToken: string, signal: AbortSignal, permit?: PermissionHook) => Promise<void>;
  // Park a mutation for member approval (agent-automation A6): the shared PermissionRegistry the fleet view
  // discovers via GET /pending and answers via POST /permission. Absent → headless mutations are DENIED under
  // default/auto (never silently allowed — fail closed when there is no one to ask).
  // Park a mutation for a human decision. ctx carries what the DURABLE park (A6) records on the control
  // plane: the workspace, the session, and the registered agent behind the activation.
  waitApproval?: (
    ctx: { workspace: string; sessionId: string; agentId?: string },
    request: PermissionRequest,
    signal: AbortSignal,
  ) => Promise<PermissionDecision>;
  now: () => string;
  newId: () => string;
  // Loop guard #2: minimum spacing between activations of the same (agent, kind). Default 30s.
  cooldownMs?: number;
  // Backpressure: activations queued per agent beyond this are dropped (logged), never piled up. Default 3.
  maxQueued?: number;
  // Report agent.run.* lifecycle FACTS back to the control plane (event log → fleet observability, agent-
  // automation A5). Best-effort — an unreachable control plane never affects the run.
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
    budgetUsd?: number; // the delegated slice (A7/§5.2) — becomes the run's envelope on the CP
  }) => Promise<void>;
}

export class AgentActivator {
  private readonly chains = new Map<string, Promise<void>>(); // per-agent serialization (one run at a time)
  private readonly pending = new Map<string, number>();
  private readonly lastActivation = new Map<string, number>(); // `${ws}:${agent}:${kind}` → epoch ms
  private readonly controllers = new Map<string, AbortController>(); // live runs, by session id (stop control)
  private readonly stopped = new Set<string>(); // session ids stopped by a member (settle as cancelled, not failed)
  private readonly cooldownMs: number;
  private readonly maxQueued: number;

  constructor(private readonly deps: AgentActivatorDeps) {
    this.cooldownMs = deps.cooldownMs ?? 30_000;
    this.maxQueued = deps.maxQueued ?? 3;
  }

  // Match the event against the workspace's enabled agents and LAUNCH a run per match (fire-and-forget,
  // serialized per agent). Returns how many activations were started — the matching itself is awaited (fast
  // registry reads), the runs are not (they hold full agent turns).
  async onEvent(event: ActivationEvent): Promise<number> {
    let entries: Awaited<ReturnType<AgentRegistry["list"]>>;
    try {
      entries = await this.deps.registry.list(event.workspace);
    } catch {
      return 0; // registry unreachable — the reconcile loop will retry this event later
    }
    let activated = 0;
    for (const entry of entries) {
      let spec: AgentSpec;
      try {
        spec = await this.deps.registry.get(event.workspace, entry.id, "latest");
      } catch {
        continue;
      }
      if (!spec.enabled || spec.triggers.length === 0) continue;
      if (!spec.triggers.some((trigger) => triggerMatches(trigger, event))) continue;
      // Loop guard #1: never react to a fact this agent's own run caused.
      if (event.causedBy?.startsWith(`agent:${entry.id}:`)) continue;
      // The run acts AS the agent's creator (acts-as-enabling-member identity) — no creator, no principal.
      const creator = entry.createdBy;
      if (!creator) {
        console.error(`[agent] activation skipped: agent ${entry.id} has no creator to act as (seed/_shared).`);
        continue;
      }
      // Loop guard #2: per-(agent, kind) cooldown.
      const cooldownKey = `${event.workspace}:${entry.id}:${event.kind}`;
      const nowMs = Date.parse(this.deps.now());
      const last = this.lastActivation.get(cooldownKey);
      if (last !== undefined && nowMs - last < this.cooldownMs) continue;
      // Durable dedup: one run per (agent, event) — at-least-once delivery (push + reconcile) collapses here.
      if (event.eventId !== undefined) {
        try {
          if (await this.deps.sessions.hasTriggerSession(event.workspace, entry.id, event.eventId)) continue;
        } catch {
          continue; // can't prove novelty → don't risk a duplicate run
        }
      }
      // Backpressure: drop (visibly) instead of piling up behind a slow agent.
      const agentKey = `${event.workspace}:${entry.id}`;
      if ((this.pending.get(agentKey) ?? 0) >= this.maxQueued) {
        console.error(`[agent] activation dropped for ${entry.id}: ${this.maxQueued} runs already queued.`);
        continue;
      }
      this.lastActivation.set(cooldownKey, nowMs);
      activated++;
      this.enqueueRun(agentKey, event, entry.id, spec, creator);
    }
    return activated;
  }

  // Wait for every queued run to settle (tests + graceful shutdown).
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  // A6 resume leg: a decision arrived for a park whose in-process wait is GONE (an agent-service restart) —
  // the TRANSCRIPT is the durable state, so the run resumes as ONE continuation turn on the same session,
  // seeded with the decision. An approve pre-authorizes the FIRST re-ask of that same tool (the agent
  // re-issues the call it parked on); everything else goes back through the normal mode-derived gate.
  // Fire-and-forget like activations (serialized on the same per-agent chain); validation is synchronous.
  async resumeApproval(input: {
    workspace: string;
    sessionId: string;
    decision: PermissionDecision;
    request: { name: string; input?: unknown };
    decidedBy?: string;
  }): Promise<{ resumed: boolean; reason?: string }> {
    // A live run means the wait is still in-process — the delivery path resolves it; resume only a dead park.
    if (this.controllers.has(input.sessionId)) return { resumed: false, reason: "run is live (deliver instead)" };
    // Headless runs are workspace-visible, so any subject passes the visibility lookup.
    const session = await this.deps.sessions.getVisibleSession(input.workspace, "everdict", input.sessionId);
    if (!session) return { resumed: false, reason: "session not found" };
    const agentId = session.origin?.type === "trigger" ? session.origin.agentId : undefined;
    const creator = session.owner;
    if (!agentId || !creator) return { resumed: false, reason: "not a resumable trigger run" };
    let spec: AgentSpec;
    try {
      spec = await this.deps.registry.get(input.workspace, agentId, session.origin?.agentVersion ?? "latest");
    } catch {
      return { resumed: false, reason: "agent spec unavailable" };
    }
    const agentKey = `${input.workspace}:${agentId}`;
    const prev = this.chains.get(agentKey) ?? Promise.resolve();
    const next = prev
      .then(() => this.runResumeTurn(input, agentId, spec, creator))
      .catch((err) => {
        console.error(`[agent] approval resume failed for ${agentId}:`, err instanceof Error ? err.message : err);
      });
    this.chains.set(agentKey, next);
    return { resumed: true };
  }

  private async runResumeTurn(
    input: {
      workspace: string;
      sessionId: string;
      decision: PermissionDecision;
      request: { name: string; input?: unknown };
      decidedBy?: string;
    },
    agentId: string,
    spec: AgentSpec,
    creator: string,
  ): Promise<void> {
    const { workspace, sessionId } = input;
    // The pseudo-event shell the permit/report plumbing rides — the resume is caused by the decision, not a
    // platform event, so it is deliberately NOT trigger-matchable input (no eventId, no dedup interplay).
    const event: ActivationEvent = {
      workspace,
      kind: "approval.decided",
      source: "approval",
      message: `Approval decision for ${input.request.name}`,
    };
    // P3: the continuation turn is a NEW run on the ledger (same session group as the interrupted one).
    const runId = this.deps.newId();
    const runRef = {
      runId,
      creator,
      agentVersion: spec.version,
      ...(spec.budgetUsd !== undefined ? { budgetUsd: spec.budgetUsd } : {}),
    };
    await this.deps.sessions.setSessionStatus(workspace, sessionId, "running", this.deps.now());
    await this.deps.sessions.setSessionRunId(workspace, sessionId, runId, this.deps.now()).catch(() => {});
    void this.report(
      "agent.run.started",
      event,
      agentId,
      sessionId,
      `Agent ${agentId} resumed after an approval decision (${input.request.name}).`,
      runRef,
    );
    const { token, id: keyId } = await issueAgentToken(
      this.deps.keyStore,
      workspace,
      creator,
      ["write"],
      `agent:${agentId}`,
    );
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    try {
      const verdict = input.decision === "allow" ? "APPROVED" : "DENIED";
      const guidance =
        input.decision === "allow"
          ? "The next call to that tool is pre-approved — perform the action now, then continue the task from where you left off."
          : "Do not perform that action. Adapt and continue (or conclude) the task from where you left off.";
      this.deps.mailbox.enqueue(workspace, sessionId, {
        from: "event",
        sender: "approval",
        content: `[approval decision] Your earlier request to run the tool "${input.request.name}" was ${verdict}${input.decidedBy ? ` by ${input.decidedBy}` : ""} while this run was suspended. ${guidance}`,
      });
      const base = this.buildPermit(event, agentId, sessionId, spec, controller.signal, runRef);
      let approvedOnce = input.decision === "allow" ? input.request.name : undefined;
      const permit: PermissionHook | undefined = base
        ? async (request) => {
            if (approvedOnce !== undefined && request.name === approvedOnce) {
              approvedOnce = undefined; // one shot — a second identical ask parks like any other mutation
              return "allow";
            }
            return base(request);
          }
        : undefined;
      await this.deps.runTurn(sessionId, token, controller.signal, permit);
      const settled = this.stopped.has(sessionId) ? "cancelled" : "completed";
      await this.deps.sessions.setSessionStatus(workspace, sessionId, settled, this.deps.now());
      void this.report(
        settled === "cancelled" ? "agent.run.cancelled" : "agent.run.completed",
        event,
        agentId,
        sessionId,
        `Agent ${agentId} run ${settled} (resumed after approval).`,
        runRef,
      );
    } catch (err) {
      const settled = this.stopped.has(sessionId) ? "cancelled" : "failed";
      await this.deps.sessions.setSessionStatus(workspace, sessionId, settled, this.deps.now()).catch(() => {});
      void this.report(
        settled === "cancelled" ? "agent.run.cancelled" : "agent.run.failed",
        event,
        agentId,
        sessionId,
        `Agent ${agentId} run ${settled} (resumed after approval)${err instanceof Error ? `: ${err.message}` : ""}.`,
        runRef,
      );
    } finally {
      this.controllers.delete(sessionId);
      this.stopped.delete(sessionId);
      await this.deps.keyStore.revoke(workspace, keyId, creator).catch(() => {});
    }
  }

  // Member stop (fleet view control): abort the live run's loop; the wrapper settles it as cancelled.
  // Returns false when the session has no live run here (already settled / not this process).
  stop(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    this.stopped.add(sessionId);
    controller.abort();
    return true;
  }

  private enqueueRun(agentKey: string, event: ActivationEvent, agentId: string, spec: AgentSpec, creator: string) {
    this.pending.set(agentKey, (this.pending.get(agentKey) ?? 0) + 1);
    const prev = this.chains.get(agentKey) ?? Promise.resolve();
    const next = prev
      .then(() => this.activate(event, agentId, spec, creator))
      .catch((err) => {
        console.error(`[agent] activation failed for ${agentId}:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.pending.set(agentKey, Math.max(0, (this.pending.get(agentKey) ?? 1) - 1));
      });
    this.chains.set(agentKey, next);
  }

  private async activate(event: ActivationEvent, agentId: string, spec: AgentSpec, creator: string): Promise<void> {
    const sessionId = this.deps.newId();
    // P3: one activation = one Run{kind:"agent"} on the CP's universal ledger — minted here, threaded
    // through every report (started opens it, the terminal report settles it), stamped on the session.
    const runId = this.deps.newId();
    const now = this.deps.now();
    await this.deps.sessions.createSession({
      id: sessionId,
      tenant: event.workspace,
      owner: creator,
      title: `${agentId} — ${event.kind}`,
      ...(spec.permissionMode !== undefined ? { permissionMode: spec.permissionMode } : {}),
      // Workspace-visible by design: a headless run is workspace observability (the fleet view + any member
      // drilling into its transcript), not the creator's private chat history.
      visibility: "workspace",
      origin: {
        type: "trigger",
        agentId,
        agentVersion: spec.version,
        ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
        eventKind: event.kind,
      },
      status: "running",
      runId,
      createdAt: now,
      updatedAt: now,
    });
    const runRef = {
      runId,
      creator,
      agentVersion: spec.version,
      ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
      // The delegated slice (A7 → §5.2): the CP stamps it as the run's envelope — caused work draws from it.
      ...(spec.budgetUsd !== undefined ? { budgetUsd: spec.budgetUsd } : {}),
    };
    void this.report("agent.run.started", event, agentId, sessionId, `Agent ${agentId} woke on ${event.kind}.`, runRef);
    // One-shot execution credential: minted for this run, revoked with it (no standing token accumulation).
    const { token, id: keyId } = await issueAgentToken(
      this.deps.keyStore,
      event.workspace,
      creator,
      ["write"],
      `agent:${agentId}`,
    );
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    try {
      this.deps.mailbox.enqueue(event.workspace, sessionId, {
        from: "event",
        sender: event.source ?? event.kind,
        content: renderActivationPrompt(spec, event),
      });
      const permit = this.buildPermit(event, agentId, sessionId, spec, controller.signal, runRef);
      await this.deps.runTurn(sessionId, token, controller.signal, permit);
      const settled = this.stopped.has(sessionId) ? "cancelled" : "completed";
      await this.deps.sessions.setSessionStatus(event.workspace, sessionId, settled, this.deps.now());
      void this.report(
        settled === "cancelled" ? "agent.run.cancelled" : "agent.run.completed",
        event,
        agentId,
        sessionId,
        `Agent ${agentId} run ${settled} (${event.kind}).`,
        runRef,
      );
    } catch (err) {
      const settled = this.stopped.has(sessionId) ? "cancelled" : "failed";
      await this.deps.sessions.setSessionStatus(event.workspace, sessionId, settled, this.deps.now()).catch(() => {});
      void this.report(
        settled === "cancelled" ? "agent.run.cancelled" : "agent.run.failed",
        event,
        agentId,
        sessionId,
        `Agent ${agentId} run ${settled} (${event.kind})${err instanceof Error ? `: ${err.message}` : ""}.`,
        runRef,
      );
      if (settled === "failed") throw err;
    } finally {
      this.controllers.delete(sessionId);
      this.stopped.delete(sessionId);
      await this.deps.keyStore.revoke(event.workspace, keyId, creator).catch(() => {});
    }
  }

  // The run's mode-derived approval hook (agent-automation A6). bypass → no gate (undefined). auto → guarded
  // (destructive/governance/credential) actions park, the rest run. default AND plan → every mutation parks
  // (a headless plan has no plan-approval channel, so it degrades to ask-per-mutation, never to silent allow).
  // Parking flips the run to awaiting_approval (+ a lifecycle fact) so the fleet view surfaces the ask; the
  // member answers through the same GET /pending → POST /permission channel the discussion turn uses. With no
  // waitApproval wired, gated mutations are DENIED — fail closed when there is nobody to ask.
  private buildPermit(
    event: ActivationEvent,
    agentId: string,
    sessionId: string,
    spec: AgentSpec,
    signal: AbortSignal,
    run?: { runId: string; creator?: string; agentVersion?: string; eventId?: string; budgetUsd?: number },
  ): PermissionHook | undefined {
    const mode = spec.permissionMode ?? "default";
    if (mode === "bypass") return undefined;
    return async (request) => {
      if (mode === "auto" && !isGuardedAction(request.name)) return "allow";
      const wait = this.deps.waitApproval;
      if (!wait) return "deny";
      await this.deps.sessions
        .setSessionStatus(event.workspace, sessionId, "awaiting_approval", this.deps.now())
        .catch(() => {});
      void this.report(
        "agent.run.awaiting_approval",
        event,
        agentId,
        sessionId,
        `Agent ${agentId} is waiting for approval to run ${request.name}.`,
        run,
      );
      try {
        return await wait({ workspace: event.workspace, sessionId, agentId }, request, signal);
      } finally {
        await this.deps.sessions
          .setSessionStatus(event.workspace, sessionId, "running", this.deps.now())
          .catch(() => {});
      }
    };
  }

  // agent.run.* lifecycle FACT back to the control plane — best-effort, never affects the run. `run` is
  // the P3 ledger correlation (runId + who/what the activation acts as) — absent on legacy call paths.
  private report(
    kind:
      | "agent.run.started"
      | "agent.run.awaiting_approval"
      | "agent.run.completed"
      | "agent.run.failed"
      | "agent.run.cancelled",
    event: ActivationEvent,
    agentId: string,
    sessionId: string,
    message: string,
    run?: { runId: string; creator?: string; agentVersion?: string; eventId?: string; budgetUsd?: number },
  ): Promise<void> {
    return (
      this.deps.reportRunEvent?.({
        workspace: event.workspace,
        kind,
        sessionId,
        agentId,
        eventKind: event.kind,
        message,
        ...(run !== undefined ? run : {}),
      }) ?? Promise.resolve()
    ).catch(() => {});
  }
}

// Reconcile loop (agent-automation A1's durability ladder): pushes are best-effort, so the agent service walks
// the control plane's deployment-wide event cursor at an interval and re-feeds anything missed into the SAME
// activation path — the durable (agent, event) dedup makes at-least-once safe. Events older than windowMs are
// skipped (post-restart staleness bound: a week-old completion must not wake an agent today). Teammate fan-out
// is deliberately NOT reconciled (mailboxes have no dedup — a replayed wake would duplicate messages).
export function startEventReconcile(opts: {
  controlPlaneUrl: string;
  internalToken: string;
  onEvent: (event: ActivationEvent) => Promise<number>;
  intervalMs?: number; // default 60s
  windowMs?: number; // default 60min
  batch?: number; // default 200
}): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;
  const windowMs = opts.windowMs ?? 60 * 60_000;
  const batch = opts.batch ?? 200;
  let cursor = 0;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const url = new URL("/internal/events", opts.controlPlaneUrl);
        url.searchParams.set("after", String(cursor));
        url.searchParams.set("limit", String(batch));
        const res = await fetch(url, { headers: { "x-internal-token": opts.internalToken } });
        if (!res.ok) return;
        const body = (await res.json()) as { events?: ReconciledEvent[] };
        const events = body.events ?? [];
        if (events.length === 0) return;
        for (const ev of events) {
          cursor = Math.max(cursor, ev.seq);
          if (Date.now() - Date.parse(ev.createdAt) > windowMs) continue;
          await opts.onEvent({
            workspace: ev.tenant,
            kind: ev.kind,
            message: ev.message,
            eventId: ev.id,
            subject: ev.subject,
            payload: ev.payload,
            ...(ev.causedBy !== undefined && ev.causedBy !== null ? { causedBy: ev.causedBy } : {}),
            source: `${ev.subject.type} ${ev.subject.id}`,
          });
        }
        if (events.length < batch) return;
      }
    } catch {
      // Best-effort — the next tick retries from the same cursor.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

interface ReconciledEvent {
  seq: number;
  id: string;
  tenant: string;
  kind: string;
  subject: { type: string; id: string };
  payload: Record<string, unknown>;
  causedBy?: string | null;
  message: string;
  createdAt: string;
}

// The run's opening prompt: the crafted agent's standing task first (its job), then the fact that woke it —
// pointers only; the agent reads detail through its (RBAC-bounded) tools. Exported for the try-drive (B3),
// which renders the same prompt shape for a shadow activation.
export function renderActivationPrompt(spec: Pick<AgentSpec, "task">, event: ActivationEvent): string {
  const lines: string[] = [];
  if (spec.task !== undefined && spec.task.length > 0) lines.push(`Your standing task:\n${spec.task}`);
  lines.push(`Platform event — ${event.kind}${event.source ? ` (${event.source})` : ""}:\n${event.message}`);
  if (event.subject) lines.push(`Subject: ${event.subject.type} ${event.subject.id}`);
  if (event.payload && Object.keys(event.payload).length > 0) lines.push(`Details: ${JSON.stringify(event.payload)}`);
  return lines.join("\n\n");
}
