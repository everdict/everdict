---
kind: wiki
title: "Event plumbing — the platform's nervous system"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/platform-event/platform-event-service.ts, packages/application-control/src/platform-event/outbox.ts, packages/application-control/src/platform-event/event-consumer-runner.ts, packages/application-control/src/platform-event/subscription-reaction-consumer.ts, packages/contracts/src/records/subscription.ts]
---
# Event plumbing — the platform's nervous system

The platform publishes facts about its own operation to one durable log, and consumers and subscriptions decide
what reacts. This is the *timing* leg of throughput: activating an agent means knowing **when** to ask, and that
has to be event-driven perception rather than a poller or a member clicking a button. The admission gate
([execution-model.md](./execution-model.md) §5) decides how much of the resulting demand is admitted, and
placement and runtimes decide where it runs. The page generalizes
[agent-automation.md](./agent-automation.md) A1 — the log built as an agent-activation substrate — into the
platform's one fact stream, in the shape execution-model §3 names: *event → subscription → run*.

Code comments cite this page's sections §1–§6, the rung labels E0–E4, and EO4 (retention).

## The log

- **Record** — `PlatformEventRecordSchema` in `packages/contracts/src/records/platform-event.ts`:
  `{id, seq, tenant, kind, subject {type, id}, actor?, payload, causedBy?, message, createdAt}`. Subject and
  payload are pointers, never documents; detail is read back through the RBAC-gated tools at consumption time.
- **Storage** — the append-only table `everdict_platform_events` (migration 0085). `seq` is the deployment-wide
  monotonic cursor.
- **Vocabulary** — closed: `PLATFORM_EVENT_KINDS`. The subset a trigger or subscription may select is
  `TRIGGERABLE_EVENT_KINDS` (`packages/contracts/src/harness/agent-spec.ts`); `agent.run.*`, `approval.*`,
  `checkpoint.*` and `run.snapshotted` are deliberately outside it.
- **Readers** — members read `GET /events` ↔ MCP `list_platform_events`; the agent service walks
  `GET /internal/events` (§2).
- **Retention (EO4)** — `EVERDICT_EVENT_RETENTION_DAYS` runs an hourly sweep on the control plane; unset keeps
  facts forever. A run records the fact it was born from (`origin.eventId`/`eventKind`), so an expired row
  breaks browsing, never provenance.

## §1 Emission

A fact reaches the log by one of two paths; `PlatformEventService`
(`packages/application-control/src/platform-event/platform-event-service.ts`) is the push seam for both.

- **Outbox (E0) — facts from transitions.** Aggregate transitions in `@everdict/domain` return `facts:
  DomainFact[]` beside the store patch (run, scorecard batch, approval, issue, issue label, project, initiative,
  product). `stampFacts` (`packages/application-control/src/platform-event/outbox.ts`) stamps id, tenant and
  time and renders the message through `fact-projection.ts`; the Pg store writes the rows into
  `everdict_platform_events` atomically with the state change; and `pushPersisted` then nudges live consumers
  with the persisted ids. A rolled-back change publishes nothing and a committed one always has its
  fact. The same discipline covers the checkpoint, verification, campaign, product-version and release stores.
- **Direct emit — choke points and observers.** `emit` appends to the log and then pushes to the agent service,
  both best-effort: a failure never touches the business result, and can lose the fact. This path carries the
  composition-root decorators and the observers: `withRegisteredFact` (`harness|dataset|judge.registered`),
  `RevisionedWorkspaceFs` (`file.published`), knowledge entries, `comment.created`, `schedule.fired`,
  `report.completed`, the admission gate's `budget.exceeded`, and `withTracePerception`
  (`trace.threshold_crossed`).

Agent-caused facts stamp `causedBy: agent:<agentId>:<conversationId>`, the loop guard's key (§5). The review rule
— a change that adds a state transition adds its fact — is `.claude/rules/events.md`.

## §2 One log, N cursors (E1)

`EventConsumerRunner` (`packages/application-control/src/platform-event/event-consumer-runner.ts`) walks the log
once per consumer from a durable cursor (`everdict_event_cursors`, migration 0097), polling every 3 s in-process;
`nudge()` is the latency path. A failing event is retried three times, then recorded in
`everdict_event_dead_letters` and logged, and the cursor moves on, so one poison fact never dams the log. `lag()`
reports latest `seq` minus cursor per consumer. The control plane registers `feed:runs` and `feed:scorecards`
(the personal feed, rows keyed `nf-<eventId>` so a rewind writes no duplicates), `mm:completions` (the only
Mattermost writer), `tracker:update-notify`, `tracker:regression-watch`, `subscriptions:reactions` (§6) and
`runs:completion-webhook`. There is no Pg LISTEN/NOTIFY nudge.

The agent service consumes the same log from outside: the control plane pushes each fact to its `POST /agent/events`
through `AgentEventSink` (best-effort), and `startEventReconcile` (`apps/agent/src/agent-activation.ts`) walks
`GET /internal/events` every 60 s from an in-memory cursor, skipping facts older than an hour. The durable
per-(agent, event) dedup makes the overlap safe.

## §3 Coverage and grammar

Kinds follow `<subject>.<verb>`; a status transition is one kind with `{from, to}` in the payload, so an outcome is a
payload filter rather than a new kind. The families on the log today:

- **Execution** — `run.*`, `scorecard.*` (including `scorecard.case.completed`, `scorecard.scored`, the gate
  decisions) and `report.completed`.
- **Content and registry (E2)** — `harness|dataset|judge.registered`, `file.published`,
  `knowledge.created|proposed|approved`.
- **Ops (E2)** — `budget.exceeded` (the admission gate's 402), `run.placement_blocked`, `runtime.circuit_opened`,
  `trace.ingestion_throttled`.
- **Time (E3)** — `schedule.fired`, emitted by every schedule fire with `scheduleId`, `name` and `mode` in the
  payload.
- **Trace-derived (E4)** — `trace.threshold_crossed`. Workspace thresholds live in
  `WorkspaceSettings.traceThresholds` (`GET`/`PUT /workspace/trace-thresholds` ↔ MCP
  `get_workspace_trace_thresholds`/`set_workspace_trace_thresholds`; metrics `usd`, `total_tokens`, `llm_calls`,
  `tool_calls`, `tool_failures`, `events`, `latency_ms_max`) and are evaluated on every trajectory seal by
  `withTracePerception`, announced only when the seal actually created a row.
- **Everything else** — approvals, checkpoints, tasks, tracker (issues, labels, projects, initiatives), product
  timeline, evolution campaigns, and the agent-run lifecycle `agent.run.*`.

`agent.run.*` is the older spelling of `run.*`: `AGENT_RUN_EVENT_KIND_ALIASES` and `canonicalEventKind` normalize
it for readers, while emission keeps the old names so the family stays outside `TRIGGERABLE_EVENT_KINDS`.
`harness.moved`, `dataset.moved`, `judge.moved` and `scorecard.moved` are still in the vocabulary but have had no
emit point since the team axis was removed (migrations `0211`/`0212`). Not emitted at all: runner online/offline,
budget-threshold crossings short of a refusal, queue-depth bands.

## §4 Delivery semantics

- **At-least-once.** Effects are idempotent by natural key: feed rows `nf-<eventId>`, the per-(agent, event)
  activation dedup, `x-everdict-event` on webhooks for receiver dedup, and deterministic workflow ids.
- **Order is a cursor, not a promise.** `seq` orders facts per deployment; a consumer may rely on order only
  within one subject.
- **The log is the buffer.** Backpressure shows up as cursor lag, never as a dropped fact, which is why retention
  (EO4) must exceed the maximum tolerated lag plus the replay window.
- **Dead letters are recorded**, never retried forever. The table has no read route; the log line is the alert.

## §5 Reactions pass the gate

Every agent activation — spec triggers, subscription rules, workflow steps — asks the control plane's
`POST /internal/activations/admit` (the tenant budget) before the run exists; a 402 skips visibly. The run is
recorded with `origin {cause: "event", eventId, eventKind}`. Work that names a causer (`origin.causedByRunId`)
also passes `admitCausedWork` (`packages/application-control/src/admission/admission.ts`): the causer's envelope
budget (402, emitting `budget.exceeded`), a causal-depth cap of 8 (429), and a per-envelope in-flight cap counted
from the run ledger (default 1000). The log makes demand timely; the gate makes it affordable.

The activation engine (`AgentActivator`, `apps/agent/src/agent-activation.ts`) adds the loop guards: it never wakes
an agent on a fact its own run caused (`causedBy`), applies a per-(agent, kind) cooldown (30 s default) or the
rule's `cooldownSec`, dedups per (agent, event) on the session record, and drops visibly past three queued runs
per agent. `agent.run.*` is never matchable.

## §6 Subscriptions (E3)

A `SubscriptionRecord` (`packages/contracts/src/records/subscription.ts`; `everdict_subscriptions`, migration
0100) is `{name, selector {kinds, filters}, reaction, governance {enabled, cooldownSec?}}`. Routes
`POST`/`GET /subscriptions`, `PATCH`/`DELETE /subscriptions/:id` ↔ MCP `create_subscription`,
`list_subscriptions`, `update_subscription`, `delete_subscription`; authz reuses `agents:read`/`agents:write`;
the web surface is Settings › Subscriptions (`apps/web/src/app/[workspace]/settings/subscriptions/page.tsx`).
Subscriptions and agent triggers share one selector grammar and one matcher, `eventSelectorMatches` in
`@everdict/domain` (the activator's `triggerMatches` delegates to it).

Reactions are a closed union, each with a live executor:

- **`agent`** — matched inside the agent service's activation engine beside spec triggers, under the same guards;
  an agent its own trigger already woke in the same pass is not woken twice.
- **`webhook`** — delivered by the `subscriptions:reactions` consumer: the pointer-only fact as JSON,
  `x-everdict-event` and `x-everdict-kind` headers, an HMAC-SHA256 `x-everdict-signature` when a `secret` is set,
  and an unsafe destination refused. Failures ride retry then dead-letter.
- **`workflow`** — one to five agent steps run as the Temporal workflow
  `everdict-reaction-<eventId>-<subscriptionId>`; the deterministic id is the dedup. Each step goes activity →
  control plane `POST /internal/reactions/step` / `GET /internal/reactions/step-status` → agent service
  `POST /internal/activations` / `GET /internal/activations/:sessionId/status`, and a retried step gets the
  existing session back (`activateDirect` via `findTriggerSession`). Without `EVERDICT_TEMPORAL_ADDRESS` the
  consumer logs and skips the rule rather than imitating a durable chain in-process.

The personal feed and Mattermost are blanket consumers (§2), not reaction kinds. A time-driven agent is a
subscription on `schedule.fired`; a CI-submitted batch needs no kind of its own, because `scorecard.submitted`
carries its `origin`. Agent-spec triggers still live on the agent spec; `POST /subscriptions/import-agent-triggers`
copies each into a rule and clears the spec's copy, idempotently.

## Temporal and the event plane — the role charter

Two subsystems carry the system's main part: the event plane (this page) and Temporal
([orchestration.md](../orchestration.md), which lists the workflows it runs and the Driver ops surface). One line
separates them:

> **Does the work have a definition of done?**
> Yes → Temporal (orchestration of a finite, known plan). No → the event plane (open-ended narration
> and reaction).

Temporal stays optional — `DirectOrchestrator` is the in-process fallback and the control plane boots without it.

**The charter (five rules):**

1. **Facts never carry intent; workflows never route facts.** Temporal-as-event-bus is the anti-pattern
   on one side (every new consumer becomes an orchestrator code change; workflow history degenerates
   into a de-facto log). Consumers-as-workflow-engines is the anti-pattern on the other (hand-rolled
   retry state machines on a cursor — rebuilding Temporal badly). Each system stays on its side of the
   done-definition line.
2. **Temporal produces facts and executes plans; it never decides reactions.** The schedule clock fires
   `schedule.fired` *into the log*; what reacts is the subscription registry's business. A batch
   workflow's case lifecycle emits facts through its activities' state transitions (same-tx outbox, like
   every transition) — **events narrate a batch; they never drive one.**
3. **Heavy reactions delegate down.** A subscription whose reaction is multi-step and durable ("on
   regression: bisect, re-run, open a PR") stays a *thin* consumer that starts a workflow idempotently —
   the `workflow` reaction's deterministic id (§6), so Temporal's own dedup closes the at-least-once gap.
4. **Neither is the ledger.** Run records = *what happened* (the SSOT product surfaces read); Temporal
   history = *how the driver did it* (implementation detail, never queried by the product); the event
   log = *the narration* (replayable, retained per EO4). Three artifacts, three lifetimes — collapse any two and
   one tool is being misused.
5. **Both pass the same gate.** Workflow activities dispatch through the Scheduler/admission like every
   other demand; a workflow is not a side door around execution-model §5.

**Why both, and Temporal narrowly.** A batch driver rebuilt as an event consumer would need durable local
state, timers, backoff, cancellation, phase joins and in-flight versioning — a workflow engine hand-rolled on a
cursor. A router workflow per subscription would mean a closed consumer set, a deploy per new reaction and
history used as a log. So Temporal runs completion-bearing plans only, and the event plane is the sensory
substrate agents perceive through.

**The adoption criterion.** A tool whose full lifecycle is not readable and steerable over its API — where the UI
can do things the API cannot — does not get to own a main part of the system. Temporal passes because its Web UI
is a client of the same public gRPC API. Raw gRPC access would still be a second, ungated control plane, so
agents and operators reach it only through the Driver ops surface: `GET /ops/driver/:family/:id`,
`POST …/cancel`, `POST …/terminate` ↔ MCP `describe_driver_workflow` / `cancel_driver_workflow` /
`terminate_driver_workflow`, addressed by ledger id and role-gated
([orchestration.md](../orchestration.md) has the families). History read there is diagnosis about the driver,
never the ledger.

**Failure domains partition.** Temporal down → workflows (batch drivers, schedule fires, workflow reactions)
pause; direct runs, the log, consumers and agents continue. The log shares the stores' database, so it adds no
new way to be down, and each side resumes from its own cursor or history.

## Guardrails

- **Not a message broker.** A table, cursors and discipline; a broker (Kafka, NATS) waits until measured scale
  demands it.
- **Not event sourcing.** Stores hold the state; events are facts *about* changes, never their storage.
- **Facts, not inference.** "Regressed", "flaky" and "anomalous" are judgments that belong to judges and agents;
  a trace-derived fact is arithmetic against an explicit workspace threshold.
- **Only the platform publishes.** No member-facing route or MCP tool appends an event; the agent service
  reports its own run lifecycle (`agent.run.*`) over the internal-token `POST /internal/agent-run-events`.
- **Nothing creates work unadmitted.** Every activation and every caused run passes the gate (§5); a reaction
  that creates work around it is a bug.

Cross-links: [execution-model.md](./execution-model.md) §3/§5 ·
[agent-automation.md](./agent-automation.md) A1 (generalized here) ·
[native-observability.md](./native-observability.md) (trace-derived facts) ·
[scheduled-evals.md](./scheduled-evals.md) (schedules as time events) ·
[notifications.md](./notifications.md) (the feed and Mattermost consumers).
