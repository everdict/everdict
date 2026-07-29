# Agent automation — platform-triggered agents, fleet observability, and the crafting studio

> **Status: P1–P7 LANDED (2026-07-28) — see "Implementation status" at the end for the shipped surface and
> the recorded v1 bounds.** Successor and generalization of
> [agent-teams.md](./agent-teams.md) (teammates + event bridge, S1–S6 landed) and
> [agent-conversations.md](./agent-conversations.md) (the chat runtime).
>
> **Vision (maintainer, verbatim intent):** the agent must not exist only as a chat session in the right
> panel. Everdict's agents must be able to (a) watch a scorecard from submission through infra dispatch to
> completion and *respond along the way*, and (b) after judging finishes, take the failed cases — with the
> full harness + dataset context — root-cause them, change real code, and contribute a PR. Many such agents
> will run all over the platform, so their activity must be **observable**. Supporting this requires two
> things: (1) the events that activate agents become **systematized** (a real event model, not ad-hoc
> pushes), and (2) users can **craft** agents — create them dynamically, experiment, keep improving them,
> and verify they actually work.

## Where we are (the seeds — all landed)

| Seed | What it gives us | Where |
|---|---|---|
| Chat runtime | loop, tools, compaction, SSE, transcript persistence | `packages/agent-runtime` + `apps/agent` |
| Teammates (S3) | long-lived sessions, mailbox wake, per-teammate serialization | `TeammateSupervisor`, `runTeammateTurn` |
| Event bridge (S4) | control plane pushes completion facts to watching teammates | `AgentEventSink` → `POST /agent/events` |
| Request-less auth | `agt_` tokens, `Principal.via:"agent"`, acts-as-creator | `agent-execution-auth.md` |
| Permission modes | `default` / `auto` / `bypass` / `plan` per session + HITL prompt + rules | `action-policy.ts`, `PermissionRegistry` |
| AgentSpec registry | versioned `(tenant,id,version)` config: instructions, MCP servers, capabilities, model | `contracts/harness/agent-spec.ts` |
| Skills + capabilities | workspace-owned procedures (authored or copied from a store example), store-adopted tools, try-drive | skills P11, capability store |
| Usage metering | per-conversation `priceUsd` meter + budgets | `usage-metering.md` |
| Code contribution | `open_github_pr`, GitHub App repos, the `scorecard-fix-pr` store example (copied into the workspace's skills) | integrations |

## Why chat-only is limiting (the gaps)

1. **Teammates are volatile and invisible.** The roster is an in-memory `Map` in `apps/agent/server.ts` —
   an agent-service restart silently kills every standing agent; nothing but the spawner's chat header
   shows they exist. "Many agents running all over the platform" cannot be built on this.
2. **Events are thin and unreliable.** Four completion facts, fire-and-forget HTTP, no persistence — no
   dispatch/case-level lifecycle, no replay, no audit, no at-least-once story.
3. **Agents are owner-scoped, not workspace-scoped.** Event fan-out targets *the creator's* teammates. A
   "workspace watches its scorecards" agent has no home.
4. **One config.** `apps/agent` resolves the single `AGENT_CONFIG_ID="default"` AgentSpec — users cannot
   define *several* agents with different jobs, tools, and autonomy levels.
5. **Approvals require an open browser tab.** The HITL prompt lives on the chat SSE stream; a headless
   (triggered) run that hits a guarded action has no one to ask — today it can only run ungated
   (teammate turns have no permit hook at all).
6. **No run identity.** An activation is just "a session got messages" — no status, no outcome, no cost
   roll-up, no fleet view, no kill switch.

## Concepts (the model — five nouns)

1. **Platform event** — an immutable *fact* the control plane records at a lifecycle point:
   `{ id, workspace, kind, subject { type, id }, actor?, payload, causedBy?, ts }`. Facts only —
   inference ("regressed", "flaky") stays agent-side (decided in agent-teams S4).
2. **Agent** — a crafted, versioned `AgentSpec` (existing registry entity, extended): identity +
   instructions + tools + model **+ triggers + default permission mode + budget + enabled flag**. The
   unit users create, iterate, and verify.
3. **Agent run** — one activation of an agent: a session with `origin` (what started it: chat /
   discussion / teammate / **trigger** / schedule / api), `status` (running / awaiting_approval / idle /
   completed / failed), and an outcome roll-up (turns, tool calls, cost, summary). The unit of
   observability.
4. **Parked approval** — a persisted permission request from a headless run: the run suspends
   (`awaiting_approval`), the member is notified, approval resumes the run. Decouples HITL from an open
   SSE stream.
5. **Fleet view** — the workspace-level surface listing agents and their runs live: who is running, why
   (triggering event), what they are doing (tool activity), what they cost, plus stop / disable controls.

## Architecture

```
control plane (apps/api)                          agent service (apps/agent)
┌───────────────────────────┐                    ┌──────────────────────────────────┐
│ lifecycle emit points     │  push (best-effort)│ trigger matcher                  │
│  scorecard.submitted      │──────────────────▶│  enabled AgentSpecs × event kind  │
│  scorecard.case.completed │  + since-cursor    │  + filter → activation           │
│  scorecard.completed ...  │◀──────────────────│                                  │
│           │               │  reconcile (pull)  │ agent run                        │
│           ▼               │                    │  session{origin:trigger,status}  │
│ platform_events log (mig) │                    │  headless loop, agt_ principal   │
│  = outbox + audit + replay│                    │  mode: auto/bypass or PARK ──────┼──▶ parked approval
└───────────────────────────┘                    │           │                      │    (notify → resume)
            ▲                                    │           ▼                      │
   agent.run.* lifecycle facts ◀─────────────────│ lifecycle reporting              │
   (feed / bell / Mattermost / fleet view)       └──────────────────────────────────┘
```

- **Emit points stay in the control plane** (it owns the facts); **matching + execution stay in the agent
  service** (it owns agent identity and the loop). The control plane no longer needs to know *who*
  watches — it emits workspace-scoped events; the agent service resolves subscribers from the registry.
  (Today's `recipient`-scoped fan-out remains for teammate compatibility during migration.)
- **Durability ladder, not a message broker.** P1 persists events (`platform_events`, append-only, TTL).
  Push stays best-effort; the agent service keeps a per-workspace cursor and reconciles missed events by
  polling `GET /internal/events?since=` on startup/interval. At-least-once with event-id dedup — no
  Kafka, no new infra. (Temporal is already there if a stronger ladder rung is ever needed.)
- **Loop prevention by provenance.** Everything an agent run causes carries `causedBy: agentRunId`
  (events, comments, scorecards it submits). A trigger **does not match events caused by the same
  agent** (opt-in `allowSelfCause` for advanced chains), plus a causation-depth cap and per-agent
  cooldown/dedup. Agent lifecycle facts (`agent.run.*`) are **never** triggerable in v1.

## Pillar A — the automation substrate

### A1. Event contract + persisted log (control plane)
> **Generalized by [event-plumbing.md](./event-plumbing.md)** — A1 built the log as an agent-activation
> substrate; the successor design makes it the platform's one fact stream (structural emission from
> domain transitions, all reactors as durable-cursor consumers, coverage waves, the §5 admission
> coupling).
`PlatformEventRecord` in `@everdict/contracts` (records + wire), `platform_events` migration
(workspace-scoped, append-only, indexed by `(workspace, ts)` + `(workspace, kind)`), an
`EventLog` port in `application-control`, and a single `emitPlatformEvent` seam inside
`NotificationService` (it already sits on every emit point — feed / Mattermost / AgentEventSink become
three readers of one recorded fact). Internal read route for the agent service cursor.

### A2. Richer fact kinds (control plane)
Systematize what the platform already knows, as facts:
- **Eval lane:** `scorecard.submitted` · `scorecard.case.completed` (streaming case pipeline already
  surfaces per-case results — include caseId + verdict so a watcher can react mid-batch) ·
  `scorecard.completed|failed|cancelled` · `run.submitted|completed|failed` · `schedule.fired`.
- **Collaboration lane:** `comment.created` (mention already exists as a feed kind — generalize).
- **Ops lane (later):** `runner.offline` · `queue.backlogged` — behind the same contract, added when an
  agent scenario needs them.
Payloads are **minimal pointers** (ids + status + counts), never full documents — the agent reads detail
through its normal MCP tools, which keeps RBAC authoritative at read time.

### A3. Registry-driven activation (agent service)
`AgentSpec` v2 (see Pillar B) declares `triggers`. The agent service matcher: on event → find enabled
agents in that workspace whose trigger matches (kind glob + declarative filter, e.g.
`{ "failedCases": { "gt": 0 } }` against the payload) → **create an agent run** (new session,
`origin: { type: "trigger", agentId, agentVersion, eventId }`) → seed the rendered event + the agent's
standing `task` instructions → run headless turns under an `agt_` token. Durable: subscriptions live in
the registry (DB), not process memory — restart-safe by construction. Concurrency reuses
`TeammateSupervisor` semantics (serialize per agent, coalesce while running; overflow → per-agent queue
with a cap).
**Teammate unification:** a chat-spawned teammate becomes a *thin unregistered agent* (same activation +
run machinery, roster persisted in a small table instead of the Map). One execution path, two front
doors (registry-crafted vs chat-spawned).

### A4. Agent-run identity (contracts + db)
> **Superseded in direction by [execution-model.md](./execution-model.md).** A4 gave the agent run an identity
> *inside the session record*, which left the platform with two execution ledgers (`RunRecord` vs
> `AgentSessionRecord.status`) and two surfaces (`/runs` vs `/agents`). The successor design makes an agent
> activation a `Run{kind:"agent"}` and keeps the session as the conversation it always was.

Extend `AgentSessionRecord` with `origin` + `status` + `outcome` (summary, counters, priceUsd roll-up
from the existing usage meter) — one migration. Chat sessions get `origin:{type:"chat"}` backfill. The
run's status transitions are owned by the agent service loop wrapper (started → awaiting_approval ↔
running → completed|failed).

### A5. Lifecycle facts + fleet view (web)
The agent service reports `agent.run.started|awaiting_approval|completed|failed` back to the control
plane (internal route → event log + notifications feed; Mattermost opt-in). Web gets a top-level
**Agents** area (this outgrows Settings):
- **Fleet feed** — workspace-wide agent runs, live (reuse the `/messages?since=` polling + SSE
  patterns): agent, trigger, status, duration, cost; filter by agent/kind/status.
- **Run detail** — the existing transcript components (tool activity, reasoning, todos) over the run's
  session + its triggering event + permission decisions.
- **Controls** — stop a run (loop abort seam exists), disable an agent (enabled=false, matcher skips),
  retry a failed activation (re-fire the recorded event — the event log makes this free).

### A6. Parked approvals (agent service + web)
Persist permission requests (`agent_approvals` table: run, tool, args preview, requestedAt, decision,
decidedBy) instead of holding them on an SSE stream. Headless run hits a guarded action → status
`awaiting_approval`, park the request, notify (bell + optional Mattermost), **suspend the turn** (the
tool call parks; the loop turn ends cleanly with a resume marker — no long-lived process wait, unlike
the 300s SSE window). Approval → re-wake the run (supervisor wake path) with the decision folded in;
deny/expire → decision recorded, run continues with a denial result. Approvals surface in the fleet
view + the bell; `default` mode becomes *usable* for automation instead of impossible.

### A7. Safety rails
Per-agent: budget (priceUsd per run + per day, on the existing billing meter — exceeded → run fails
with a visible outcome), max queued activations, cooldown per (agent, event kind), event-id dedup,
causation depth cap. Workspace kill switch (disable all agents). All limits visible in the fleet view —
an invisible guard is a support ticket.

## Pillar B — the crafting studio

### B1. AgentSpec v2 + many agents
Extend the existing entity (same immutable-version SSOT):
`triggers: [{ kind, filter? }]` · `task` (standing instructions rendered on activation — distinct from
`instructions`, which shape every turn) · `permissionMode` (default for its runs; chat picker still
overrides per session) · `budget` · `enabled`. Lift the single-config constraint: `AGENT_CONFIG_ID`
stays as the *chat default*; sessions gain an optional `agentId` (chat header picker — which crafted
agent you are talking to), and triggered runs pin `agentId@version`. Version tags + diff join the
existing 4-kind parity machinery.

### B2. Authoring surface
**Agents** area (list + detail + wizard, `agents:read/write` authz already exists): identity,
instructions/task, model, tools (capabilities from the store + raw MCP servers + skills), triggers,
permission mode, budget, enabled toggle, version history with diff. Follows the judge wizard idiom
(steps, live validation, `JudgePicker`-style pickers).

### B3. Try-drive: experiment before enabling
The crux of "craft until it actually works":
- **Chat try** — talk to the *draft* config ephemerally (profile built from the form, not the registry;
  same pattern as skill try / judge preview).
- **Event replay try** — pick a **real recorded event** from the log (e.g. last week's
  `scorecard.completed` with 3 failures) and fire it at the draft in **shadow mode**: permission mode
  forced to `plan` (read tools live, every mutation captured as *would-have-done* instead of executed).
  Watch the live transcript; iterate; save a version when satisfied. The event log (A1) is what makes
  this possible — replay is a query, not a fixture.
- Try transcripts attach to the draft/version for before/after comparison.

### B4. First-party templates (store)
Flagship agents ship as first-party templates surfaced in the Capability Store next to skills — adopt →
pre-filled AgentSpec the workspace tunes. The two launch templates are the flagship scenarios below.

### B5. Agent evals — Everdict evaluates its own agents (dogfood)
A crafted agent is an agent harness; Everdict grades agent harnesses. Close the loop: a **scenario
dataset** (recorded events + workspace fixture refs as cases) × an **agent version** → the agent-service
try-drive path runs each case in shadow mode → transcripts normalize to `TraceEvent` (the transcript is
already tool-call shaped) → judges score (did it root-cause the right file? was the proposed action
sensible?) → a scorecard, diffable across agent versions. Craft → try → **eval** → version → enable
becomes the full lifecycle, and agent quality gets the same regression discipline as everything else on
the platform. (Later phase; the only architectural prerequisite is keeping transcripts convertible —
they are.)

## Flagship scenarios (acceptance tests for the whole design)

1. **Scorecard Sentinel** — triggers: `scorecard.submitted`, `scorecard.case.completed`,
   `scorecard.completed|failed`. Watches a batch through dispatch (queue position, runner health via
   MCP reads), reacts mid-batch to case failures, retries transient infra failures (`retry_scorecard`
   under `auto` mode), posts a completion/anomaly summary (Mattermost/comment). Proves: rich events,
   durable activation, mid-lifecycle reaction, guarded writes, fleet visibility.
2. **Failure Fix PR** — trigger: `scorecard.completed` with `filter: failedCases > 0`. Drills failed
   cases (`get_scorecard_analysis`, traces, dataset case, harness spec), root-causes, changes code in
   the linked repo (GitHub App + code tools + the workspace's copy of the `scorecard-fix-pr` example), opens a PR
   (`open_github_pr` — guarded → parked approval in `default` mode, autonomous in `bypass` within
   budget), comments the PR link on the scorecard. Proves: deep-context assembly, code contribution,
   parked approvals, provenance (`causedBy` on the comment/PR), cost roll-up.

## Phasing (each shippable + testable; interleaves the pillars)

| Phase | Lands | Proves |
|---|---|---|
| **P1** | A1 event contract + log + emit seam; A2 eval-lane kinds | facts recorded, replayable |
| **P2** | B1 AgentSpec v2; A3 registry-driven activation (+ teammate unification) | a crafted agent runs headless off a real event, restart-safe |
| **P3** | A4 run identity; A5 lifecycle facts + fleet view | you can SEE the fleet |
| **P4** | A6 parked approvals; A7 safety rails | autonomy is governable |
| **P5** | B2 authoring surface; B3 try-drive (chat + event replay) | users craft + verify |
| **P6** | B4 flagship templates (Sentinel, Failure Fix PR) live end-to-end | the vision demo |
| **P7** | B5 agent evals | agents improve with eval discipline |

P1→P2 is the critical path (nothing activates without events + triggers). P3 lands before P4 because
observability makes approval flows debuggable. The flagships (P6) are exercised continuously from P2
onward as the manual test harness.

## Open decisions (maintainer input wanted)

1. **Automated-run identity.** Keep acts-as-enabling-member (`agt_` today — simple, RBAC-true) vs a
   per-agent principal (`subject: agent:<id>` — cleaner audit "the Sentinel did this", needs its own
   role grant model). Recommendation: keep acts-as-member through P4; revisit for per-agent principals
   when fleet audit demands it (the run's `agentId` already attributes the actor in the UI either way).
2. **Trigger matching locus.** Plan says agent service (owns execution; control plane stays
   subscriber-agnostic). Alternative: control plane matches and pushes targeted activations. Recommend
   agent service — it keeps the registry read + execution + concurrency in one place.
3. **Cron triggers.** Reuse control-plane Schedules (`schedule.fired` event + a schedule that targets an
   agent) vs native `cron` trigger on AgentSpec. Recommend reusing Schedules — one scheduling SSOT,
   and `schedule.fired` is just another event kind.
4. **Shadow-mode fidelity.** `plan`-forced replay captures intent but not real side effects. Good enough
   for B3/B5 v1; a worktree/sandbox execution rung can be added later for code-mutating agents.

## Implementation status (2026-07-28)

All seven phases landed in one pass (commits `2e4ac419` P1 → `f4ad9f69` P2 → `54122f70` P3 → `402267e6`
P4 → `5b596abf` P5 → `88542c6c` P6 → P7 with this doc update):

- **Events**: `PlatformEventRecord` + `platform_events` log (mig 0085) + the `PlatformEventEmitter` seam;
  facts emitted at run/scorecard/comment transition points; `GET /internal/events` reconcile cursor
  (workspace-optional = one deployment-wide loop); member surface `GET /events` + MCP
  `list_platform_events` (`events:read`, viewer+).
- **Activation**: AgentSpec v2 (`task`/`triggers`/`permissionMode`/`enabled`); `AgentActivator` in the
  agent service — kind+filter matching, self-cause skip, per-(agent,kind) cooldown, durable (agent,event)
  dedup on the session record (mig 0086), per-agent serialization + bounded queue, one-shot `agt_` token
  revoked with the run, the crafted agent's own profile resolved via `origin.agentId`.
- **Observability**: session `origin`/`status`; `agent.run.*` facts reported to the event log; web
  **Agents** page — live run feed, transcript drill-in, stop control; runs are workspace-visible.
- **Approvals**: mode-derived permit on headless runs (bypass / auto-guarded / default+plan = park all);
  parking reuses the discussion turn's PermissionRegistry + `GET /pending` + `POST /permission`; the fleet
  shows an inline Allow/Deny prompt; fail-closed deny when no approval channel exists.
- **Crafting**: `POST /agent/agents/try` — replay a real (or hand-built) event at a saved agent or draft
  in SHADOW mode (reads live under the caller's bearer, mutations captured as `wouldHave` + denied).
- **Conversational crafting studio (B2, user decision 2026-07-28: NOT a wizard)**: `/[workspace]/agents/craft`
  mirrors the analysis studio — the LEFT canvas is the agent being built, the RIGHT chat panel shapes it
  multi-turn. The crafting chat holds `craft_agent` (PATCHes the draft; the host streams it as the SSE
  `agent_draft` event and the canvas applies it live) and `try_agent_draft` (shadow-runs the CURRENT draft
  inside the conversation); the web captures the live draft per turn (the canvas-state feedback contract),
  so refinement grounds on manual edits too. The canvas also carries a replay-try panel (recent events via
  `GET /events`) and Save (the existing `PUT /agents/:id` upsert, preserving the spec's tool channels).
  **Loop-first by construction**: the crafted agent is pure DECLARATION (AgentSpec) over the ONE shared
  agentic loop — there is no per-agent builder/factory code path to fork the kernel; `resolveProfile` is the
  factory, the registry is the store of builds, and the crafting conversation is the builder.
- **Templates**: `scorecard-sentinel` + `failure-fix-pr` seeded into `_shared` at boot (disabled,
  creator-less — adopting = saving a workspace copy).
- **Agent evals (B5 v1)**: a try returns its transcript as a normalized `TraceEvent[]` — the eval recipe
  is N scenario tries → `POST /scorecards/ingest` (one case per try) → judges → a scorecard diffable
  across agent versions.

### Recorded v1 bounds (deliberate cuts, not omissions)

- **Teammate roster stays process-local.** Registry agents are the durable tier; chat-spawned teammates
  still live in the server Map. Persisting the roster (re-mint tokens on boot) is the follow-up.
- **Approval parks are DURABLE (W2 — A6's first rung).** A headless park now registers on the control
  plane (`POST /internal/approvals` → `everdict_approvals`, mig 0094; approval.requested/decided facts via
  the E0 outbox): the ask survives an agent-service restart as a record, members list/decide via
  `GET /approvals` + `POST /approvals/:id/decide` (↔ MCP `list_approvals`/`decide_approval`;
  agents:read/agents:write), and a decision is delivered back to the live in-process wait
  (`POST /internal/deliver-approval` → registry.respond). The in-process window stretches to the record's
  expiresAt (default 7 days) instead of 10 minutes; the LEGACY fleet channel (GET /pending →
  POST /permission) still works — the post-wait settle converges the ledger either way, first write wins.
  The remaining rungs SHIPPED in the same wave: the `approval:<id>` workflow owns the days-long
  deny-on-expiry (`everdict-approval-<id>` — signal on decide for prompt completion; a missed signal just
  lets the timer fire a no-op, expire skips settled records; ops-surface family `approval`), and a decision
  landing on a DEAD park (agent-service restart) RESUMES the run as one continuation turn on the same
  session (`POST /internal/resume-approval` → `AgentActivator.resumeApproval`): the transcript is the
  durable state, the decision seeds the turn, and an approve pre-authorizes exactly ONE re-ask of the
  parked tool — everything else goes back through the normal mode-derived gate (fail closed).
- **No run outcome roll-up yet** (turns/toolCalls/priceUsd on the record) — cost is metered via the usage
  bridge; the fleet shows status, not per-run cost.
- **`agent.run.*` facts reach the event log, not the bell.** Feed/Mattermost notification of failed runs
  is a NotificationKind addition away.
- **Authoring is conversational, not a wizard** (user decision) — the crafting studio above replaced the
  planned wizard. Remaining polish: canvas editing for trigger FILTERS (add/edit — today the chat authors
  them and the canvas shows/removes), an mcpServers/capabilities section on the canvas (the save path
  preserves them; editing stays in Settings › Agent), and a "draft linked" chip in the chat composer.
- **`causedBy` stamping covers agent.run facts.** A scorecard an agent submits does not yet carry the
  submitting run's provenance — cooldown + dedup + the agent.run trigger ban carry the loop-guard load
  until the MCP layer stamps it.
- **`schedule.fired` kind omitted** — `scorecard.submitted` carries `origin`/`scheduleId` pointers, which
  covers the cron-trigger decision (reuse Schedules) without a second kind.
- **Per-agent budgets not enforced yet** — conversation metering covers cost attribution; a per-agent
  A7's per-agent budget SHIPPED in W3 as the P4 ENVELOPE (execution-model §5.2):
  `AgentSpec.budgetUsd` becomes the activation run's delegated slice — every scorecard/run the agent
  submits passes the causal admission leg (402 past the cap, 429 past the causal-depth guard, forged
  causer ids 400), children stamp the envelope and settle real cost against it (`everdict_envelopes`,
  mig 0096). Compute-blind demand, budget-bound spend: the agent may burst, but it structurally cannot
  spend what it was not delegated. The agent's OWN turn tokens still meter to the tenant budget only —
  folding them into the envelope is the remaining A7 sliver. The causal tree is also the KILL SWITCH
  (§5.5, O8): a member stopping the agent run cascades — every non-terminal batch it caused cancels
  through the normal teardown (`ScorecardService.cancelCausedBy`, fired by the run ledger's cancelled
  settle), so large fan-out is safe to allow because it is cheap to revoke.

## Non-goals / guardrails

- **Not a message broker.** The event log is a table + cursor, not Kafka; upgrade rungs exist (Temporal)
  if scale demands.
- **Not ungoverned autonomy.** Every automated run is bounded by permission mode + guarded-action class +
  RBAC + budget + provenance loop guards; `bypass` is a per-agent explicit choice inside a budget.
- **Not a second agent runtime.** Triggered runs reuse the loop, mailbox, supervisor, and permission
  machinery — activation is a new front door, not a new engine.
- **Facts, not inference, from the control plane.** `scorecard.regressed` remains an agent-side judgment
  (diff via MCP) — the platform emits what happened, agents decide what it means.
