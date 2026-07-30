# Event plumbing — the platform's nervous system

> **Status: DESIGN (maintainer direction, 2026-07-29).** The last piece of the execution-model arc:
> [execution-model.md](./execution-model.md) §3 named the shape (*event → subscription → run*) and P7
> named the convergence; this document designs the plumbing that makes it stable. Generalizes
> [agent-automation.md](./agent-automation.md) A1 (the event log built as an *agent-activation
> substrate*) into the platform's one fact stream.
>
> **Maintainer's argument:** scaling throughput *intelligently* means demand arrives at the right time.
> Activating an agent = knowing **when** to ask — and that must be event-driven perception, not a user
> clicking a button. For that, the system itself must publish facts about its own operation, on plumbing
> stable enough to trust.

## The triad that makes throughput smart

Three legs, two already designed:

- **배관 (WHEN)** — this document: facts published as the system operates → subscriptions decide what
  reacts. Demand arrives exactly when the world changed, not when a human noticed or a poller woke.
- **게이트 (HOW MUCH)** — execution-model §5: every reaction is admitted (envelope, class=background,
  fan-out guards). Perception without the gate is the runaway vector; with it, an event storm queues
  instead of burning.
- **공급 (WHERE)** — placement + autoscaler + attachable runtimes absorb what admission lets through.

Events are the *timing* leg: without them the platform either polls (wasteful, late) or waits for humans
(idle capacity, stale reactions). With them, `throughput = f(what actually happened)`.

## What exists (and what it taught us)

**Strengths to keep** — the current log (`platform_events`, agent-automation A1) got the hard invariants
right: append-only facts (never inference), `causedBy` provenance, a **seq cursor** with asc/desc walks
plus a deployment-wide cursor for the agent service, best-effort push + pull-reconcile (at-least-once),
`(agent, event)` activation dedup, and the loop guards (self-cause ban, depth cap, cooldown,
`agent.run.*` never matchable).

**Five structural gaps:**

1. **Emission is sparse and hand-placed.** ~14 kinds, emitted from five hand-written call sites
   (run-service, scorecard-shared, comment-service, internal routes). The domain aggregates — which
   already own every legal state transition — return store patches and **no facts**. Everything else the
   system does (registry changes, file publishes, knowledge, runner liveness, budget thresholds, queue
   state) is invisible. A perception layer over 5% of the system is not perception.
2. **One consumer is hardwired.** The push path targets the agent service specifically
   (`AgentEventSink`). Notifications, Mattermost, and webhooks are **parallel hand-wired fan-outs** that
   never touch the log — three delivery mechanisms for the same class of fact, none replayable.
3. **Three trigger engines, three vocabularies.** Agent matcher (events), Temporal schedules (cron), CI
   (GitHub OIDC paths) each cause work their own way; only the first reads the log.
4. **Reliability is one rung tall.** TTL'd table + cursors is right for rung 1, but there is no stated
   ordering contract, no per-consumer offset management beyond the agent service, no dead-letter story
   for failed reactions, no replay tooling, no lag visibility.
5. **Emission can be forgotten.** Nothing structural ties "state changed" to "fact published" — the next
   service simply won't emit, and nobody will notice until an agent is blind to it.

## The design

### 1. Emission becomes structural — transitions return facts

The rich domain core already routes every legal state change through aggregate transition methods that
return the store patch. Extend the contract: **a transition returns `{patch, facts[]}`** — the fact is
computed where the legality is decided, by the code that provably knows the change happened. The service
persists patch + facts **in the same transaction** (Postgres: the `platform_events` insert rides the
mutation's tx — the outbox discipline; in-memory dev appends directly). Two consequences:

- *Forgetting is impossible*: no transition, no state change; transition ⇒ facts.
- *Emit never fails the operation and never lies*: same-tx means a rolled-back change publishes nothing,
  and a committed change always publishes.

Non-transition facts (threshold crossings, liveness flips) come from the few genuine observers — but the
default is: **if a state machine moved, the fact came from the aggregate.**

### 2. One log, N cursors — consumers, not fan-outs

`platform_events` stays the single log. Everything that reacts becomes a **consumer with a durable
cursor**: the agent matcher (exists), the notification router, the Mattermost poster, the webhook
dispatcher, future consumers. Push (HTTP nudge / Pg LISTEN-NOTIFY) remains a **latency optimization**;
the cursor walk remains the correctness path — the pattern the agent service already proved, made
uniform. This buys: replay for free (rewind a cursor), one delivery semantics to reason about, lag as a
first-class observable, and new reactions without new plumbing.

### 3. Coverage grows by grammar, not by ad-hoc kinds

Kinds follow `<subject>.<verb>` with a registered taxonomy (the `agent.run.*` family folds into `run.*`
with `kind` per execution-model P3). Coverage waves: **W1** execution facts (exist) → **W2**
content/registry facts (harness/dataset/judge/capability versions, fs file publishes — the revision
ledger already records them, knowledge entries) → **W3** ops facts (runner online/offline, budget
threshold crossed, queue depth bands) → **W4** trace-derived facts
([native-observability](./native-observability.md) N2: thresholds/anomalies computed over the owned
trace store — the perception loop for operations). The review rule that keeps it honest: **a PR that adds
a state transition adds its fact.**

### 4. Delivery semantics, stated once

- **At-least-once, always.** Consumers dedup on `(consumer, eventId)`; effects stay idempotent via
  natural keys (activation dedup `(agent, event)` is the model).
- **Order is per-subject.** The log's `seq` orders globally per deployment; consumers may only assume
  ordering *within a subject id*. Cross-subject reordering is legal.
- **The log is the buffer.** Backpressure = a consumer's cursor falls behind; nothing is dropped at the
  door. Retention (TTL) must exceed the maximum tolerated lag + replay window — and `origin.eventId` on
  runs stays meaningful because the run record embeds the kind/subject it was born from (the log row
  expiring breaks browsing, never provenance).
- **Dead letters are visible.** A reaction that keeps failing parks with its event and surfaces (fleet
  view / ops), never silently retries forever.

### 5. Reactions pass the gate

A subscription firing creates a **Run** (execution-model §3) with `origin{cause:"event", eventId,
causedByRunId?}` — and that run passes the §5 admission gate: envelope, `class: "background"` by
default, fan-out guards, cascade cancel. Event storms therefore *queue under fairness and spend under
budgets* instead of stampeding the runtimes. This coupling — not the broker — is what makes event-driven
scaling safe: **the log makes demand timely; the gate makes it affordable.**

### 6. Trigger engines converge on subscriptions

One **subscription registry**: `{selector (kinds + filter), reaction (agent | notification | webhook |
mattermost | …), governance (cooldown, dedup window, enabled)}`. The agent matcher reads it (today's
trigger fields relocate); schedules become **time events** (`schedule.fired` into the same log — Temporal
stays the clock, its consumer becomes ordinary); CI webhooks land as workspace events. Three engines
remain as *producers*; reacting is one mechanism.

## Temporal and the event plane — the role charter

Two subsystems now claim "the system's main part": the event plane (this document) and Temporal
([orchestration.md](../orchestration.md)). They must not blur — and one line separates them:

> **완결 정의가 있는가 — does the work have a definition of done?**
> Yes → Temporal (orchestration of a finite, known plan). No → the event plane (open-ended narration
> and reaction).

**What Temporal actually is here** (audited): `scorecardBatchWorkflow` — a durable batch driver with
completion semantics (per-case retries, 500-case slices rotated via `continueAsNew`, cancellation, a
final aggregate); the **schedule clock** (`TemporalScheduleDriver` reconciles Temporal Schedules to the
DB SSOT; a fire is a durable fire-and-watch workflow); and nothing else. It is already **optional** —
`DirectOrchestrator` is the in-process fallback and dev boots without Temporal at all.

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
   regression: bisect, re-run, open a PR") stays a *thin* consumer that starts a workflow idempotently
   (`workflowId = eventId` — Temporal's own dedup closes the at-least-once gap). This is rung 3 of the
   ladder, stated as a rule.
4. **Neither is the ledger.** Run records = *what happened* (the SSOT product surfaces read); Temporal
   history = *how the driver did it* (implementation detail, never queried by the product); the event
   log = *the narration* (TTL'd, replayable). Three artifacts, three lifetimes — collapse any two and
   one tool is being misused.
5. **Both pass the same gate.** Workflow activities dispatch through the Scheduler/admission like every
   other demand; a workflow is not a side door around execution-model §5.

**Is Temporal necessary at all?** The audit both ways:

- *Replace Temporal with events?* A "batch driver consumer" advancing a batch on `run.completed` facts
  would need durable local state, timers and backoff, cancellation propagation, phase joins, in-flight
  process versioning, and history-size management (the 500-slice `continueAsNew` exists because even
  Temporal needs it) — that is a workflow engine hand-rolled on a cursor, the explicitly rejected rung.
- *Replace events with Temporal?* A router workflow per subscription means a closed consumer set, a
  code deploy per new reaction, no replay-for-free, and history-as-log. Equally wrong.
- **Verdict: both, but Temporal narrowly.** Completion-bearing execution only — and its optionality is a
  feature to preserve: the compose stack boots without it (Direct fallback), production batch scale
  turns it on. The event plane, by contrast, stops being optional the moment agents perceive: it is the
  sensory substrate.

**The ops-agent test — the adoption gate the charter implies.** Maintainer's criterion: if Temporal is
used *narrowly*, keeping it is risky **unless an autonomous ops agent can read its execution lifecycle
down to the detail level and control it**. Audited:

- **Read — passes, and better than logs.** Temporal's core design is an *event-sourced history*: every
  driver-lifecycle fact (activity scheduled/started/completed/failed with failure + stack trace + attempt
  number, timers, retries, `continueAsNew` links) is a structured, queryable record —
  `GetWorkflowExecutionHistory`, `DescribeWorkflowExecution` (live status + **pending activities with
  last-failure and next-retry-time**), `ListWorkflowExecutions` (visibility query language),
  `DescribeTaskQueue` (are workers alive; backlog), schedule describe/list, Prometheus metrics. The
  decisive fact: **the Temporal Web UI is built on the same public gRPC API** — there is no private
  endpoint, so UI-level visibility equals agent-level visibility *by construction*.
- **Control — passes.** Cancel (cooperative) / terminate (hard) / signal / query / update / **reset**
  (rewind to a prior workflow task) / batch operations over a visibility query / schedule
  pause·unpause·trigger·backfill — all on the same client our code already uses (we currently consume
  only `start/getHandle/result/describe/create/delete`; the control verbs are additive).
- **What history does NOT carry** (and why that is fine here): application logs printed *inside*
  activities go to the worker's stdout, not the history. In Everdict the activity is `dispatchCase` — the
  case's own logs/trace belong to OUR ledger (live log tail, trajectory) by the charter's rule 4. History
  = how the driver did it; that is exactly what it records completely.
- **Four real cautions:** ① *reset re-executes activities* — safe here only because batch planning is
  already idempotent against the run ledger (seeded children make `planBatch` skip done work), and that
  discipline must be stated as a precondition of exposing reset; ② *reading "the batch's history" means
  following `continueAsNew` runId chains* — the wrapper must walk them; ③ *payload codecs* (if ever
  introduced) would need the ops surface to hold the codec; ④ — the important one — **raw gRPC access
  would be a second, ungated control plane**: an agent cancelling workflows directly bypasses authz, the
  audit trail, and the ledger's vocabulary.

**Therefore: the Driver ops surface.** The ops agent reads and steers Temporal **only through Everdict**
— a thin wrapper (API + MCP parity) exposing describe / history-walk / pending-activities / cancel /
terminate / signal / reset / schedule-ops, addressed in **ledger vocabulary** (scorecard/run ids — the
correlation key already exists: `orchestration.workflowId` is stored on the record), gated by the normal
role matrix, and audited like every other mutation. This *refines charter rule 4*: product surfaces still
never treat history as the record of what happened; the **ops plane may read history about the driver** —
through the wrapper, as diagnosis, never as the ledger.

**Verdict on the risk:** Temporal *passes* the ops-agent test — its architecture makes the
machine-readable surface primary and the human UI a mere client, which is precisely the property the
criterion demands. Note the asymmetry: the `DirectOrchestrator` fallback is *less* agent-operable (an
in-process promise with no history, no pending view, no cancel of started work) — dropping Temporal would
*reduce* autonomous controllability of batches, not increase it. The generalized adoption gate is worth
keeping: **a tool whose full lifecycle is not readable and steerable over its API — where the UI can do
things the API cannot — does not get to own a system's main part.**

**Failure domains partition cleanly** (worth keeping true): Temporal down → batches and schedule firing
pause; direct runs, the log, consumers, and agents continue. The log shares the stores' database, so it
shares their failure domain — no new way to be down. Neither outage corrupts the other's state; both
resume from their own cursor/history.

## Reliability ladder (rungs, explicitly)

1. **Now**: Pg table + seq + per-consumer cursors + TTL; push nudge; reconcile poll.
2. **E1**: outbox same-tx emission + LISTEN/NOTIFY latency + uniform consumer runtime (cursor, dedup,
   dead-letter, lag metric).
3. **E3+**: Temporal workflows for consumers needing durable multi-step reactions (already in the stack).
4. **Deferred indefinitely**: a real broker (Kafka/NATS). The non-goal stands until scale *measured at
   rung 3* demands it.

## Phasing

> **Sequenced by [execution-master-plan.md](./execution-master-plan.md)** (plan of record — waves W0–W7; decisions locked at recommended values).


- **E0 — Grammar + structural emission.** Kind taxonomy registered; aggregate transitions return
  `{patch, facts[]}`; same-tx outbox on Pg stores; `agent.run.*` → `run.*` aliasing.
- **E1 — Consumers as cursors.** Consumer runtime (cursor/dedup/dead-letter/lag); notifications,
  Mattermost, webhooks re-based onto the log; LISTEN/NOTIFY nudge. **First rung SHIPPED (W3)**:
  `EventConsumerRunner` (one log, N durable cursors — per-event cursor persistence, retry-then-dead-letter
  so a poison fact never dams the log, `lag()` as the backpressure observable, mig 0097) + the personal
  FEED re-based (`feed:runs`/`feed:scorecards` — the completion facts carry exactly the old feed gate, and
  rows key on `nf-<eventId>` so a cursor rewind replays with zero duplicate effects, the W3 acceptance).
  Remaining rungs: Mattermost (its coverage is wider than the facts — machine-fired completions post too,
  so re-basing it is an E2 coverage decision), webhooks, and the Pg LISTEN/NOTIFY nudge (in-process poll at
  3s is the single-CP correctness path today).
- **E2 — Coverage W2+W3.** Content/registry/fs/knowledge/ops facts; the "transition ⇒ fact" review rule.
  **First rung SHIPPED (master-plan W4)**: content/registry facts — `harness.registered` /
  `dataset.registered` / `judge.registered` via the `withRegisteredFact` composition-root decorator (one
  choke point covers routes, MCP, bundle apply, benchmark import, CI re-pin; `_shared` seeds never emit) ·
  `file.published` from the `RevisionedWorkspaceFs` choke point (agent writes stamp the loop guard's
  `causedBy agent:<id>:<conversation>`) · `knowledge.created/proposed/approved` (the S14 HITL loop's
  observable half) · ops fact `budget.exceeded` emitted by the admission gate's 402 refusal (the gate
  already computed it). All are trigger-matchable (`TRIGGERABLE_EVENT_KINDS`). The review rule is codified
  in `.claude/rules/events.md`. **Deferred rungs**: `runner.online/offline` (needs a presence sweeper —
  lease-TTL expiry detection, not a clean existing transition), budget *threshold* facts (80%-crossed needs
  a meter hook; the refusal fact ships first), queue-depth bands (a W7 measurement concern), and the
  Mattermost re-base (its coverage is wider than the facts — machine-fired completions post too; it stays
  direct until the E3 subscription registry makes reactions one mechanism).
- **E3 — Convergence.** Subscription registry; `schedule.fired`; CI events; reactions admitted through
  the §5 gate (needs execution-model P4). **Producer rung SHIPPED (master-plan W6)**: every schedule fire
  lands `schedule.fired` on the log (subject = the schedule; payload carries `scheduleId`/`name`/`mode`
  so trigger FILTERS can select one schedule — a time-driven agent is now just a subscription on the
  clock's tick; Temporal stays the clock, its consumer became ordinary). CI needed no new kind: a
  CI-submitted batch's `scorecard.submitted` fact already carries `origin` (`github-actions`) +
  provenance in its payload — filterable today. Remaining rungs: the one subscription registry
  (relocating agent trigger fields once the shape holds), webhooks as a reaction kind, and the
  T-d `reaction:<eventId>` multi-step executor.
- **E4 — Trace-derived facts.** Thresholds/anomalies over the owned trace store (needs native-obs N2) —
  continuous operations: the trace store perceives, the log announces, agents react, runs record.
  **Threshold rung SHIPPED (master-plan W6)**: tenant-configured thresholds
  (`WorkspaceSettings.traceThresholds` — `GET/PUT /workspace/trace-thresholds` +
  `get/set_workspace_trace_thresholds`; metric ∈ usd | total_tokens | llm_calls | tool_calls |
  tool_failures | events | latency_ms_max) are evaluated over EVERY trajectory at seal time by the
  `withTracePerception` decorator on the store's one choke point (run settles, the OTLP door,
  materialized imports, sandbox teardowns — announce-once rides the seal's `created` flag, so
  at-least-once callers never double-emit). A crossing lands `trace.threshold_crossed`
  (trigger-matchable) — with the E3 producers and the A3 activation engine this closes the flagship
  loop's plumbing: production trace → owned store → fact → subscribed agent wakes, enveloped and gated.
  Anomaly detection (beyond arithmetic bounds) stays a later rung.

## Open decisions

- **EO1 — Facts from transitions vs store decorators?** *Rec: transitions* — the aggregate is the one
  place legality is known; decorators see writes, not meaning. (Observers only for non-transition facts.)
- **EO2 — Same-tx outbox everywhere?** *Rec: yes on Pg; direct append in-memory.* A separate relay
  process is not needed while the log and the stores share the database.
- **EO3 — Strict global ordering?** *Rec: no* — per-subject only; global `seq` is a cursor, not a promise.
- **EO4 — Retention.** *Rec: TTL = max(consumer lag SLO, replay window) with per-kind overrides*; run
  provenance survives expiry by embedding.
- **EO5 — Are notification preferences subscriptions?** *Rec: yes eventually* (a bell is a consumer with
  a per-user filter), but migrate after E1 proves the consumer runtime — don't couple the redesign to it.
- **EO6 — Who may publish?** *Rec: the platform only.* Tenant/agent-authored events stay out of v1 —
  a user-publishable bus is a different product with different abuse surfaces.

## Non-goals / guardrails

- **Not a message broker.** A table, cursors, and discipline — until measured scale says otherwise.
- **Not event sourcing.** Stores remain the state SSOT; events are facts *about* changes, never the
  storage of them.
- **Facts, not inference.** "Regressed", "flaky", "anomalous" are judgments — they belong to judges and
  agents (and to trace-derived *threshold* facts only where the rule is explicit tenant config).
- **Emission never fails an operation** — same-tx makes this exact: they fail together or not at all.
- **Nothing reacts unadmitted.** Every reaction is a Run through the gate; a consumer that bypasses
  admission is a bug, not an optimization.

Cross-links: [execution-model.md](./execution-model.md) §3/§5/P7 ·
[agent-automation.md](./agent-automation.md) A1 (generalized here) ·
[native-observability.md](./native-observability.md) N2 (trace-derived facts) ·
[scheduled-evals.md](./scheduled-evals.md) (schedules → time events).
