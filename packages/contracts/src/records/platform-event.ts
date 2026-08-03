import { z } from "zod";

// Platform events — immutable FACTS the control plane records at lifecycle points (docs/architecture/agent-automation.md).
// One recorded fact feeds three readers: the personal feed / Mattermost (via NotificationService), the agent service
// (trigger matching wakes subscribed agents), and the event log itself (audit + replay-into-a-draft-agent).
// Facts only — inference ("regressed", "flaky") is the agent's job; the control plane never emits a judgment.
// The vocabulary is CLOSED (add a kind here when a new emit point ships — never emit an ad-hoc string).
export const PLATFORM_EVENT_KINDS = [
  // A parked agent mutation entered/left the human-decision gate (agent-automation A6): requested when the
  // agent parks, decided when a member (or the expiry timer) settles it — payload.decision = approved |
  // denied | expired. Deliberately NOT trigger-matchable in v1 (agents deciding approvals is the runaway
  // vector squared).
  "approval.requested",
  "approval.decided",
  "run.submitted",
  "run.completed",
  "run.failed",
  "scorecard.submitted",
  "scorecard.case.completed", // one case of a streaming batch finished — payload carries caseId + verdict
  "scorecard.completed",
  "scorecard.failed",
  "scorecard.cancelled",
  // Phase 2 re-applied after the fact (execution-model P2): judges scored an existing group's runs and the
  // aggregate was re-written; payload.promoted marks an experiment that became a scorecard by being scored.
  "scorecard.scored",
  "report.completed", // a scheduled analysis report was produced (analysis-studio V4)
  "comment.created",
  // E2 content/registry facts (event-plumbing.md §3, coverage wave 2): a new immutable version landed in a
  // tenant registry — subject is the capability id, payload carries the version. Emitted by the composition-root
  // registry decorator (one choke point covers routes, MCP, bundle apply, benchmark import, CI re-pin);
  // _shared seeds never emit (boot seeding is not workspace news).
  "harness.registered",
  "dataset.registered",
  "judge.registered",
  // A workspace-filesystem write published an attributed revision — the revision ledger is the state, this is
  // its fact (emitted by the RevisionedWorkspaceFs choke point). Agent-authored publishes stamp
  // causedBy agent:<agentId>:<conversationId>, the loop guard's key.
  "file.published",
  // Knowledge lifecycle (knowledge-graph S14 HITL): created = member-authored (born active), proposed = an
  // extraction candidate awaiting review, approved = proposed → active with authorship transferred.
  "knowledge.created",
  "knowledge.proposed",
  "knowledge.approved",
  // E3 time events (event-plumbing.md §6): the clock's tick lands on the log — Temporal stays the clock,
  // its consumer becomes ordinary. payload carries the schedule's name + fire mode; a time-driven agent is
  // just a subscription on this kind (+ a scheduleId filter).
  "schedule.fired",
  // E4 trace-derived facts (event-plumbing.md §3 wave 4): a sealed trajectory crossed a tenant-configured
  // threshold — the owned store PERCEIVES, the log ANNOUNCES, agents react (the continuous-operations loop's
  // sensory half). payload carries runId/threshold/metric/value/limit/source. Facts, not judgments: the
  // crossing is arithmetic over the sealed events, never an inference.
  "trace.threshold_crossed",
  // E2 ops facts (coverage wave 3): a delegated envelope REFUSED caused work at the admission gate (402) —
  // the "agent hit its budget" signal, emitted by the gate that already computed the refusal (never silently).
  "budget.exceeded",
  // N3 ingestion admission: the OTLP door REFUSED an export past the workspace's events/hour quota (429
  // at the door, never a silent drop). Emitted with an in-process cooldown so a retrying firehose reads as
  // one signal, not a flood.
  "trace.ingestion_throttled",
  // Runtime-debugging live-anomaly facts (M2 — the bridge from monitoring to automation): perceptions the
  // execution machinery ALREADY computes, announced so subscriptions/agents can react while the run is alive
  // instead of a person polling. Bounded by construction, never a per-poll flood:
  // - run.placement_blocked: the cluster scheduler cannot place a run's case right now (Nomad blocked
  //   evaluation / capacity verdict). Emitted ONCE per run (and once per scorecard batch) at the first
  //   sighting, with the scheduler's own verdict in the payload.
  "run.placement_blocked",
  // - runtime.circuit_opened: the spillover circuit breaker opened for a (tenant, runtime) lane — the runtime
  //   is being skipped as unhealthy. Emitted at the OPEN transition only (the breaker already dedupes state).
  "runtime.circuit_opened",
  // Task-ledger lifecycle facts (the workspace coordination substrate, docs/architecture/agent-teams.md) —
  // emitted by TaskService, the single choke point both transports call. created/completed are the
  // trigger-matchable pair ("new work appeared" / "a dependency cleared" — the team wake-up signals); claimed/
  // cancelled are observable coordination news. Loop safety: an agent-created task stamps causedBy
  // agent:<agentId>:<conversationId> (loop guard #1 — the creator never wakes on its own task), and cross-agent
  // wakes are the POINT of a team ledger, bounded by activation admission + cooldowns like every trigger.
  "task.created",
  "task.claimed",
  "task.completed",
  "task.cancelled",
  // Eval-tracker lifecycle facts (docs/tracker.md) — the "why we evaluate" layer announcing itself. Emitted by
  // IssueService/ProjectService/InitiativeService, the single choke point every transport calls. The status
  // transitions are FOLDED into one kind per subject rather than one kind per verb: payload carries {from, to}
  // plus `cause` (manual | github_sync | regression), so a subscription expresses "wake me when an issue
  // regresses" as a payload filter instead of forcing a kind per outcome. Facts, not judgments: `regression`
  // states that a linked scorecard's pass rate fell below the resolution scorecard's — arithmetic over sealed
  // results. Durable per-issue history lives ON the record (the log is swept); these facts are the live half.
  // Teams group issues inside a workspace (records/team.ts). Creation and roster changes are workspace-shaping
  // news — who can now file under which prefix — so they are facts; a rename is content editing and emits none,
  // the same split the issue aggregate already makes between update() and its status transitions.
  "team.created",
  "team.member_added",
  "team.member_removed",
  "issue.created",
  "issue.status_changed",
  // An issue changed teams — which re-mints its identifier, so this is the fact that explains why the name in
  // everyone's links stopped being the name in the list. It carries both identifiers and both team ids.
  "issue.moved",
  "issue.linked", // a capability (harness/dataset/judge/scorecard/run/view) was attached to an issue
  // A team's iteration was planned, or closed with whatever was left. `cycle.completed` carries `carriedOver`,
  // which is the number a retro actually asks for — and the wake signal for "write the iteration summary".
  "cycle.created",
  "cycle.completed",
  // The workspace label vocabulary (records/tracker.ts). Defining or retiring a label reshapes how the whole
  // workspace classifies its work — that is news in the same sense a new team is. A recolour/rename is content
  // editing on an existing label, so it emits `updated` rather than pretending to be a new definition.
  "issue_label.created",
  "issue_label.updated",
  "issue_label.deleted",
  "project.created",
  "project.status_changed",
  // Somebody posted a project update — the one JUDGMENT the tracker records, because a human made it. The
  // payload carries the health, so "wake me when a project goes off track" is a payload filter rather than a
  // kind per outcome, exactly like the issue transitions.
  "project.update_posted",
  "initiative.created",
  "initiative.status_changed",
  // The same judgment one level up: somebody reported on the GOAL. Separate from `project.update_posted`
  // because the subject is what a listener filters on — "tell me when this goal slips" is not "tell me when any
  // of its projects did", and the goal's own update is the one a stakeholder reads.
  "initiative.update_posted",
  // Agent-run lifecycle facts (reported BY the agent service) — observable in the feed/fleet view, but NEVER
  // trigger-matchable in v1 (agents watching agents is a runaway vector; see the loop-prevention guardrails).
  "agent.run.started",
  "agent.run.awaiting_approval",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.cancelled",
] as const;
export const PlatformEventKindSchema = z.enum(PLATFORM_EVENT_KINDS);
export type PlatformEventKind = z.infer<typeof PlatformEventKindSchema>;

// E0 kind grammar (event-plumbing.md): kinds follow `<subject>.<verb>`, and the `agent.run.*` family is the
// PRE-P3 spelling of `run.*` — an agent activation IS a run (execution-model.md P3 makes it a Run{kind:"agent"}
// row emitting run.* facts directly; this alias map is the registered bridge until then, and retires with P3).
// The emit side deliberately does NOT flip here: the v1 "agents watching agents" guardrail is structural
// (TRIGGERABLE_EVENT_KINDS simply excludes the family), and renaming the emitted kinds before the matcher gains
// a subject-aware guard would make agent activations trigger-matchable — the runaway vector the guardrail bans.
// Read surfaces that want the target grammar normalize through canonicalEventKind (aliased values are the P3
// spellings, so they are intentionally NOT members of the closed vocabulary yet).
export const AGENT_RUN_EVENT_KIND_ALIASES = {
  "agent.run.started": "run.started",
  "agent.run.awaiting_approval": "run.awaiting_approval",
  "agent.run.completed": "run.completed",
  "agent.run.failed": "run.failed",
  "agent.run.cancelled": "run.cancelled",
} as const satisfies Partial<Record<PlatformEventKind, string>>;

export function canonicalEventKind(kind: PlatformEventKind): string {
  return (AGENT_RUN_EVENT_KIND_ALIASES as Partial<Record<PlatformEventKind, string>>)[kind] ?? kind;
}

// What the fact is about — a pointer, never the document. Detail is read back through the normal (RBAC-gated)
// tools at consumption time, so authorization stays authoritative at read time, not emit time.
export const PlatformEventSubjectSchema = z.object({
  type: z.string().min(1), // "scorecard" | "run" | "comment" | "agent_session" | …
  id: z.string().min(1),
});
export type PlatformEventSubject = z.infer<typeof PlatformEventSubjectSchema>;

// A fact as a DOMAIN TRANSITION computes it — unstamped (no id/tenant/seq/timestamp; the service stamps
// identity, and the store persists it in the SAME TRANSACTION as the state change it describes — the
// event-plumbing.md E0 outbox). `recipient` is push-targeting metadata (teammate compatibility), never persisted.
export const PlatformFactSchema = z.object({
  kind: PlatformEventKindSchema,
  subject: PlatformEventSubjectSchema,
  actor: z.string().optional(),
  recipient: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  causedBy: z.string().optional(),
  message: z.string(),
});
export type PlatformFact = z.infer<typeof PlatformFactSchema>;

export const PlatformEventRecordSchema = z.object({
  id: z.string(),
  // Store-assigned monotonic cursor (per deployment) — the agent service reconciles missed events with
  // `seq > lastSeen` (at-least-once + id dedup), so delivery needs no broker.
  seq: z.number().int().nonnegative(),
  tenant: z.string(),
  kind: PlatformEventKindSchema,
  subject: PlatformEventSubjectSchema,
  actor: z.string().optional(), // the subject (user / agent principal) whose action produced the fact
  // Minimal pointers only (ids + status + counts) — never full documents (see subject note above).
  payload: z.record(z.unknown()).default({}),
  // Provenance: the agent run whose action caused this fact. Trigger matching skips events caused by the
  // same agent (loop prevention) unless that agent opted into self-cause chains.
  causedBy: z.string().optional(),
  message: z.string(), // one-line human/agent-readable rendering (what a woken agent reads first)
  createdAt: z.string(),
});
export type PlatformEventRecord = z.infer<typeof PlatformEventRecordSchema>;
