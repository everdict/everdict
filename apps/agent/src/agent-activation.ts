import type { PermissionDecision, PermissionHook, PermissionRequest } from "@everdict/agent-runtime";
import type { AgentRegistry, AgentSessionStore, TenantKeyStore } from "@everdict/application-control";
import type {
  AgentSpec,
  AgentTrigger,
  HandoffCheckpoint,
  SubscriptionRecord,
  TaskEnvelope,
  TraceEvent,
  TraceSpan,
} from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import { assertTaskEnvelope, eventSelectorMatches } from "@everdict/domain";
import { isGuardedAction } from "./action-policy.js";
import type { AgentMailbox } from "./agent-mailbox.js";
import { type AgentTurnUsage, transcriptToTrace } from "./run-trace.js";
import type { AgentRunEventReport } from "./usage.js";

// Registry-driven activation (docs/architecture/agent-automation.md A3): a platform event matches an ENABLED
// crafted agent's declarative triggers → one headless run (a trigger-origin session) executes under an agt_
// token minted as the agent's creator. Durable by construction — subscriptions live in the registry and the
// activation dedup lives on the session record, so an agent-service restart loses nothing.

// What one headless turn reports back to the activation.
export interface TurnOutcome {
  usage?: AgentTurnUsage;
  spans?: TraceSpan[];
  // How the kernel loop ENDED. The activation only acts on one value — "budget_exhausted", the envelope's
  // halt — because that is the reason the ownership protocol owes a handoff for (halt_checkpoint is the
  // envelope's only exhaustion vocabulary, and a halt with nothing left behind is the failure it exists to
  // prevent). Absent = the turn drained empty or died before the loop ran.
  stopReason?: string;
}

// The envelope this activation runs inside, minus the one part the activation cannot know. `scope` is the
// agent's RESOLVED toolset, and that set only exists once the turn has built its tool registry — so the
// activation states the boundary it owns (goal, budgets, halt vocabulary) and the turn completes the scope.
// An activation's envelope. `scope` is OPTIONAL rather than absent (arch-review 23, verifier wiring): an
// ordinary activation lets the turn complete it from the resolved toolset — the executor posture, where reads
// are the agent's senses — but a role-bound task arrives with its scope ALREADY decided and must keep it. A
// verifier is the case that proves the difference: its envelope is the whole guarantee, and a compose point
// that "completes" it would hand the kernel a widened one to enforce.
export type ActivationEnvelope = Omit<TaskEnvelope, "scope"> & { scope?: TaskEnvelope["scope"] };

// A headless run's own hard bound, in the kernel's own units. Deliberately NOT derived from spec.budgetUsd:
// that is the DELEGATED slice governing the work an activation CAUSES (runs it submits, refused at the
// admission gate with a 402), priced on the control plane where prices live. The loop measures tokens and
// wall-clock and knows nothing about money, so mapping dollars onto it would be a budget nothing checks.
// These are the generous outer walls — a run reaching either has stopped making progress, not stopped early.
const ACTIVATION_TOKEN_BUDGET = 2_000_000;
const ACTIVATION_TIME_BUDGET_SEC = 3_600;

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
// against the event's pointer payload. The law itself lives in @everdict/domain (eventSelectorMatches) —
// agent triggers and E3 subscriptions share the same selector grammar, so they must share the matcher.
export function triggerMatches(trigger: AgentTrigger, event: ActivationEvent): boolean {
  return eventSelectorMatches(trigger, event);
}

// What a restart-recovered run wakes up to (P0 crash reconcile). Mirrors the interrupt kernel's differentiated
// synthetic results: the transcript is complete up to the death, but an in-flight tool call's OUTCOME may be
// unknown — verify before repeating any mutation.
const RESTART_RECOVERY_NOTICE =
  "[restart recovery] This run was interrupted by an agent-service restart before it finished. The transcript above is everything that happened. Continue from where you left off. If your last tool call's outcome is not in the transcript, its effect is UNKNOWN — verify with a read tool before re-issuing any mutating call.";

// One continuation turn on an EXISTING trigger session (approval decision / restart recovery) — what the two
// resume legs hand the shared runner.
interface ContinuationOpts {
  workspace: string;
  sessionId: string;
  agentId: string;
  spec: AgentSpec;
  creator: string;
  event: ActivationEvent; // the pseudo-event shell the permit/report plumbing rides (never trigger-matchable)
  seeds: Array<{ sender: string; content: string }>; // mailbox messages the resumed turn wakes up to
  wrapPermit?: (base: PermissionHook | undefined) => PermissionHook | undefined;
  startedMessage: string;
  settleLabel: string; // report phrasing: "resumed after approval" | "resumed after restart"
}

export interface AgentActivatorDeps {
  registry: AgentRegistry;
  keyStore: TenantKeyStore;
  sessions: AgentSessionStore;
  mailbox: AgentMailbox;
  // One request-less turn over the run's session (the teammate-turn machinery) — injected so tests own it.
  // permit is the run's mode-derived approval hook (undefined = bypass: no gate).
  // Resolves with what the turn spent on the model (undefined = nothing ran / died before its first call) and
  // the SPANS it recorded live (N6) — the activation seals both into the run's trajectory, so a headless run
  // reports its own cost AND its own shape exactly like a chat turn. A runner that records no spans (an older
  // wiring, a turn with no run to hang under) falls back to the transcript projection.
  runTurn: (
    sessionId: string,
    agentToken: string,
    signal: AbortSignal,
    permit?: PermissionHook,
    // The task envelope this run is bound by (ownership O5) — the turn completes its scope from the
    // resolved toolset and hands it to the kernel, which halts the run when a budget is spent.
    envelope?: ActivationEnvelope,
  ) => Promise<TurnOutcome | undefined>;
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
  // E3 subscription source (reaction.kind="agent" rules) — absent = spec triggers only.
  subscriptions?: { listEnabled(workspace: string): Promise<SubscriptionRecord[]> };
  // §5.1 activation admission (the CP tenant budget) — absent = unadmitted (dev wiring). An explicit deny
  // skips the run VISIBLY; the bridge itself fails open on transport errors.
  admitRun?: (workspace: string) => Promise<{ admitted: boolean; reason?: string }>;
  // Report agent.run.* lifecycle FACTS back to the control plane (event log → fleet observability, agent-
  // automation A5), carrying the P3 ledger correlation and the O2 transcript trace. Best-effort — an
  // unreachable control plane never affects the run. One shape, defined once in usage.ts.
  reportRunEvent?: (input: AgentRunEventReport) => Promise<void>;
  // Publish the handoff a halted run owes its successor (ownership O6). Called with the run's own agt_ token,
  // so the checkpoint is attributed like every other write this run made — and BEFORE the token is revoked.
  // Best-effort by contract: a control plane that cannot take the checkpoint must not turn a budget halt into
  // a failed run, and the halt itself is already on the event log either way.
  publishCheckpoint?: (
    agentToken: string,
    checkpoint: Omit<HandoffCheckpoint, "id" | "createdAt" | "createdBy"> & {
      // The suspended envelope's policy slice — admission enforces rollbackRequired ⇒ rollbackPlan from it
      // (envelopes are not persisted, so the producer is the only carrier; stricter-only, safe to declare).
      envelope?: Pick<TaskEnvelope, "id"> & Partial<Pick<TaskEnvelope, "rollbackRequired">>;
    },
  ) => Promise<void>;
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
    const woken = new Set<string>(); // agent ids launched in THIS pass (spec triggers + subscriptions collapse)
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
      if (!(await this.admitted(event.workspace, entry.id))) continue;
      this.lastActivation.set(cooldownKey, nowMs);
      activated++;
      woken.add(entry.id);
      this.enqueueRun(agentKey, event, entry.id, spec, creator);
    }
    activated += await this.onSubscriptions(event, entries, woken);
    return activated;
  }

  // E3 subscriptions with reaction.kind="agent": the registry's rules wake agents through the SAME guards
  // as spec triggers (self-cause skip, durable per-(agent,event) dedup, backpressure) — the cooldown is the
  // subscription's own (governance.cooldownSec, keyed per rule), and an agent whose own trigger already
  // fired on this event is never woken twice in one pass.
  private async onSubscriptions(
    event: ActivationEvent,
    entries: Awaited<ReturnType<AgentRegistry["list"]>>,
    woken: Set<string>,
  ): Promise<number> {
    if (!this.deps.subscriptions) return 0;
    let subscriptions: SubscriptionRecord[];
    try {
      subscriptions = await this.deps.subscriptions.listEnabled(event.workspace);
    } catch {
      return 0; // store unreachable — the reconcile loop will retry this event later
    }
    let activated = 0;
    for (const subscription of subscriptions) {
      if (subscription.reaction.kind !== "agent") continue; // webhook/workflow ride the CP's reaction consumer
      if (!eventSelectorMatches(subscription.selector, event)) continue;
      const agentId = subscription.reaction.agentId;
      if (woken.has(agentId)) continue;
      let spec: AgentSpec;
      try {
        spec = await this.deps.registry.get(event.workspace, agentId, "latest");
      } catch {
        continue; // target vanished since the rule was written — nothing to wake
      }
      if (!spec.enabled) continue;
      if (event.causedBy?.startsWith(`agent:${agentId}:`)) continue;
      const creator = entries.find((entry) => entry.id === agentId)?.createdBy;
      if (!creator) {
        console.error(
          `[agent] subscription ${subscription.id} skipped: agent ${agentId} has no creator to act as (seed/_shared).`,
        );
        continue;
      }
      const cooldownKey = `${event.workspace}:sub:${subscription.id}`;
      const nowMs = Date.parse(this.deps.now());
      const last = this.lastActivation.get(cooldownKey);
      const cooldownMs =
        subscription.governance.cooldownSec !== undefined
          ? subscription.governance.cooldownSec * 1000
          : this.cooldownMs;
      if (last !== undefined && nowMs - last < cooldownMs) continue;
      if (event.eventId !== undefined) {
        try {
          if (await this.deps.sessions.hasTriggerSession(event.workspace, agentId, event.eventId)) continue;
        } catch {
          continue;
        }
      }
      const agentKey = `${event.workspace}:${agentId}`;
      if ((this.pending.get(agentKey) ?? 0) >= this.maxQueued) {
        console.error(`[agent] activation dropped for ${agentId}: ${this.maxQueued} runs already queued.`);
        continue;
      }
      if (!(await this.admitted(event.workspace, agentId))) continue;
      this.lastActivation.set(cooldownKey, nowMs);
      activated++;
      woken.add(agentId);
      this.enqueueRun(agentKey, event, agentId, spec, creator);
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
    const prepared = await this.prepareContinuation(input.workspace, input.sessionId);
    if ("reason" in prepared) return { resumed: false, reason: prepared.reason };
    const verdict = input.decision === "allow" ? "APPROVED" : "DENIED";
    const guidance =
      input.decision === "allow"
        ? "The next call to that tool is pre-approved — perform the action now, then continue the task from where you left off."
        : "Do not perform that action. Adapt and continue (or conclude) the task from where you left off.";
    let approvedOnce = input.decision === "allow" ? input.request.name : undefined;
    this.enqueueContinuation({
      workspace: input.workspace,
      sessionId: input.sessionId,
      ...prepared,
      // The pseudo-event shell the permit/report plumbing rides — the resume is caused by the decision, not a
      // platform event, so it is deliberately NOT trigger-matchable input (no eventId, no dedup interplay).
      event: {
        workspace: input.workspace,
        kind: "approval.decided",
        source: "approval",
        message: `Approval decision for ${input.request.name}`,
      },
      seeds: [
        {
          sender: "approval",
          content: `[approval decision] Your earlier request to run the tool "${input.request.name}" was ${verdict}${input.decidedBy ? ` by ${input.decidedBy}` : ""} while this run was suspended. ${guidance}`,
        },
      ],
      wrapPermit: (base) =>
        base
          ? async (request) => {
              if (approvedOnce !== undefined && request.name === approvedOnce) {
                approvedOnce = undefined; // one shot — a second identical ask parks like any other mutation
                return "allow";
              }
              return base(request);
            }
          : undefined,
      startedMessage: `Agent ${prepared.agentId} resumed after an approval decision (${input.request.name}).`,
      settleLabel: "resumed after approval",
    });
    return { resumed: true };
  }

  // P0 crash reconcile (LESSON 059): continue a run that a process death stranded mid-turn. The TRANSCRIPT is
  // the durable state, so recovery is RESUMPTION of the same session — one continuation turn seeded with a
  // recovery notice — never re-activation: the durable (agent, event) dedup keys on the session's existence,
  // and it stays honest because the stranded session really is being handled. The orphan sweep claims
  // (settles as failed) the row first; this turn flips it back to running and settles it for real.
  async resumeInterrupted(input: {
    workspace: string;
    sessionId: string;
  }): Promise<{ resumed: boolean; reason?: string }> {
    const prepared = await this.prepareContinuation(input.workspace, input.sessionId);
    if ("reason" in prepared) return { resumed: false, reason: prepared.reason };
    this.enqueueContinuation({
      workspace: input.workspace,
      sessionId: input.sessionId,
      ...prepared,
      // Not trigger-matchable input: no eventId, so the recovery never interacts with the activation dedup.
      event: {
        workspace: input.workspace,
        kind: "run.orphaned",
        source: "restart",
        message: "Recovered after an agent-service restart",
      },
      seeds: [{ sender: "restart", content: RESTART_RECOVERY_NOTICE }],
      startedMessage: `Agent ${prepared.agentId} resumed after an agent-service restart.`,
      settleLabel: "resumed after restart",
    });
    return { resumed: true };
  }

  // Shared validation for continuing an EXISTING run (approval decision / restart recovery): the run must not
  // be live in this process, the session must exist, and only a trigger-origin session names the agent (and
  // the creator) the continuation acts as.
  private async prepareContinuation(
    workspace: string,
    sessionId: string,
  ): Promise<{ agentId: string; spec: AgentSpec; creator: string } | { reason: string }> {
    // A live run means the turn is still in-process — the delivery path handles it; resume only a dead one.
    if (this.controllers.has(sessionId)) return { reason: "run is live (deliver instead)" };
    // Headless runs are workspace-visible, so any subject passes the visibility lookup.
    const session = await this.deps.sessions.getVisibleSession(workspace, "everdict", sessionId);
    if (!session) return { reason: "session not found" };
    const agentId = session.origin?.type === "trigger" ? session.origin.agentId : undefined;
    const creator = session.owner;
    if (!agentId || !creator) return { reason: "not a resumable trigger run" };
    try {
      const spec = await this.deps.registry.get(workspace, agentId, session.origin?.agentVersion ?? "latest");
      return { agentId, spec, creator };
    } catch {
      return { reason: "agent spec unavailable" };
    }
  }

  private enqueueContinuation(opts: ContinuationOpts): void {
    const agentKey = `${opts.workspace}:${opts.agentId}`;
    const prev = this.chains.get(agentKey) ?? Promise.resolve();
    const next = prev
      .then(() => this.runContinuationTurn(opts))
      .catch((err) => {
        console.error(
          `[agent] continuation (${opts.settleLabel}) failed for ${opts.agentId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    this.chains.set(agentKey, next);
  }

  // One more turn on an EXISTING trigger session — the same lifecycle shape as a fresh activation (new ledger
  // run, mailbox seed, mode-derived permit, settle + report) minus session creation.
  private async runContinuationTurn(opts: ContinuationOpts): Promise<void> {
    const { workspace, sessionId, agentId, spec, creator, event } = opts;
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
    void this.report("agent.run.started", event, agentId, sessionId, opts.startedMessage, runRef);
    const { token, id: keyId } = await issueAgentToken(
      this.deps.keyStore,
      workspace,
      creator,
      ["write"],
      `agent:${agentId}`,
    );
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    // O2 baseline: the session carries the interrupted run's history — this run's trajectory starts after it.
    const baseSeq = await this.lastSeq(workspace, sessionId);
    try {
      for (const seed of opts.seeds) {
        this.deps.mailbox.enqueue(workspace, sessionId, { from: "event", sender: seed.sender, content: seed.content });
      }
      const base = this.buildPermit(event, agentId, sessionId, spec, controller.signal, runRef);
      const permit = opts.wrapPermit ? opts.wrapPermit(base) : base;
      // O5: a resumed leg is bound exactly like the first one. Without this the boundary had a door in it —
      // an activation that parked for approval (or died and was recovered) came back UNBOUNDED, which is the
      // one moment a long-running task is most likely to keep going. The envelope keys on THIS run's id, so
      // a continuation gets its own budget rather than inheriting a spent one: the ledger says this is a new
      // run, and a per-run bound is the same rule sub-agents follow.
      const envelope = this.envelopeFor(runId, spec, event);
      const outcome = await this.deps.runTurn(sessionId, token, controller.signal, permit, envelope);
      const halted = outcome?.stopReason === "budget_exhausted";
      const handoff = halted
        ? await this.publishHalt(token, envelope, runId, agentId, sessionId, event, outcome)
        : undefined;
      // Same rule as the activation leg: stopped-without-completing is SUSPENDED, never completed.
      const settled = this.stopped.has(sessionId)
        ? "cancelled"
        : halted || outcome?.stopReason === "waiting"
          ? "suspended"
          : "completed";
      await this.deps.sessions.setSessionStatus(workspace, sessionId, settled, this.deps.now());
      void this.report(
        settled === "cancelled"
          ? "agent.run.cancelled"
          : settled === "suspended"
            ? "agent.run.suspended"
            : "agent.run.completed",
        event,
        agentId,
        sessionId,
        settled === "suspended"
          ? halted
            ? `Agent ${agentId} run suspended at its envelope budget (${opts.settleLabel}) — handoff ${handoff ?? "absent"}.`
            : `Agent ${agentId} run suspended on an armed wait (${opts.settleLabel}).`
          : `Agent ${agentId} run ${settled} (${opts.settleLabel}).`,
        runRef,
        ...(await this.turnEvidence(workspace, sessionId, baseSeq, outcome)),
      );
    } catch (err) {
      const settled = this.stopped.has(sessionId) ? "cancelled" : "failed";
      await this.deps.sessions.setSessionStatus(workspace, sessionId, settled, this.deps.now()).catch(() => {});
      void this.report(
        settled === "cancelled" ? "agent.run.cancelled" : "agent.run.failed",
        event,
        agentId,
        sessionId,
        `Agent ${agentId} run ${settled} (${opts.settleLabel})${err instanceof Error ? `: ${err.message}` : ""}.`,
        runRef,
        ...(await this.turnEvidence(workspace, sessionId, baseSeq)),
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

  // T-d step entry (the reaction workflow's activity): run ONE agent for ONE synthetic step key, now.
  // Idempotent by the durable (agent, eventId) dedup — a retry hands back the EXISTING session so the
  // executor keeps watching instead of double-running. Outcomes: {sessionId} = watch it; {skipped} =
  // permanently not runnable (chain should stop); THROW = transiently busy (activity retries later).
  async activateDirect(input: {
    workspace: string;
    agentId: string;
    eventId: string; // the step's dedup key (`<eventId>#s<i>`)
    eventKind: string;
    message: string;
    payload?: Record<string, unknown>;
    subject?: { type: string; id: string };
    instruction?: string;
  }): Promise<{ sessionId: string; started: boolean } | { skipped: string }> {
    const existing = await this.deps.sessions.findTriggerSession(input.workspace, input.agentId, input.eventId);
    if (existing) return { sessionId: existing.id, started: false };
    let spec: AgentSpec;
    try {
      spec = await this.deps.registry.get(input.workspace, input.agentId, "latest");
    } catch {
      return { skipped: `agent ${input.agentId} not found` };
    }
    if (!spec.enabled) return { skipped: `agent ${input.agentId} is disabled` };
    const entries = await this.deps.registry.list(input.workspace).catch(() => []);
    const creator = entries.find((entry) => entry.id === input.agentId)?.createdBy;
    if (!creator) return { skipped: `agent ${input.agentId} has no creator to act as (seed/_shared)` };
    const agentKey = `${input.workspace}:${input.agentId}`;
    if ((this.pending.get(agentKey) ?? 0) >= this.maxQueued)
      throw new Error(`agent ${input.agentId} has ${this.maxQueued} runs queued — retry later`);
    // §5.1: a budget refusal is a PERMANENT answer for this chain (skipped, the workflow stops) — unlike a
    // busy queue, retrying an exhausted budget forever would be the runaway the gate exists to stop.
    if (!(await this.admitted(input.workspace, input.agentId)))
      return { skipped: "workspace budget refused the activation (402)" };
    const sessionId = this.deps.newId();
    const event: ActivationEvent = {
      workspace: input.workspace,
      kind: input.eventKind,
      message: input.message,
      eventId: input.eventId,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      source: "reaction",
    };
    this.enqueueRun(agentKey, event, input.agentId, spec, creator, {
      sessionId,
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    });
    return { sessionId, started: true };
  }

  // The §5.1 ask, shared by every launch path. True when no gate is wired (dev) — refusals are logged
  // (the CP side already emitted/recorded the 402), never silent.
  private async admitted(workspace: string, agentId: string): Promise<boolean> {
    if (!this.deps.admitRun) return true;
    const verdict = await this.deps.admitRun(workspace);
    if (!verdict.admitted)
      console.error(`[agent] activation refused for ${agentId}: ${verdict.reason ?? "budget exceeded"} (402).`);
    return verdict.admitted;
  }

  private enqueueRun(
    agentKey: string,
    event: ActivationEvent,
    agentId: string,
    spec: AgentSpec,
    creator: string,
    opts?: { sessionId?: string; instruction?: string },
  ) {
    this.pending.set(agentKey, (this.pending.get(agentKey) ?? 0) + 1);
    const prev = this.chains.get(agentKey) ?? Promise.resolve();
    const next = prev
      .then(() => this.activate(event, agentId, spec, creator, opts))
      .catch((err) => {
        console.error(`[agent] activation failed for ${agentId}:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.pending.set(agentKey, Math.max(0, (this.pending.get(agentKey) ?? 1) - 1));
      });
    this.chains.set(agentKey, next);
  }

  private async activate(
    event: ActivationEvent,
    agentId: string,
    spec: AgentSpec,
    creator: string,
    opts?: { sessionId?: string; instruction?: string },
  ): Promise<void> {
    const sessionId = opts?.sessionId ?? this.deps.newId();
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
      // A reaction step's standing instruction rides as a second mailbox message — the step tells this agent
      // what its link in the chain is FOR, on top of the fact itself.
      if (opts?.instruction !== undefined) {
        this.deps.mailbox.enqueue(event.workspace, sessionId, {
          from: "event",
          sender: "reaction",
          content: `[reaction step] ${opts.instruction}`,
        });
      }
      const permit = this.buildPermit(event, agentId, sessionId, spec, controller.signal, runRef);
      // O5: a headless run is autonomous work, so it runs inside a decision boundary. This is the first
      // production caller to hand the kernel an envelope — before it, `envelope` existed on the loop's
      // options and no caller ever set it, which made every guard in there dead code.
      const envelope = this.envelopeFor(runId, spec, event);
      const outcome = await this.deps.runTurn(sessionId, token, controller.signal, permit, envelope);
      // The halt owes a handoff. Published BEFORE the settle report and inside the try — the run's token is
      // revoked in the finally, and a checkpoint nobody could write is the failure halt_checkpoint names.
      // Its outcome rides the suspend report: "resumable" is only claimed when the handoff actually landed.
      const halted = outcome?.stopReason === "budget_exhausted";
      const handoff = halted
        ? await this.publishHalt(token, envelope, runId, agentId, sessionId, event, outcome)
        : undefined;
      // A run that stopped WITHOUT completing — a budget halt, or an armed wait — is SUSPENDED, never
      // completed: the checkpoint says "the work did not finish" and the lifecycle must not contradict it.
      const settled = this.stopped.has(sessionId)
        ? "cancelled"
        : halted || outcome?.stopReason === "waiting"
          ? "suspended"
          : "completed";
      await this.deps.sessions.setSessionStatus(event.workspace, sessionId, settled, this.deps.now());
      void this.report(
        settled === "cancelled"
          ? "agent.run.cancelled"
          : settled === "suspended"
            ? "agent.run.suspended"
            : "agent.run.completed",
        event,
        agentId,
        sessionId,
        settled === "suspended"
          ? halted
            ? `Agent ${agentId} run suspended at its envelope budget (${event.kind}) — handoff ${handoff ?? "absent"}.`
            : `Agent ${agentId} run suspended on an armed wait (${event.kind}).`
          : `Agent ${agentId} run ${settled} (${event.kind}).`,
        runRef,
        ...(await this.turnEvidence(event.workspace, sessionId, undefined, outcome)), // fresh session — the whole transcript is this run's
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
        ...(await this.turnEvidence(event.workspace, sessionId)), // what it did before dying is the evidence that matters
      );
      if (settled === "failed") throw err;
    } finally {
      this.controllers.delete(sessionId);
      this.stopped.delete(sessionId);
      await this.deps.keyStore.revoke(event.workspace, keyId, creator).catch(() => {});
    }
  }

  // The AUTONOMY BOUNDARY this activation runs inside (the O5 TaskEnvelope). Its id is the RUN id: a
  // boundary is per-execution, and reusing the agent id would make two concurrent activations share one.
  // NOTE the same run id ALSO names the run's CAUSAL BUDGET (RunRecord.envelope — the delegated spend caused
  // work draws from): two different contracts behind one identifier and one unlucky shared word — see the
  // naming note beside TaskEnvelopeSchema in contracts records/ownership.ts.
  // `role` stays absent — an agent spec declares no ownership role, and stamping "executor" on it would be a
  // claim the record cannot back. Scope is completed by the turn, which is where the toolset resolves.
  private envelopeFor(runId: string, spec: AgentSpec, event: ActivationEvent): ActivationEnvelope {
    const envelope: ActivationEnvelope = {
      id: runId,
      goal: spec.task ?? `React to ${event.kind}: ${event.message}`,
      budgets: { tokens: ACTIVATION_TOKEN_BUDGET, timeSec: ACTIVATION_TIME_BUDGET_SEC },
      stop: { onBudgetExhausted: "halt_checkpoint" },
      escalation: { onScopeExceeded: "refuse_and_replan" },
      // Nothing declares a rollback requirement for an activation yet; claiming one would demand a rollback
      // plan the host has no way to write. When agents carry ownership roles, the role decides this.
      rollbackRequired: false,
    };
    // The domain guard at the author (O5): an unbudgeted envelope never reaches the kernel. The budgets are
    // constants today, so this cannot throw — the call exists so the invariant fires the moment they stop being.
    assertTaskEnvelope(envelope);
    return envelope;
  }

  // The handoff a halted run owes its successor (O6). The host writes this, not the agent: the agent is out
  // of budget, and asking it for one more turn to summarize itself is asking past the boundary that just
  // stopped it. What the host can state as FACT is exactly what it holds evidence for — the run itself, on
  // the control plane's ledger, which is a resolvable reference. Everything about what the work ACHIEVED is
  // the agent's transcript, which the host never read, so it goes in hypotheses where a successor will treat
  // it as something to check rather than something to build on.
  // Returns the handoff's fate — "published" | "failed" | "absent" — because the suspend report must not
  // claim more than what happened: a run whose checkpoint publication failed is still suspended (the stop is
  // real), but it is NOT resumable-from-checkpoint, and the fact says so instead of implying it.
  private async publishHalt(
    agentToken: string,
    envelope: ActivationEnvelope,
    runId: string,
    agentId: string,
    sessionId: string,
    event: ActivationEvent,
    outcome: TurnOutcome,
  ): Promise<"published" | "failed" | "absent"> {
    const publish = this.deps.publishCheckpoint;
    if (!publish) return "absent";
    const spent = outcome.usage ? outcome.usage.inputTokens + outcome.usage.outputTokens : undefined;
    try {
      await publish(agentToken, {
        envelopeId: envelope.id,
        // The envelope's policy slice rides along so ADMISSION can enforce the rollbackRequired ⇒
        // rollbackPlan cross-invariant (envelopes are not persisted; the producer is the only carrier).
        envelope: { id: envelope.id, rollbackRequired: envelope.rollbackRequired },
        goal: envelope.goal,
        by: { id: `agent:${agentId}`, sessionId, runId },
        currentState: `The run halted at its task envelope's budget before reporting completion. Its trajectory up to the halt is sealed on run ${runId}.`,
        confirmedFacts: [
          {
            statement:
              spent === undefined
                ? `Run ${runId} halted on envelope budget exhaustion (woken by ${event.kind}).`
                : `Run ${runId} halted on envelope budget exhaustion after ${spent} model tokens (woken by ${event.kind}).`,
            refs: [{ type: "run", id: runId }],
          },
        ],
        // The host did not read the transcript, so it claims nothing about the work — only that a run which
        // stopped mid-task usually left something half-done, which is the thing a successor must check first.
        hypotheses: [
          {
            statement: "Work may be partially applied — the halt was a budget boundary, not a completion.",
            confidence: "medium",
          },
        ],
        actionsTaken: [
          { description: `Ran the agent's triggered task to the envelope budget.`, refs: [{ type: "run", id: runId }] },
        ],
        openDecisions: ["Whether to raise this agent's envelope budget or narrow the task before resuming."],
        remainingTasks: [`Re-establish state from run ${runId}'s trajectory, then continue toward: ${envelope.goal}`],
        requiredCapabilities: [],
        risks: [],
        validationPlan: `Read run ${runId}'s sealed trajectory to determine what was actually applied, then verify the goal independently before declaring it done.`,
      });
      return "published";
    } catch (err) {
      // Best-effort by contract — the halt is already a fact on the event log; a checkpoint the control plane
      // refused (or could not be reached for) must not turn a bounded stop into a failed run. The caller
      // records the failure on the suspend fact instead of claiming a resumable handoff that does not exist.
      console.error(
        `[agent] failed to publish halt checkpoint for ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
      return "failed";
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
      if (mode === "auto" && !isGuardedAction(request.name, request.effects)) return "allow";
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
        undefined,
        request.name, // the parked tool — what the CP's approval notification (N8) names
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
      | "agent.run.suspended"
      | "agent.run.completed"
      | "agent.run.failed"
      | "agent.run.cancelled",
    event: ActivationEvent,
    agentId: string,
    sessionId: string,
    message: string,
    run?: { runId: string; creator?: string; agentVersion?: string; eventId?: string; budgetUsd?: number },
    evidence?: { trace?: TraceEvent[]; spans?: TraceSpan[] },
    tool?: string,
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
        ...(evidence?.trace !== undefined ? { trace: evidence.trace } : {}),
        ...(evidence?.spans !== undefined ? { spans: evidence.spans } : {}),
        ...(tool !== undefined ? { tool } : {}),
      }) ?? Promise.resolve()
    ).catch(() => {});
  }

  // What the terminal report carries as evidence. The turn's OWN spans when it recorded them (N6 — they hold
  // the model latency, retries and subagents a transcript row cannot); otherwise O2's transcript slice (rows
  // after sinceSeq) projected to TraceEvent, which the CP assembles. Best-effort either way: a session-store
  // hiccup must never turn a settled run into a lost report (the report just goes without evidence).
  private async turnEvidence(
    workspace: string,
    sessionId: string,
    sinceSeq?: number,
    outcome?: TurnOutcome,
  ): Promise<[{ trace?: TraceEvent[]; spans?: TraceSpan[] }] | []> {
    if (outcome?.spans && outcome.spans.length > 0) return [{ spans: outcome.spans }];
    try {
      const messages = await this.deps.sessions.listMessages(workspace, sessionId, sinceSeq);
      const trace = transcriptToTrace(messages, outcome?.usage);
      return trace.length > 0 ? [{ trace }] : [];
    } catch {
      return [];
    }
  }

  // The session's last transcript seq BEFORE a turn runs — the continuation run's trajectory starts after it
  // (an activation session is born with this run, so its baseline is simply absent).
  private async lastSeq(workspace: string, sessionId: string): Promise<number | undefined> {
    try {
      const messages = await this.deps.sessions.listMessages(workspace, sessionId);
      return messages[messages.length - 1]?.seq;
    } catch {
      return undefined;
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

// The comment a comment fact points at, resolved to the thread's ANCHOR: only a top-level comment can be a
// parent (single-level threads), so a fact about a reply anchors on that reply's parent — the same rule the
// control plane's CommentService applies when it nests an @everdict answer.
function threadAnchorId(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const parent = payload.parentId;
  if (typeof parent === "string" && parent.length > 0) return parent;
  const comment = payload.commentId;
  return typeof comment === "string" && comment.length > 0 ? comment : undefined;
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
  // A comment fact wakes the agent INSIDE someone's discussion. The payload carries the comment id, but nothing
  // told the agent what to do with it — so its answer went up as a top-level comment, a second conversation
  // beside the one it was answering. Say where the reply belongs; the id is right there in Details.
  const anchor = event.kind.startsWith("comment.") ? threadAnchorId(event.payload) : undefined;
  if (anchor !== undefined) {
    const on = event.subject ? event.subject.type : "resource";
    lines.push(
      `If you answer in that discussion, reply INSIDE it — create_comment with parent_id "${anchor}". A comment without that parent is a new top-level thread on the ${on}, next to the one you are replying to.`,
    );
  }
  return lines.join("\n\n");
}
