import {
  type CaseResult,
  ConflictError,
  type EvalCase,
  type GraderSpec,
  InternalError,
  TERMINAL_RUN_STATUSES,
  sanitizeSubmittedResult,
} from "@everdict/contracts";
import type { DomainFact, RunAttachChannel, RunClass, RunEnvelope, RunOrigin, RunRecord } from "@everdict/contracts";
import { settleAgentTransition } from "./agent-run.js";
import { settleCommandTransition } from "./command-run.js";
import { closeSessionTransition, extendSessionTransition, recordSnapshotTransition } from "./session-run.js";

// The domain model for a run's lifecycle (queued → running → succeeded | failed). Wraps the persistence
// record (@everdict/db RunRecord — shapes unchanged); guard methods are the SSOT for what is legal, and
// transition methods guard then return the store patch. Illegal transitions throw from the domain.
// docs/architecture/rich-domain-core.md

// What a transition computes: the store patch AND the facts describing it (event-plumbing.md E0 — the fact
// is born where the legality is decided, and the store persists both in the same transaction). An empty facts
// array is normal: the taxonomy has no kind for the change, or the flood-prevention gate applies.
export interface RunTransition {
  patch: Partial<RunRecord>;
  facts: DomainFact[];
}

export interface NewQueuedRunInput {
  id: string;
  tenant: string;
  harness: { id: string; version: string };
  evalCase: EvalCase; // the (placement-injected) case body — persisted as the boot-recovery re-dispatch basis
  runtime?: string; // the placed runtime (work-queue axis); unset = default backend
  trigger?: string; // activity-view source axis (web|mcp|api…)
  webhookUrl?: string; // completion callback, delivered off the terminal fact (mig 0171)
  submittedBy?: string; // executor stamp — notification-feed recipient
  // The universal-run shape (execution-model.md P0). origin = structured WHY (trigger stays dual-stamped for
  // the legacy source axis); class defaults to interactive — a standalone submit is a person waiting.
  origin?: RunOrigin;
  class?: RunClass;
  envelope?: RunEnvelope; // the delegated budget this run draws from (§5.2 — stamped by the admission gate)
  now: string;
}

// WHICH live channels an execution exposes — the ONE rule, so a surface never has to guess from the run's
// kind what it can attach to. Guessing is what the web used to do (`kind is eval|command → assume a
// container`), and it promised the same panels for an execution on a cluster and one on someone's laptop,
// where only the second is true.
//
// A cluster-placed case is container-backed: the control plane can tail its logs and open a shell into it.
// A `self:` case runs on a machine the control plane cannot reach — the runner PUSHES its lines, so logs
// exist and exec does not. An agent turn or an analysis has no container at all.
export function attachChannelsFor(input: { kind?: RunRecord["kind"]; target?: string }): RunAttachChannel[] {
  const kind = input.kind ?? "eval";
  if (kind !== "eval" && kind !== "command") return [];
  return input.target?.startsWith("self:") ? ["logs"] : ["logs", "terminal"];
}

// WHO may read an execution and the evidence it sealed — the ONE rule, for the same reason
// `attachChannelsFor` is one rule: every surface (the runs list, a run detail, the trajectory ledger, the
// MCP twins) would otherwise re-derive it from `kind`, and the first surface to forget re-publishes
// workspace-wide what another surface keeps private.
//
// PERSONAL work belongs to the member who did it. An agent run is a conversation turn — the session store
// has always been owner-scoped (`getVisibleSession`), so the run ledger and the trajectory ledger must not
// hand the same transcript to the whole workspace through a different door. A sandbox session is someone's
// shell. Everything else — evals, the playground cases a session runs, analyses — is the workspace's work
// and stays workspace-visible.
//
// There is deliberately NO admin bypass: listing, renaming and deleting a conversation are owner-only
// today, and an admin who could open every member's agent evidence would make that ownership decorative.
// What an admin legitimately needs — who spent what — stays visible through the usage meter, which carries
// cost without content.
export type RunAudience = { scope: "workspace" } | { scope: "member"; subject: string };

// The kinds that are somebody's own work rather than the workspace's. Exported because a store that
// paginates has to express the same rule in its query language — filtering AFTER a LIMIT would hand a
// member a short page (a workspace full of someone else's chat turns would read as "no runs"). `runAudience`
// stays the SSOT for the rule; a SQL impl restates only this list plus the owner fallback, and the store
// tests assert the two impls agree.
export const PERSONAL_RUN_KINDS: readonly RunRecord["kind"][] = ["agent", "sandbox"];

export function runAudience(
  record: Pick<RunRecord, "kind" | "class" | "visibility" | "createdBy" | "origin">,
): RunAudience {
  // The CREATION-TIME FACT outranks every inference (F9): class is scheduling semantics, and a future
  // background personal assistant (or interactive team agent) must not have its privacy decided by a
  // priority knob. Absent = legacy row → the class/kind fallback below, conservatively.
  if (record.visibility === "workspace") return { scope: "workspace" };
  if (!PERSONAL_RUN_KINDS.includes(record.kind ?? "eval")) return { scope: "workspace" };
  // The agent kind holds TWO audiences and the record already says which: a BACKGROUND run is headless
  // automation — workspace fleet observability by design (its session is created `visibility: "workspace"`
  // for exactly that reason), while an INTERACTIVE turn is one member's conversation. Inferring "personal"
  // from the kind alone split one activation's evidence two ways — the transcript readable workspace-wide
  // through the session door, the run/trajectory/list entry locked to the creator. A legacy agent row with
  // no class stays personal: the conservative reading for rows that never declared themselves.
  if (record.visibility === undefined && record.kind === "agent" && record.class === "background")
    return { scope: "workspace" };
  // `origin.actor` is the member the run acted FOR (an activation acts as its agent's creator); `createdBy`
  // is the same subject on every factory that stamps both, and the fallback for older rows.
  const owner = record.origin?.actor ?? record.createdBy;
  // A personal run with nobody on it (a pre-P0 row, an activation reported without a creator) has no owner
  // to keep it for. It stays the workspace's rather than becoming readable by no one — hiding evidence from
  // everybody is not privacy, it is loss.
  return owner === undefined ? { scope: "workspace" } : { scope: "member", subject: owner };
}

// How a run's evidence names ITSELF on a browse row. The trajectory ledger stores this beside the bytes
// (mig 0124) for the same reason it stores the owner: the browse page must answer "what is this" from the
// row alone — the ClickHouse rung has no run table beside it, and a page that resolved names afterwards
// would either N+1 or lie. Without it every row read `<uuid> · run · N events`, and evidence you cannot
// recognize is indistinguishable from evidence that is not there.
//
// The label is the handle a person would use: an eval is known by the CASE it evaluated, everything else by
// what ran (the harness id — for a chat turn, the agent's own id).
export function runEvidenceIdentity(record: Pick<RunRecord, "kind" | "caseId" | "harness">): {
  kind: string;
  label?: string;
} {
  const kind = record.kind ?? "eval";
  const label = kind === "eval" && record.caseId ? record.caseId : record.harness?.id;
  return { kind, ...(label ? { label } : {}) };
}

// May `viewer` (a member subject) read this run and its trajectory? Tenancy is checked separately and
// first — this answers only the within-workspace question.
export function canReadRun(
  record: Pick<RunRecord, "kind" | "class" | "visibility" | "createdBy" | "origin">,
  viewer: string,
): boolean {
  const audience = runAudience(record);
  return audience.scope === "workspace" || audience.subject === viewer;
}

// ── Shared transition guards (free functions so the per-kind transition modules stand on the SAME rules) ──
export function isRunTerminal(record: Pick<RunRecord, "status">): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(record.status);
}

export function assertRunNotTerminal(record: Pick<RunRecord, "id" | "status">, transition: string): void {
  if (isRunTerminal(record))
    throw new ConflictError(
      "CONFLICT",
      { run: record.id, status: record.status, transition },
      `run is already terminal (${record.status}) — ${transition} rejected`,
    );
}

// Session-only transitions guard on the session half existing — a task-lifetime run reaching one is a
// caller bug surfaced as a clean conflict, never a silent no-op.
export function assertRunSession(
  record: Pick<RunRecord, "id" | "session">,
  transition: string,
): NonNullable<RunRecord["session"]> {
  const session = record.session;
  if (session === undefined)
    throw new ConflictError(
      "CONFLICT",
      { run: record.id, transition },
      `run is not a session — ${transition} rejected`,
    );
  return session;
}

// The emission gate, domain law: scorecard children stay represented by the batch's own facts (flood
// prevention). The initiator gate was WIDENED (E2 coverage decision, master-plan W6 backlog close-out):
// a machine-fired completion is workspace news too — the Mattermost channel always posted it, and re-basing
// that channel onto the log required the log to know. Personal targeting stays conditional (the feed
// consumer skips actor-less facts), so widening adds facts, never ghost bell rows.
export function terminalRunFacts(record: RunRecord, status: "succeeded" | "failed"): DomainFact[] {
  if (record.parentScorecardId) return [];
  const kind = status === "succeeded" ? ("run.completed" as const) : ("run.failed" as const);
  return [
    {
      kind,
      subject: { type: "run", id: record.id },
      ...(record.createdBy !== undefined ? { actor: record.createdBy } : {}),
      payload: {
        status,
        harness: `${record.harness.id}@${record.harness.version}`,
        caseId: record.caseId,
      },
    },
  ];
}

export class Run {
  private constructor(private readonly record: RunRecord) {}

  static from(record: RunRecord): Run {
    return new Run(record);
  }

  // The only place a queued run is assembled — submit's record literal lives here, not in the service.
  static newQueued(input: NewQueuedRunInput): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: input.harness,
      caseId: input.evalCase.id,
      status: "queued",
      ...(input.trigger ? { trigger: input.trigger } : {}),
      // The completion callback, recorded rather than held in the request (mig 0171) — whichever driver
      // settles this run is the one that owes the caller an answer.
      ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      caseSpec: input.evalCase,
      // P0 stamps — say what this activation IS; enforcement arrives with the P4 gate.
      kind: "eval",
      class: input.class ?? "interactive",
      lifetime: "task",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.envelope ? { envelope: input.envelope } : {}),
      ...(input.runtime ? { placement: { where: "runtime" as const, target: input.runtime } } : {}),
      attach: attachChannelsFor({ kind: "eval", ...(input.runtime ? { target: input.runtime } : {}) }),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // An agent activation enters the ledger (execution-model.md P3, decision O4: the CP owns the record, the
  // agent service reports transitions). Born RUNNING — the report fires when the turn starts, there is no
  // queued phase (admission arrives with P4). The HARNESS column names the executable — for an agent run
  // that is the agent spec (agentId@version); caseId carries the activation cause (eventId, else eventKind).
  // The session is the GROUP (role "turn" — a resumed session runs a second turn = a second run, same group).
  static newAgentRun(input: {
    id: string;
    tenant: string;
    agentId: string;
    agentVersion?: string;
    sessionId: string;
    eventKind: string;
    eventId?: string;
    createdBy?: string; // the member the activation acts as (the agent's creator)
    budgetUsd?: number; // the delegated slice (AgentSpec.budgetUsd) — becomes this run's envelope (§5.2)
    now: string;
  }): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: { id: input.agentId, version: input.agentVersion ?? "latest" },
      caseId: input.eventId ?? input.eventKind,
      status: "running",
      trigger: "agent", // the activity view's legacy source axis (dual-stamped, like eval runs)
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      kind: "agent",
      class: "background", // agent-caused work must never starve a human's click (P0 vocabulary)
      visibility: "workspace", // fleet observability, matching the session door — a FACT, not a class inference
      lifetime: "task",
      origin: {
        cause: "event",
        eventKind: input.eventKind,
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
        ...(input.createdBy !== undefined ? { actor: input.createdBy } : {}),
        // The executor is RECORDED, never inferred: createdBy is the principal the run acts as, and reading
        // the actor back out of it is what let an agent verify its own work (checkpoint independence compares
        // member:kim against agent:fixer — namespaces that can never collide).
        executor: `agent:${input.agentId}`,
      },
      group: { id: input.sessionId, role: "turn" },
      // The envelope THIS run delegates downstream (§5.2): its own id is the envelope id — every caused run
      // draws from it, and the P4 gate refuses at 402 once the slice is spent. No budget = no envelope.
      ...(input.budgetUsd !== undefined ? { envelope: { id: input.id, capUsd: input.budgetUsd } } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // A CHAT turn enters the same ledger (execution-model.md decision O1: "chat turns are runs, grouped").
  // Everything an activation run gets — status, cost, a sealed trajectory, causation stamping — a turn a member
  // typed gets too, so agent work has ONE accounting path instead of two. Two fields differ from the activation
  // factory and both are the point: the cause is the MEMBER (nobody woke this; someone asked), and the class is
  // INTERACTIVE (a human is waiting on it, so it must not be scheduled like background fan-out). The session is
  // the same GROUP, which is what keeps a 50-turn conversation one row in the console.
  static newChatTurn(input: {
    id: string;
    tenant: string;
    agentId: string;
    agentVersion?: string;
    sessionId: string;
    actor: string; // the member whose message opened this turn
    now: string;
  }): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: { id: input.agentId, version: input.agentVersion ?? "latest" },
      caseId: "chat",
      status: "running",
      trigger: "agent",
      createdBy: input.actor,
      kind: "agent",
      class: "interactive",
      visibility: "member", // one member's conversation — declared, not inferred from the scheduling class
      lifetime: "task",
      // The member asked (cause/actor/createdBy); the AGENT executed — recorded, same as the activation path.
      origin: { cause: "member", actor: input.actor, executor: `agent:${input.agentId}` },
      group: { id: input.sessionId, role: "turn" },
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // A session run enters the ledger (execution-model.md P6): "run this environment image and shell in".
  // Born RUNNING — the container is provisioned before the record exists (no orphan record on a failed
  // provision), so there is no queued phase. The HARNESS column names what the user ASKED for (an
  // environment capability id@version, or the ad-hoc image@`adhoc`); `session.image` is the concrete
  // container image; caseId carries the image too (the console's "what is this" answer). Disposal is the
  // invariant: `session.expiresAt` lives ON THE ROW, so a reaper can tear down on time from the row alone.
  // "Run this file" enters the same ledger (execution-model.md P0: the ledger says WHAT ran, WHY and WHERE).
  // It is a `command` — one activation of an executable that is not an eval — and unlike a sandbox it is NOT
  // personal: the script publishes files into the SHARED workspace tree, so who ran what, in which image, on
  // whose cluster is workspace knowledge rather than one member's business.
  //
  // What it PRINTED stays off the row on purpose. stdout is the caller's answer, and a script that echoes a
  // credential must not turn the run ledger into a second place that credential now lives. The row keeps the
  // decisions (path, image, placement) and the verdict (exit code, published files) — the audit questions.
  static newFileCommand(input: {
    id: string;
    tenant: string;
    path: string; // WHAT ran, in the workspace filesystem
    image: string; // the container it ran in (interpreter default, or the caller's environment image)
    createdBy: string;
    runtime?: string; // the workspace runtime it was placed on; unset = the deployment's own compute
    // The agent turn that asked for it (§5.1): the run draws from that causer's envelope and is counted by
    // the depth/in-flight guards, instead of spending against nobody.
    causedByRunId?: string;
    envelope?: RunEnvelope;
    now: string;
  }): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: { id: input.image, version: "adhoc" }, // the environment column, as an ad-hoc sandbox states it
      caseId: input.path,
      status: "running", // there is no queue in front of it — it starts the moment it is created
      trigger: "file", // the activity view's legacy source axis (dual-stamped, like every other kind)
      createdBy: input.createdBy,
      kind: "command",
      class: "interactive", // someone clicked Run and is watching the output pane
      lifetime: "task",
      // The CAUSE is a member either way: an agent's `run_file` acts AS the member it was delegated by. Whose
      // loop this was rides on the facts instead (`causedBy: agent:<id>:<conv>`, stamped by the caller) — the
      // same separation the sandbox lane keeps, and the reason an agent never wakes on its own file run.
      origin: {
        cause: "member",
        actor: input.createdBy,
        ...(input.causedByRunId !== undefined ? { causedByRunId: input.causedByRunId } : {}),
      },
      ...(input.envelope !== undefined ? { envelope: input.envelope } : {}),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      placement: {
        where: input.runtime !== undefined ? "runtime" : "driver",
        ...(input.runtime !== undefined ? { target: input.runtime } : {}),
        isolation: "container",
      },
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // A live browser session is a held-open sandbox (master-plan decision O6, "browser sessions fold later" —
  // this is later). Deliberately the SAME kind as an agent world: `sandbox` is the family of held-open
  // isolated compute, and it is already PERSONAL (PERSONAL_RUN_KINDS), which is what a browser carrying
  // someone's logged-in cookies has to be. Before this, a browser lived only in one process's memory: a
  // control plane that died left the container running with nothing left that knew about it.
  static newBrowserSession(input: {
    id: string;
    tenant: string;
    image: string; // the browser image (or the host binary's name, when it is not a container)
    ttlSec: number;
    createdBy: string;
    runtime?: string;
    country?: string; // the egress proxy's country, when the session goes out through one
    now: string;
  }): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: { id: "browser", version: "1" },
      caseId: input.country ?? "direct", // WHERE it appears to browse from — the discriminating fact
      status: "running",
      trigger: "browser",
      createdBy: input.createdBy,
      kind: "sandbox",
      class: "interactive",
      visibility: "member", // whoever is at the browser — declared, not inferred
      lifetime: "session",
      origin: { cause: "member", actor: input.createdBy },
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      placement: {
        where: input.runtime !== undefined ? "runtime" : "driver",
        ...(input.runtime !== undefined ? { target: input.runtime } : {}),
        isolation: "container",
      },
      attach: ["exec"],
      session: {
        image: input.image,
        ttlSec: input.ttlSec,
        expiresAt: new Date(new Date(input.now).getTime() + input.ttlSec * 1000).toISOString(),
      },
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static newSandboxSession(input: {
    id: string;
    tenant: string;
    harness: { id: string; version: string }; // environment ref, or {image, "adhoc"}
    image: string;
    ttlSec: number;
    createdBy: string;
    computeId?: string; // driver-level compute id (container id) — the reaper's teardown key after a crash
    world?: string; // agent worlds (W1): the environment capability this session snapshots into
    hibernate?: boolean; // auto-snapshot at teardown instead of losing the filesystem
    repo?: { git: string; ref?: string; dir: string }; // W2: the repository cloned in at create
    agent?: { agentId: string; conversationId?: string }; // W3: whose loop guard key the facts carry
    runtime?: string; // W4: the workspace runtime this session was placed on; unset = the default compute
    origin?: RunOrigin;
    envelope?: RunEnvelope;
    attach?: RunAttachChannel[]; // default ["exec"]; a harness session adds "tasks" (test-case submissions)
    // Session-pool discriminator (the ledger counts capacity per trigger). Default "sandbox" = the
    // container-holding pool; "frontdoor" = service-harness conversation sessions (a warm-topology slot on a
    // workspace runtime — different scarcity, its own caps).
    trigger?: string;
    conversation?: boolean; // playground conversation mode — the session's turns continue one conversation
    now: string;
  }): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: input.harness,
      caseId: input.image,
      status: "running",
      trigger: input.trigger ?? "sandbox", // the activity view's legacy source axis (dual-stamped, like eval runs)
      createdBy: input.createdBy,
      kind: "sandbox",
      class: "interactive", // a person is at the shell
      visibility: "member", // whoever is at the shell — declared, not inferred
      lifetime: "session", // held open until closed/expired — `running` means "alive", not "in progress"
      origin: input.origin ?? { cause: "member", actor: input.createdBy },
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      placement: {
        // A session on the workspace's own runtime is placed compute, not this host's — the same distinction
        // the eval lane draws, so the console can say WHERE a shell actually ran.
        where: input.runtime !== undefined ? "runtime" : "driver",
        ...(input.runtime !== undefined ? { target: input.runtime } : {}),
        isolation: "container",
      },
      attach: input.attach ?? ["exec"],
      ...(input.envelope !== undefined ? { envelope: input.envelope } : {}),
      session: {
        image: input.image,
        ttlSec: input.ttlSec,
        expiresAt: new Date(new Date(input.now).getTime() + input.ttlSec * 1000).toISOString(),
        ...(input.computeId !== undefined ? { computeId: input.computeId } : {}),
        ...(input.world !== undefined ? { world: input.world } : {}),
        ...(input.hibernate !== undefined ? { hibernate: input.hibernate } : {}),
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.conversation === true ? { conversation: true } : {}),
      },
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // A test case submitted into a live harness session (the playground): its own ledger run, grouped to the
  // session the way agent turns group to their conversation (role "case"). Born RUNNING — the warm container
  // starts the work synchronously, there is no queued phase (provision happened at session create). The
  // HARNESS column names the real harness under test; caseSpec persists the prompt case so the run detail
  // shows what was asked (never any secret — the auth env lives only in the session process).
  static newSessionCase(input: {
    id: string;
    tenant: string;
    harness: { id: string; version: string };
    sessionRunId: string;
    caseId: string; // "task-<n>" within the session ("turn-<n>" for conversation turns)
    task: string;
    timeoutSec: number;
    createdBy: string;
    // "case" (default) = an independent test case; "turn" = one dependent turn of the session's conversation
    // — aggregations that treat role:"case" children as independent eval cases must not ingest turns.
    role?: "case" | "turn";
    // Front-door turns run on the session's workspace runtime, not this host's driver; unset = today's driver placement.
    placement?: RunRecord["placement"];
    now: string;
  }): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: input.harness,
      caseId: input.caseId,
      status: "running",
      trigger: "playground", // the activity view's legacy source axis (dual-stamped, like eval runs)
      createdBy: input.createdBy,
      caseSpec: {
        id: input.caseId,
        env: { kind: "prompt" },
        task: input.task,
        graders: [],
        timeoutSec: input.timeoutSec,
        tags: [],
      },
      kind: "eval",
      class: "interactive", // a person is at the composer, watching
      lifetime: "task",
      origin: { cause: "member", actor: input.createdBy },
      group: { id: input.sessionRunId, role: input.role ?? "case" },
      placement: input.placement ?? { where: "driver", isolation: "container" },
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // Close a session run (member close, TTL expiry, or orphan adoption by the reaper). A session ending is
  // its NORMAL completion — expiry included — so every reason settles as succeeded; the reason is stamped
  // on `session.closedReason` for the console. First terminal write wins (close vs expiry race).
  closeSession(reason: "closed" | "expired" | "orphaned", now: string): RunTransition {
    return closeSessionTransition(this.record, reason, now);
  }

  // Agent worlds (W1): the session published a snapshot — an environment-capability version whose image IS
  // this session's filesystem now exists, and the next session can boot from it. Append-only on the session
  // half (one session may snapshot many times). The fact is deliberately NOT trigger-matchable in v1: an
  // agent snapshotting on a trigger and waking on its own snapshot is loop guard #1's textbook vector.
  recordSnapshot(input: { world: string; version: string; image: string; now: string }): RunTransition {
    return recordSnapshotTransition(this.record, input);
  }

  // Keep-alive (touch): push the hard deadline OUT to now+ttl — never pull it in (a touch that could shorten
  // a long-remaining session would make a small ttl a foot-gun), and never announce (upkeep is not news).
  extendSession(ttlSec: number, now: string): RunTransition {
    return extendSessionTransition(this.record, ttlSec, now);
  }

  // Settle an agent run (reported by the agent service). Facts stay DELIBERATELY empty in this slice: the
  // agent.run.* family still carries the lifecycle events — flipping the emit to run.* requires the
  // subject-aware trigger-matcher guard first (the alias charter in contracts/platform-event.ts), or agent
  // completions would become trigger-matchable and reopen the runaway vector. `cancelled` maps onto the
  // run lifecycle as failed{CANCELLED}. `suspended` is its own status: a budget halt or an armed wait
  // stopped the run WITHOUT completing it — recording that as succeeded made "done" and "stopped mid-task"
  // indistinguishable to every successor; a resume is a NEW run, so the suspended row settles like a
  // terminal one (first write wins, never in-flight).
  settleAgent(
    outcome: "completed" | "failed" | "cancelled" | "suspended",
    message: string,
    now: string,
  ): RunTransition {
    return settleAgentTransition(this.record, outcome, message, now);
  }

  // The facts describing a record's CREATION (nothing → queued) — the same E0 rule as transitions, for the
  // factory: standalone runs announce run.submitted; scorecard children stay silent (the batch's facts cover them).
  static creationFacts(record: RunRecord): DomainFact[] {
    if (record.parentScorecardId) return [];
    return [
      {
        kind: "run.submitted",
        subject: { type: "run", id: record.id },
        ...(record.createdBy !== undefined ? { actor: record.createdBy } : {}),
        payload: {
          status: record.status,
          harness: `${record.harness.id}@${record.harness.version}`,
          caseId: record.caseId,
        },
      },
    ];
  }

  // Terminal = the record's outcome is settled; nothing may rewrite it (first terminal write wins).
  // `suspended` settles the ROW (a resume is a new run) while claiming "not done" — settled, not succeeded.
  isTerminal(): boolean {
    return isRunTerminal(this.record);
  }

  // A command run settles on HAVING RUN — not on the command agreeing with us. A non-zero exit is the
  // script's own answer (the standing rule everywhere this surface is described), so the row succeeds and
  // KEEPS the code; `failed` stays reserved for "we could not run it at all" — no interpreter for the
  // extension, a sandbox that never came up. Conflating the two would make every failing test script look
  // like broken infrastructure.
  settleCommand(outcome: { exitCode: number; files?: string[] }, now: string): RunTransition {
    return settleCommandTransition(this.record, outcome, now);
  }

  // Boot recovery may adopt a still-alive backend job's result only while the run is not settled.
  canAdopt(): boolean {
    return !this.isTerminal();
  }

  // Boot recovery may re-drive only runs that persisted their case body (legacy records keep the tombstone
  // path). A driver-placed run (a playground session case) has NO backend to re-dispatch to — its compute
  // was this process's docker container; recovery must tombstone it, never send a prompt case to a backend.
  canRedispatch(): boolean {
    return (
      !this.isTerminal() &&
      this.record.caseSpec !== undefined &&
      this.record.placement?.where !== "driver" &&
      // A conversation turn is dependent evidence — its continuity (resume token / session wiring) lives in the
      // session process, so boot recovery must orphan-settle it with the session, never re-drive it standalone.
      this.record.group?.role !== "turn"
    );
  }

  // queued → running — compute actually began (managed: the backend dispatched it; self-hosted: a runner leased it).
  // A run is born queued (a standalone run, and now a batch child too); this is the flip that makes "waiting for a
  // runner" (queued) distinct from "executing" (running) in the runs view + work queue. Idempotent over an already
  // running record; refused once terminal (a late lease flip must never resurrect a settled run).
  start(now: string): RunTransition {
    this.assertNotTerminal("start");
    return { patch: { status: "running", updatedAt: now }, facts: [] }; // no run.started kind in the taxonomy
  }

  // queued|running → succeeded (normal completion).
  // THE ONE SEAM EVERY RESULT CROSSES. `succeed`, `fail` and boot-recovery `adopt` are the three writes that
  // make a result this record's answer, and both settlement lanes — the standalone `finalize` and the batch's
  // per-case commit — end in one of them. So this is where the control plane asks what `safeGrade` asked
  // inside the job: was each score's producer entitled to the metric it named? On the self-hosted lane that
  // job ran on the producer's own machine, which is why the question is asked again at the seam that decides.
  //
  // Three writers, one method, on purpose: a check that lived in `succeed` alone would have left `adopt` —
  // the recovery lane, the one whose bytes came from a process this one never watched — as the residue.
  //
  // WHICH DECLARATION it asks against: the run's own when the row carries its case (a standalone run persists
  // it), and the caller's when it does not — a batch child never persists `caseSpec` BY DESIGN
  // (`scorecard-child.ts`: the batch re-plans from its dataset), so its commit hands over the sealed plan's
  // graders, the same document the in-sandbox boundary graded under. Exactly one of the two: both present is
  // two readers of one fact and is refused as a programming error, never resolved by precedence. Neither
  // present reads as "declared no graders" — the fact `newSessionCase` states with `graders: []` — which is
  // fail-CLOSED: every reserved name the producer wrote becomes an invalid row. That is the loud direction,
  // and it is how the first batch fixture found this seam rather than a forgery finding the verdict. The call
  // is unconditional — no branch skips it — so it is not what a guarded strip leaves behind (rule `protocol`).
  // Rows sealed before `caseSpec` existed are terminal, and `assertNotTerminal` on every writer is why they
  // never reach this.
  private settled(result: CaseResult, declared: readonly GraderSpec[] | undefined): CaseResult {
    const own = this.record.caseSpec === undefined ? undefined : (this.record.caseSpec.graders ?? []);
    if (own !== undefined && declared !== undefined)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { run: this.record.id },
        "a run that persists its case is settled against that declaration alone — a caller-supplied one is a second reader",
      );
    return sanitizeSubmittedResult(result, own ?? declared ?? []);
  }

  // `declared`: the sealed plan's graders, for a row that persists no case of its own (see `settled`).
  succeed(result: CaseResult, now: string, declared?: readonly GraderSpec[]): RunTransition {
    this.assertNotTerminal("succeed");
    return {
      patch: { status: "succeeded", result: this.settled(result, declared), updatedAt: now },
      facts: terminalRunFacts(this.record, "succeeded"),
    };
  }

  // queued|running → failed (execution error, isolated as a run failure).
  // result: the synthesized failed CaseResult (classified CaseFailure + the evidence trace the backend captured
  // at throw time) — the single-run twin of the batch path's failed result, so the ledger keeps the post-mortem
  // (placement identity, log tail) instead of only {code, message}. Optional: legacy callers settle error-only.
  fail(
    error: { code: string; message: string },
    now: string,
    result?: CaseResult,
    declared?: readonly GraderSpec[],
  ): RunTransition {
    this.assertNotTerminal("fail");
    return {
      patch: { status: "failed", error, ...(result ? { result: this.settled(result, declared) } : {}), updatedAt: now },
      facts: terminalRunFacts(this.record, "failed"),
    };
  }

  // Boot-recovery adoption: settle with a result harvested from the still-alive job (zero re-run).
  adopt(result: CaseResult, now: string, declared?: readonly GraderSpec[]): RunTransition {
    if (!this.canAdopt())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status },
        `run is already terminal (${this.record.status}) — adopt rejected`,
      );
    // …AND IT EMITS THE SAME TERMINAL FACT A NORMAL SETTLE DOES (arch-review 34 P1). It used to emit none,
    // which was behaviour-preserving right up until the run's completion callback started hanging off that
    // fact: a control plane that died and whose replacement ADOPTED the finished backend job settled the run
    // `succeeded` and told nobody — the exact situation the durable callback was built for. A run that ends
    // is news whichever process was there to see it end.
    return {
      patch: { status: "succeeded", result: this.settled(result, declared), updatedAt: now },
      facts: terminalRunFacts(this.record, "succeeded"),
    };
  }

  // Boot-recovery re-drive: back onto the queue's running path before re-dispatch.
  redispatch(now: string): RunTransition {
    if (!this.canRedispatch())
      throw new ConflictError(
        "CONFLICT",
        { run: this.record.id, status: this.record.status },
        "run cannot be re-dispatched (terminal, or no persisted caseSpec)",
      );
    return { patch: { status: "running", updatedAt: now }, facts: [] };
  }

  private assertNotTerminal(transition: string): void {
    assertRunNotTerminal(this.record, transition);
  }
}
