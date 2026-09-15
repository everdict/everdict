---
kind: wiki
title: "Agent automation — platform-triggered agents, fleet observability, and the crafting studio"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/platform-event.ts, packages/contracts/src/harness/agent-spec.ts, apps/agent/src/agent-activation.ts, apps/api/src/api/approval/approval.routes.ts, packages/application-control/src/agent/first-party-agents.ts]
---
# Agent automation — platform-triggered agents, fleet observability, and the crafting studio

> Generalizes [agent-teams.md](./agent-teams.md) (teammates + event bridge) and
> [agent-conversations.md](./agent-conversations.md) (the chat runtime). The platform's fact stream itself is
> described in [event-plumbing.md](./event-plumbing.md); the run ledger an activation writes to in
> [execution-model.md](./execution-model.md).
>
> **Intent (maintainer):** the agent must not exist only as a chat session in the right panel. Everdict's
> agents (a) watch a scorecard from submission through dispatch to completion and *respond along the way*,
> and (b) after judging, take the failed cases — with full harness + dataset context — root-cause them,
> change real code, and contribute a PR. Many such agents run across the platform, so their activity must be
> **observable**; the events that activate them are **systematized**, and members **craft** agents —
> create, experiment, improve, and verify them.

## The building blocks

| Block | What it gives | Where |
|---|---|---|
| Chat runtime | loop, tools, compaction, SSE, transcript persistence | `packages/agent-runtime` + `apps/agent` |
| Teammates | long-lived sessions, mailbox wake, per-teammate serialization | `apps/agent/src/teammate-supervisor.ts`, `apps/agent/src/teammate-turn.ts` |
| Event bridge | control plane pushes facts to the agent service | `AgentEventSink` → `POST /agent/events` |
| Request-less auth | `agt_` tokens, `Principal.via:"agent"`, acts-as-creator | [agent-execution-auth.md](./agent-execution-auth.md) |
| Permission modes | `default` / `auto` / `bypass` / `plan` per session + HITL prompt + rules | `apps/agent/src/action-policy.ts`, `apps/agent/src/permission-registry.ts` |
| AgentSpec registry | versioned `(tenant,id,version)` config: instructions, MCP servers, capabilities, model, triggers | `packages/contracts/src/harness/agent-spec.ts` |
| Skills + capabilities | workspace-owned procedures, store-adopted tools, try-drive | [capability-store.md](./capability-store.md) |
| Usage metering | per-conversation `priceUsd` meter + budgets | [usage-metering.md](./usage-metering.md) |
| Code contribution | `open_github_pr`, GitHub App repos, the `scorecard-fix-pr` store example | integrations |

## Concepts (five nouns)

1. **Platform event** — an immutable *fact* the control plane records at a lifecycle point
   (`PlatformEventRecord`: `id`, `tenant`, `kind`, `subject {type, id}`, `actor?`, `payload`, `causedBy?`,
   `message`, `createdAt`, plus the log's `seq`). Facts only — inference ("regressed", "flaky") stays agent-side.
2. **Agent** — a crafted, versioned `AgentSpec`: identity + instructions + tools + model **+ `triggers` +
   `task` + default `permissionMode` + `budgetUsd` + `enabled`**. The unit members create, iterate, and verify.
3. **Agent run** — one activation: a session with `origin` (`chat` / `discussion` / `teammate` / `trigger` /
   `schedule` / `api`) and a headless-run `status`, recorded on the universal run ledger as a
   `Run{kind:"agent"}` (the session's `runId` points at the latest). The unit of observability.
4. **Parked approval** — a persisted permission request from a headless run; a member (or expiry) decides it.
   Decouples HITL from an open SSE stream.
5. **Fleet view** — the workspace-level surface listing agent runs live: who is running, why, what they are
   doing, plus a stop control.

## Architecture

```
control plane (apps/api)                          agent service (apps/agent)
┌───────────────────────────┐                    ┌──────────────────────────────────┐
│ lifecycle emit points     │  push (best-effort)│ AgentActivator                   │
│  scorecard.submitted      │──────────────────▶│  enabled AgentSpecs × event kind  │
│  scorecard.case.completed │  + seq cursor      │  + filter → activation           │
│  scorecard.completed ...  │◀──────────────────│                                  │
│           │               │  reconcile (pull)  │ agent run                        │
│           ▼               │                    │  session{origin:trigger,status}  │
│ everdict_platform_events  │                    │  headless loop, agt_ principal   │
│  = outbox + audit + replay│                    │  mode-derived permit or PARK ────┼──▶ parked approval
└───────────────────────────┘                    │           │                      │    (decide → deliver/resume)
            ▲                                    │           ▼                      │
   agent.run.* lifecycle facts ◀─────────────────│ lifecycle reporting              │
   (event log, fleet view)                       └──────────────────────────────────┘
```

- **Emit points stay in the control plane** (it owns the facts); **matching + execution stay in the agent
  service** (it owns agent identity and the loop). The control plane emits workspace-scoped events; the agent
  service resolves subscribers from the registry. A `recipient` on an internal event additionally fans it to
  that member's chat-spawned teammates.
- **Durability ladder, not a message broker.** Events persist in `everdict_platform_events` (append-only).
  Push is best-effort; the agent service walks the deployment-wide `seq` cursor over `GET /internal/events`
  to reconcile missed events. At-least-once, collapsed by the durable per-(agent, event) dedup on the session
  record — no Kafka, no new infra.
- **Loop prevention by provenance.** Agent-caused facts carry `causedBy: agent:<agentId>:<conversationId>`,
  and a trigger does **not** match an event its own agent caused. Per-(agent, kind) cooldown and the causal
  depth guard at admission bound the rest. `agent.run.*` lifecycle facts are not trigger-matchable
  (`TRIGGERABLE_EVENT_KINDS` excludes them).

## Pillar A — the automation substrate

### A1. Event contract + persisted log (control plane)
> **Generalized by [event-plumbing.md](./event-plumbing.md)** — the log is the platform's one fact stream
> (structural emission from domain transitions, reactors as durable-cursor consumers, coverage waves, the §5
> admission coupling).

`PlatformEventRecord` + the closed `PLATFORM_EVENT_KINDS` vocabulary in
`packages/contracts/src/records/platform-event.ts`; the `everdict_platform_events` table (mig 0085, indexed by
`(tenant, seq)` and `(tenant, kind, seq)`); the `PlatformEventStore` port and `PlatformEventService`
(`packages/application-control/src/platform-event/platform-event-service.ts`) — the one emit seam: append to the
log, then push through the `AgentEventSink`, both best-effort so emitting can never affect the business result.
Feed/Mattermost notifications stay in `NotificationService`, a reader beside the log. The agent service reads
`GET /internal/events`; members read `GET /events` + MCP `list_platform_events` (`events:read`, viewer+).

### A2. Fact kinds
The vocabulary is closed and grows with emit points (`PLATFORM_EVENT_KINDS`). The lanes an agent most often
subscribes to: eval (`scorecard.submitted` · `scorecard.case.completed` with caseId + verdict ·
`scorecard.completed|failed|cancelled` · `run.submitted|completed|failed` · `schedule.fired`), collaboration
(`comment.created`, `task.created|completed`), registry (`harness|dataset|judge.registered`), and ops
(`budget.exceeded` · `run.placement_blocked` · `runtime.circuit_opened`). Payloads are **minimal pointers**
(ids + status + counts), never full documents — the agent reads detail through its MCP tools, which keeps RBAC
authoritative at read time.

### A3. Registry-driven activation (agent service)
`AgentActivator` (`apps/agent/src/agent-activation.ts`): on an event, find the workspace's enabled agents whose
trigger matches — `kinds` + declarative `filters` in the shared selector grammar
(`packages/contracts/src/records/event-selector.ts`, e.g. `{ field: "passRate", op: "lt", value: 1 }`) — then
create an agent run (new session, `origin: { type: "trigger", agentId, agentVersion, eventId, eventKind }`),
seed the rendered event + the agent's standing `task`, and run headless turns under a one-shot `agt_` token
revoked with the run. Subscriptions live in the registry (DB), so activation is restart-safe. Runs serialize per
agent; activations queued beyond `maxQueued` (default 3) are dropped and logged; the per-(agent, kind) cooldown
defaults to 30 s. Workspace subscriptions (E3) reach the same launch path with their own cooldown.

Chat-spawned teammates are a second front door over the same turn function (`runTeammateTurn`); their roster
is persisted on the session row (`AgentSessionRecord.teammate`) and restored on boot with re-minted tokens.

### A4. Agent-run identity
> **Superseded in direction by [execution-model.md](./execution-model.md):** an activation is a
> `Run{kind:"agent"}` on the universal run ledger, and the session stays the conversation it always was.

`AgentSessionRecord` carries `origin` + `status` (mig 0086) and `runId` (the latest ledger run). Status
transitions are owned by the agent service's run wrapper.

### A5. Lifecycle facts + fleet view (web)
The agent service reports `agent.run.started|awaiting_approval|suspended|completed|failed` to the control plane,
which records them on the event log and maintains the run ledger. A **terminal** report carries the transcript
projected as `TraceEvent[]` (`transcriptToTrace`, `apps/agent/src/run-trace.ts`), sealed as the run's own
trajectory — `GET /runs/:id/trajectory` serves agent runs with no extra surface. `agent.run.*` facts do not
reach the notification bell.

Web: the top-level **Agents** page (`/[workspace]/agents`, `features/agent-fleet`) — the workspace-wide run feed,
transcript drill-in, inline Allow/Deny for parked asks, and stop (`POST /agent/runs/:id/stop`). Disabling an agent
is saving it with `enabled: false`.

### A6. Parked approvals
A headless run gets a mode-derived permit: `bypass` allows, `auto` parks only guarded actions, `default` and
`plan` park every mutation; with no approval channel it denies (fail-closed). A park registers durably on the
control plane (`POST /internal/approvals` → `everdict_approvals`, mig 0094; `approval.requested` /
`approval.decided` facts) and waits in-process up to the record's `expiresAt` (default 7 days,
`packages/application-control/src/approval/approval-service.ts`). Members list and decide through
`GET /approvals` + `POST /approvals/:id/decide` (↔ MCP `list_approvals` / `decide_approval`;
`agents:read` / `agents:write`); a decision reaches the live wait via `POST /internal/deliver-approval`. The
`everdict-approval-<id>` workflow owns deny-on-expiry. A decision that lands on a dead park (agent-service restart)
resumes the run as one continuation turn on the same session (`POST /internal/resume-approval` →
`AgentActivator.resumeApproval`): the transcript is the durable state, and an approve pre-authorizes exactly one
re-ask of the parked tool. The fleet's `GET /agent/sessions/:id/pending` → `POST .../permission` channel still
works; the post-wait settle converges the ledger either way, first write wins.

### A7. Safety rails
- **Budget** — `AgentSpec.budgetUsd` becomes the activation run's delegated envelope (execution-model §5.2):
  every scorecard/run the agent causes passes the causal admission leg
  (`packages/application-control/src/admission/admission.ts` — 402 past the cap, 429 past the causal depth of 8,
  400 for a forged causer id), and children settle real cost against it (`everdict_envelopes`, mig 0096). The
  agent's own turn tokens meter to the tenant budget only.
- **Kill switch** — stopping an agent run cascades: every non-terminal batch it caused cancels through the normal
  teardown (`ScorecardService.cancelCausedBy`).
- Cooldown per (agent, kind), durable per-(agent, event) dedup, `maxQueued` backpressure (A3).

## Pillar B — the crafting studio

### B1. AgentSpec v2 + many agents
`AgentSpec` carries `triggers: [{ kinds, filters }]` · `task` (standing instructions rendered on activation,
distinct from `instructions`, which shape every turn) · `permissionMode` (default for its runs) · `budgetUsd` ·
`enabled`. `AGENT_CONFIG_ID` stays the chat default; triggered runs pin `agentId@version` in `origin`.

### B2. Authoring surface — conversational, not a wizard
`/[workspace]/agents/craft` mirrors the analysis studio: the LEFT canvas is the agent being built, the RIGHT chat
panel shapes it multi-turn. The crafting chat holds `craft_agent` (patches the draft; streamed as the SSE
`agent_draft` event and applied live by the canvas) and `try_agent_draft` (shadow-runs the current draft inside
the conversation); the web sends the live draft with each turn, so refinement grounds on manual edits too. The
canvas carries a replay-try panel (recent events via `GET /events`) and Save (`PUT /agents/:id`, preserving the
spec's tool channels). The crafted agent is pure declaration over the one shared loop — `resolveProfile` is the
factory, the registry is the store of builds, and the crafting conversation is the builder.

### B3. Try-drive: experiment before enabling
`POST /agent/agents/try` replays a real (or hand-built) event at a saved agent or a draft in **shadow mode** —
the kernel's `ExecutionMode` `{ kind: "shadow" }` (`packages/agent-runtime/src/kernel/execution-mode.ts`),
decided at the invocation point: only tools the agent service can attest as first-party pure reads run live;
every mutation and every workspace-registered server's tool is captured as would-have-done (`wouldHave`) instead
of executed. The event log is what makes this possible — replay is a query, not a fixture.

### B4. First-party templates
`scorecard-sentinel` and `failure-fix-pr` (`packages/application-control/src/agent/first-party-agents.ts`) are
seeded into `_shared` at control-plane boot — disabled and creator-less, so they can never activate there. A
workspace adopts one by saving a copy under its own tenant (`PUT /agents/:id`).

### B5. Agent evals — Everdict evaluates its own agents
A try returns its transcript as a normalized `TraceEvent[]`; the recipe is N scenario tries →
`POST /scorecards/ingest` (one case per try) → judges → a scorecard diffable across agent versions.

The loop is drivable BY an agent: `POST /internal/try` on apps/agent (internal-token gated; tools run under a
one-shot `agt_` token for the named member, revoked when the try returns) is relayed by the control plane as the
**`try_agent` MCP tool** (`agents:write`; same shadow semantics). The first-party example skill **`agent-evolve`**
turns those parts into a campaign: baseline N shadow tries per scenario as trials (`ingest_scorecard` with
repeated caseIds, `harness: {id: "agent:<id>"}`), read the trial summary's flake/variance as the noise floor,
mutate one hypothesis per round, judge the candidate with `diff_scorecards`' statistically gated trials diff, and
adopt only over a significant held-out win — adoption is `save_agent` (a new immutable version) behind HITL.

## Flagship scenarios

1. **Scorecard Sentinel** — triggers on `scorecard.submitted`, `scorecard.case.completed`,
   `scorecard.completed|failed`. Watches a batch through dispatch (queue position, runner health via MCP reads),
   reacts mid-batch to case failures, retries transient infra failures (`retry_scorecard` under `auto`), posts a
   completion/anomaly summary.
2. **Failure Fix PR** — triggers on `scorecard.completed` filtered to `passRate lt 1`. Drills failed cases
   (`get_scorecard_analysis`, traces, dataset case, harness spec), root-causes, changes code in the linked repo
   (GitHub App + code tools + the `scorecard-fix-pr` skill), opens a PR (`open_github_pr`), and comments the link
   on the scorecard.

## Choices made

1. **Automated-run identity** — acts-as-member (`agt_` token for the enabling member, RBAC-true) rather than a
   per-agent principal; the run's `origin.agentId` attributes the actor in the UI.
2. **Trigger matching locus** — the agent service (registry read + execution + concurrency in one place); the
   control plane stays subscriber-agnostic.
3. **Cron triggers** — reuse control-plane Schedules: `schedule.fired` is an ordinary triggerable kind.
4. **Shadow-mode fidelity** — shadow replay captures intent, not real side effects.

## Current bounds

- **No per-run outcome roll-up** (turns/tool calls/cost on the record) — cost is metered through the usage bridge;
  the fleet shows status, not per-run cost.
- **Canvas editing is partial** — trigger filters are authored by the chat (the canvas shows/removes them), and
  MCP servers/capabilities are edited on the agent settings detail (`/[workspace]/settings/agent/[id]`), not the canvas.

## Non-goals / guardrails

- **Not a message broker.** The event log is a table + cursor, not Kafka.
- **Not ungoverned autonomy.** Every automated run is bounded by permission mode + guarded-action class + RBAC +
  budget envelope + provenance loop guards; `bypass` is a per-agent explicit choice inside a budget.
- **Not a second agent runtime.** Triggered runs reuse the loop, mailbox, and permission machinery — activation is
  a front door, not an engine.
- **Facts, not inference, from the control plane.** A regression judgment stays agent-side (diff via MCP).
