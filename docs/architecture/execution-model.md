---
kind: wiki
title: "The execution model — Run as the platform's universal execution record"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/run.ts, packages/domain/src/run/run.ts, packages/application-control/src/admission/admission.ts, apps/api/src/api/group/group.routes.ts, apps/agent/src/chat-run.ts]
---
# The execution model — Run as the platform's universal execution record

Every execution is one row on the run ledger: an eval case, an agent activation or chat turn, a workspace
file run, a held-open sandbox or browser. The record is `RunRecordSchema`
(`packages/contracts/src/records/run.ts`); the domain factories that stamp it are on `Run`
(`packages/domain/src/run/run.ts`). The universal fields were added by migration `0092` and are additive: a
row with no `kind` is an eval run written before they existed.

Code comments cite this page by section (§1–§7), by phase label (P0–P7) and by decision (O1–O10). Each label
is kept beside the part it names. Related pages: [event-plumbing.md](./event-plumbing.md) (facts and
subscriptions), [native-observability.md](./native-observability.md) (the trajectory store and the OTLP door),
[orchestration.md](../orchestration.md) (the Temporal workflows), [harness-playground.md](./harness-playground.md)
(harness sessions), [scorecards.md](../scorecards.md) (a batch's child runs).

## Why one ledger

Before this model, execution was recorded three different ways:

1. **`run` served only scorecards.** A harness could not be driven without a dataset or a judge, and scoring
   could not be attached after the fact. Experiments and detached scoring (§2) and the harness playground
   answer this.
2. **A run was terminal and alone.** Nothing said which runs belonged together or which run caused which.
   `group` and `origin.causedByRunId` (§1) answer this.
3. **Agent execution was a parallel ledger.** `AgentSessionRecord` carried its own origin and status, and the
   Files viewer's Run recorded nothing at all. Agent runs (§7) and `command` runs (§1) answer this.

The same split left governance lopsided: the eval dispatch path had budget admission and queue caps, while the
agent and file lanes — the ones that *cause* compute — had none. §5 is the one gate every lane now passes.

## 1. The Run record (P0)

| Field | Values | Notes |
|---|---|---|
| `kind` | `eval` · `agent` · `command` · `sandbox` · `analysis` | `analysis` is declared; no factory stamps it |
| `status` | `queued` · `running` · `suspended` · `succeeded` · `failed` | cancel settles `failed` with code `CANCELLED`; `suspended` = stopped without completing, and a resume is a new run |
| `class` | `interactive` · `background` · `batch` | §5.4 |
| `lifetime` | `task` · `session` | a `session` run is `running` while alive, not "in progress" |
| `origin` | `{cause, actor?, executor?, scheduleId?, eventId?, eventKind?, causedByRunId?}` | `cause` ∈ `member` · `schedule` · `event` · `run` · `ci` · `api`; the free-string `trigger` is still stamped beside it |
| `envelope` | `{id, capUsd?, capTokens?, capRuns?}` | the causal budget (§5.2); `capTokens` is declared and not enforced; unrelated to the ownership `TaskEnvelope` |
| `placement` | `{where: inline · driver · runtime, target?, isolation?}` | whose compute, how isolated |
| `attach` | `logs` · `exec` · `terminal` · `screen` · `cdp` · `tasks` | `attachChannelsFor` gives eval and command runs `logs`+`terminal` (`logs` only on a `self:` runner), stamped or derived on read; sessions stamp `exec`, plus `tasks` for a harness session |
| `group` | `{id, role: case · turn · child}` | generalizes `parentScorecardId`, which stays |
| `visibility` | `workspace` · `member` | who may read the run and its evidence (`runAudience`) |
| `session` | `{image, ttlSec, expiresAt, computeId?, closedReason?, …}` | session runs only (migration `0099`) |
| `lineage` | `{retryOf?, rescoreOf?, forkedFrom?}` | the column exists and nothing writes it; a batch retry records `origin.retryOf` on the scorecard instead |
| `outputs` | `{artifacts?, files?, summary?, exitCode?}` | written today only by command runs (`exitCode`, published `files`) |

The remaining columns on the same record — `ownerReplica`, `ownerEpoch`, `webhookUrl`, `executionId` — belong
to replica ownership and completion callbacks ([multi-replica.md](./multi-replica.md)).

What each lane stamps:

| Factory | Entry point | kind | class | lifetime | born | group |
|---|---|---|---|---|---|---|
| `Run.newQueued` | `POST /runs`, MCP `submit_run` | eval | interactive (background when caused) | task | queued | — |
| scorecard child (`packages/domain/src/run/scorecard-child.ts`) | a batch fan-out | eval | batch | task | queued | `{scorecardId, case}` |
| `Run.newAgentRun` | an agent activation | agent | background | task | running | `{sessionId, turn}` |
| `Run.newChatTurn` | a member-caused agent turn | agent | interactive | task | running | `{sessionId, turn}` |
| `Run.newFileCommand` | `POST /fs/executions`, MCP `run_file` | command | interactive | task | running | — |
| `Run.newSandboxSession` | `POST /sandboxes` | sandbox | interactive | session | running | — |
| `Run.newBrowserSession` | `POST /browser-sessions` | sandbox | interactive | session | running | — |
| `Run.newSessionCase` | `POST /sandboxes/:id/tasks` | eval | interactive | task | running | `{sessionRunId, case · turn}` |

For agent and session runs the `harness` column names the executable that ran: the agent id, the environment
or image, or `browser`.

## 2. Run groups (P1, P2 — decision O3)

A group is a `ScorecardRecord`; there is no separate table. `kind` is `scorecard` or `experiment` (migration
`0093`; absent = scorecard). `GET /groups/:id` returns the same record as `GET /scorecards/:id`.

- **Experiment (P1)** — `POST /groups` / MCP `run_experiment`: drive a harness over a registered dataset (its
  graders stripped) or a one-off `task`, `trials` times. No judges, no verdict, no leaderboard presence; the
  child runs and their trajectories are the result. Listed in the web app under `/experiments`.
- **Detached scoring (P2)** — `POST /groups/:id/score` / MCP `score_group`: apply judges over a succeeded
  group's child runs without re-executing them. Re-scoring a judge replaces its earlier verdicts; scoring an
  experiment promotes it to a scorecard. With Temporal wired the pass runs as `scoreGroupWorkflow`, otherwise
  in process ([orchestration.md](../orchestration.md)).
- **Conversations are not a group record.** An agent's turns share `group: {id: <sessionId>, role: "turn"}`,
  and the activity console (`apps/web/src/features/browse-activity`) collapses them into one conversation
  block, as it collapses a batch's children.

## 3. What causes a run (P7)

The shape is *platform event → subscription → run*. A `SubscriptionRecord` (`selector`, `reaction`,
`governance` — `packages/contracts/src/records/subscription.ts`, `/subscriptions`) reacts with an agent
activation, a webhook, or a `reactionWorkflow`. Schedule fires land `schedule.fired` on the log. Agent-spec
triggers still live on the agent spec and match with the same selector rule (`eventSelectorMatches`);
`POST /subscriptions/import-agent-triggers` copies them into the registry. Details:
[event-plumbing.md](./event-plumbing.md).

Causation is an edge on the record. Work an agent submits carries its current run id in the
`x-everdict-agent-run-id` attribution header and is stamped `origin.causedByRunId`; the admission gate refuses
(400) a causer that is not a run in the same workspace.

## 4. Runs that occupy compute — placement, lifetime, attach (P6)

**Attaching to an eval case.** `POST /runs/:id/exec` (MCP `exec_in_run`), the WS terminal behind
`POST /runs/:id/terminal-ticket`, `GET /runs/:id/screen` and `GET /runs/:id/logs`. Exec and the browser
takeover ticket (`POST /runs/:id/screen-ticket`) require the run's creator or an admin on top of `runs:read`
([live-observability.md](./live-observability.md)).

**Sandbox sessions.** `SandboxSessionService`
(`packages/application-control/src/session/sandbox-session-service.ts`), composed only when
`EVERDICT_SANDBOX_DRIVER=docker`. Routes `POST /sandboxes` · `/:id/exec` · `/:id/touch` · `/:id/close` ·
`/:id/tasks` · `/:id/snapshot` · `/:id/git/push`, with MCP twins (`create_sandbox`, `sandbox_exec`,
`touch_sandbox`, `close_sandbox`, `submit_sandbox_task`, …). The container is provisioned before the row is
written, so a failed provision leaves no record. Caps refuse at 429: `EVERDICT_SANDBOX_MAX_PER_TENANT`
(default 2), `EVERDICT_SANDBOX_MAX_PER_AGENT` (default 1), `EVERDICT_SANDBOX_MAX_TOTAL` (default 8), with the
tenant's last slot kept for a member. Every exec is appended to the session trajectory, sealed at teardown and
served by `GET /runs/:id/trajectory`. Harness sessions and conversations: [harness-playground.md](./harness-playground.md).

**Disposal is the invariant.** The hard deadline lives on the row (`session.expiresAt`). `sessionReaperWorkflow`
(`everdict-reaper-<runId>`) starts at create, is signalled on close, and at the deadline calls
`POST /internal/sandboxes/:id/reap`. `sweepOrphans` settles any row past its deadline with no live handle as
`orphaned` and removes the container by `session.computeId`.

**Browser sessions (O6).** `BrowserSessionService`
(`apps/api/src/core/browser-session/browser-session-service.ts`) keeps its own API (`/browser-sessions`) and
writes a `sandbox` session row through `Run.newBrowserSession`; default TTL 15 minutes.

Not built: a WS terminal into a sandbox session (exec only), and idle-time metering (O5).

## 5. The admission gate (P4)

**5.1 One gate.** Any lane that takes compute asks, in order: the causal leg, `admitCausedWork`
(`packages/application-control/src/admission/admission.ts`), when the work names a causer — causal depth below
8 (429), the causer envelope's in-flight runs below `EVERDICT_ENVELOPE_MAX_INFLIGHT` (default 1000, 429), the
envelope's spent `capUsd` and its atomic `capRuns` claim (402 each, announced as `budget.exceeded`); then the
tenant `BudgetTracker` (402); then, for dispatched eval work, the Scheduler's queue-depth caps (429). The lanes
that call `admitCausedWork` are the run submit, the scorecard and experiment submit, sandbox session create,
and the file run. Agent activations ask the tenant budget through `POST /internal/activations/admit` before a
run exists. The browser-session lane asks the tenant budget and its own caps only. A new lane that takes
compute without passing the gate is a bypass, and a bypass is a review-blocking defect.

**5.2 Delegated envelopes.** An activation of an agent with `budgetUsd` stamps `envelope: {id: <runId>, capUsd}`
on its run; runs it causes carry `{id}` and draw from that root. Spend is kept in the envelope ledger
(migration `0096`); `capRuns` claims are atomic (migration `0141`).

**5.3 Slow is scheduling, no is economics.** Work that fits the budget queues — the Scheduler is tenant-fair
with an aging guard — and is refused only for an exhausted budget (402) or a hit cap (429).

**5.4 Class rides the run.** A run caused by another run is stamped `background`; batch children `batch`.
Queue priority is still set per lane on the `CaseJob` (`interactive` for a single run, `batch` for fan-out).

**5.5 The causal tree is the kill switch (O8).** Cancelling an agent run (`POST /runs/:id/cancel`) cancels the
scorecard batches it caused (`ScorecardService.cancelCausedBy`). Other descendants — standalone runs, sessions
— are not walked, and there is no per-kind opt-out.

**5.6 Hold-open lanes share admission, not dispatch.** `Scheduler.dispatch` awaits a result, so a session
never enters its queue; session and browser lanes keep their own caps. On Nomad, the capacity probe counts
every `everdict-`-prefixed allocation, so a held-open session job consumes the capacity eval placement is gated
on.

## 6. The trajectory (P5)

A run's evidence is sealed in the owned `TrajectoryStore` (port
`packages/application-control/src/ports/trajectory-store.ts`; Postgres `packages/db/src/results/trajectory-store.ts`,
migration `0098`; ClickHouse `packages/db/src/results/clickhouse-trajectory-store.ts` when
`EVERDICT_CLICKHOUSE_URL` is set). A trajectory's `source` is `run`, `otlp` or `import`. An imported trace is
materialized before it is judged, so judges read our copy and the external id is provenance only. Eval rows
from before the store still embed `result.trace`; the run detail reads the embed first and falls back to the
sealed trajectory, and nothing is backfilled (O10). Replay recordings (`recordingRef`) stay beside the
trajectory rather than inside its seal (O9). The store, the OTLP door and segments are described in
[native-observability.md](./native-observability.md) and [otel-trace-model.md](./otel-trace-model.md).

## 7. Agents on the ledger (P3 — decisions O1, O2, O4)

- **The control plane owns the record (O4).** The agent service mints a run id per activation or turn and
  reports transitions to `POST /internal/agent-run-events`. `agent.run.started` opens the row — `Run.newAgentRun`
  for `cause: "event"` (the default), `Run.newChatTurn` for `cause: "chat"` — and a terminal report settles it.
  The session keeps the transcript and points at its latest run (migration `0095`).
- **Every turn is a run (O1).** `withTurnRun` (`apps/agent/src/chat-run.ts`) wraps each turn entry point: a
  typed chat turn and a comment-thread discussion turn as `chat`; a wake-up resume, a scheduled report turn and
  a teammate turn as `event`. The activation path opens its own run and is not wrapped. `chat` reports are kept
  off the event log.
- **A transcript is a trace (O2).** A terminal report carries the turn's spans (or its transcript as
  `TraceEvent[]`), sealed as the run's trajectory. The turn's token counters close the stream as one
  `llm_call`, which the control plane prices at seal (`priceUsd`), so `usage` is not zero for runs that spent.
- **Events keep the old spelling.** Lifecycle facts are still emitted as `agent.run.*`;
  `AGENT_RUN_EVENT_KIND_ALIASES` (`packages/contracts/src/records/platform-event.ts`) maps them to `run.*` for
  readers, and the family is not trigger-matchable.
- **Surfaces.** The activity console at `/runs` shows agent turns grouped by conversation. The Agents fleet
  page (`apps/web/src/app/[workspace]/agents/page.tsx`) still reads the agent service. Agents read runs
  through MCP `get_run` / `list_runs`, and a comment may target resource type `run`.

## Decisions

| | Decision | State |
|---|---|---|
| O1 | a chat turn is a run, grouped by conversation | built (§7) |
| O2 | an agent transcript is a trace | built (§7) |
| O3 | a group is a `ScorecardRecord` with a `kind` | built (§2) |
| O4 | the control plane owns the agent-run record | built (§7) |
| O5 | idle session time bills by wall clock | not built — sessions are bounded by TTL and caps |
| O6 | browser sessions fold into the ledger after sandboxes | built as rows; the API is unchanged (§4) |
| O7 | envelope = meter + headroom + in-flight cap | built, plus the atomic `capRuns` claim (§5.1) |
| O8 | cancellation cascades over non-terminal descendants | partial — caused scorecard batches only (§5.5) |
| O9 | recordings stay siblings of the trajectory | as built (§6) |
| O10 | no backfill of embedded traces; dual-read | as built (§6) |
