import type { AgentRegistry, AgentSessionStore, TenantKeyStore } from "@everdict/application-control";
import type { AgentSpec, AgentTrigger, AgentTriggerFilter } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
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
  runTurn: (sessionId: string, agentToken: string) => Promise<void>;
  now: () => string;
  newId: () => string;
  // Loop guard #2: minimum spacing between activations of the same (agent, kind). Default 30s.
  cooldownMs?: number;
  // Backpressure: activations queued per agent beyond this are dropped (logged), never piled up. Default 3.
  maxQueued?: number;
}

export class AgentActivator {
  private readonly chains = new Map<string, Promise<void>>(); // per-agent serialization (one run at a time)
  private readonly pending = new Map<string, number>();
  private readonly lastActivation = new Map<string, number>(); // `${ws}:${agent}:${kind}` → epoch ms
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
    const now = this.deps.now();
    await this.deps.sessions.createSession({
      id: sessionId,
      tenant: event.workspace,
      owner: creator,
      title: `${agentId} — ${event.kind}`,
      ...(spec.permissionMode !== undefined ? { permissionMode: spec.permissionMode } : {}),
      origin: {
        type: "trigger",
        agentId,
        agentVersion: spec.version,
        ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
        eventKind: event.kind,
      },
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    // One-shot execution credential: minted for this run, revoked with it (no standing token accumulation).
    const { token, id: keyId } = await issueAgentToken(
      this.deps.keyStore,
      event.workspace,
      creator,
      ["write"],
      `agent:${agentId}`,
    );
    try {
      this.deps.mailbox.enqueue(event.workspace, sessionId, {
        from: "event",
        sender: event.source ?? event.kind,
        content: renderActivationPrompt(spec, event),
      });
      await this.deps.runTurn(sessionId, token);
      await this.deps.sessions.setSessionStatus(event.workspace, sessionId, "completed", this.deps.now());
    } catch (err) {
      await this.deps.sessions.setSessionStatus(event.workspace, sessionId, "failed", this.deps.now()).catch(() => {});
      throw err;
    } finally {
      await this.deps.keyStore.revoke(event.workspace, keyId, creator).catch(() => {});
    }
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
// pointers only; the agent reads detail through its (RBAC-bounded) tools.
function renderActivationPrompt(spec: AgentSpec, event: ActivationEvent): string {
  const lines: string[] = [];
  if (spec.task !== undefined && spec.task.length > 0) lines.push(`Your standing task:\n${spec.task}`);
  lines.push(`Platform event — ${event.kind}${event.source ? ` (${event.source})` : ""}:\n${event.message}`);
  if (event.subject) lines.push(`Subject: ${event.subject.type} ${event.subject.id}`);
  if (event.payload && Object.keys(event.payload).length > 0) lines.push(`Details: ${JSON.stringify(event.payload)}`);
  return lines.join("\n\n");
}
