# Agent teams — message-based collaboration + proactive agents over the eval control plane

> **Status: doc-first SSOT (2026-07-24).** The product direction for Everdict's *own* agent beyond the
> single conversational assistant. Successor/extension of
> [agent-conversations.md](./agent-conversations.md) (the single-agent runtime — kernel, tools, sub-agents)
> and the message-based generalization of [notifications.md](./notifications.md) (the per-user event feed).
>
> **Vision (maintainer, verbatim intent):** (1) the agent must be able to **drive eval directly** — Everdict
> evolves so its own agent runs harnesses/scorecards, not just talks about them; (2) **collaboration between
> autonomous agents is central** — teammate messaging; (3) **everything Everdict monitors becomes
> message-based**, so a **proactive agent team** can watch the platform and act.

## Where we are (the seeds already in the kernel)

The single-agent runtime already ships the primitives this direction composes from — nothing here is a
rewrite, it is a generalization:

- **`drainInput` seam** (`kernel/loop.ts`) — the loop absorbs externally-supplied messages at each turn
  boundary. Today the host feeds it *user* steering; it is source-agnostic by construction.
- **`InputQueue`** (`apps/agent`) — a per-session inbox the streaming turn drains. The nascent **mailbox**.
- **Background sub-agents** (`spawn_agent run_in_background`) — detached agents whose results are **folded
  back into a later turn as a message**. Already message-shaped delivery, in-process.
- **`subagent_type` registry** — specialized delegate roles (explore/analyze). The seed of **named teammates**.
- **Permission modes + fine-grained rules** (`3e48d9f3`) — the governance an agent needs *before* it may
  drive eval (write tools) autonomously.
- **`notifications.md` feed** — the control plane already emits run/scorecard-completion events to a per-user
  feed. Those same events are the messages a proactive agent subscribes to.

The gap is not the loop — it is (a) a **shared message substrate** with addressing + attribution, (b) an
**agent-to-agent** channel over it, (c) a bridge from **monitoring events → agent messages**, and (d) the
**capability + isolation** for an agent to run eval work safely.

## Principles

1. **One envelope, many sources.** A user steering note, a teammate's message, and a "scorecard sc_123
   regressed" event are the *same kind of thing* — an addressed message with a sender. They flow through one
   substrate and one `drainInput` seam, rendered with attribution so the model knows who is speaking.
2. **Addresses, not call stacks.** Collaboration is routing to a recipient (a session / a named teammate / a
   team), not a nested function call. `spawn_agent` (call-stack delegation) stays for scoped fan-out;
   teammates are longer-lived addressable participants.
3. **Proactive = an event wakes an agent.** Monitoring is message production; a subscribed agent is woken to
   react. The trigger is the same substrate — no special path.
4. **Autonomy is gated, not ungoverned.** An agent driving eval uses write tools behind the permission
   modes/rules; file-mutating eval work runs under execution isolation (the orchestrator's existing sandbox).
5. **Reuse the control plane.** Everdict already dispatches/isolates/schedules eval jobs. An agent driving
   eval *calls the same MCP tools* a human would (`run_scorecard`, `pin_harness_images`, …) as its own
   authenticated principal — the RBAC + tenancy already bound it.

## Architecture

```
              ┌─────────────── message substrate (mailbox / bus) ───────────────┐
  user ──────▶│  envelope { to, from: user|agent|event, sender?, content, kind } │
  teammate ──▶│  addressed by recipient (session id / agent name / team)         │──▶ drainInput ─▶ loop turn
  monitoring ▶│  attribution-rendered on drain                                   │
              └──────────────────────────────────────────────────────────────────┘
                     ▲                                   ▲
        SendMessage tool (agent→agent)      event bridge (notifications feed → agent inbox)
```

- **Substrate.** `AgentMailbox` (generalized `InputQueue`): `enqueue(recipient, envelope)` / `drain(recipient)
  → ChatMessage[]`. Envelope carries `from` (user | agent | event), optional `sender`, and `content`. Drain
  renders attribution: user → verbatim; agent → `[message from teammate <sender>] …`; event →
  `[everdict event — <sender>] …`. **This slice is the foundation; it lands first (S1).**
- **Agent-to-agent (`send_message`).** A kernel tool (host-routed) that posts an envelope `{to, from:agent,
  sender:self}` to a recipient's mailbox. The recipient absorbs it via its own `drainInput`. Bounded like
  sub-agents (no unbounded broadcast without a cap).
- **Teammates.** Longer-lived agent sessions with a name + address, spawned into a **team** (a named group).
  Unlike a background sub-agent (fire-and-forget, folds one summary back), a teammate persists and exchanges
  messages. Built on the substrate + `send_message`.
- **Event bridge.** The control plane's notification emitter (`notifications.md`) also publishes to
  subscribed **agent** inboxes: a scorecard completes / regresses / a runtime queue backs up → an `event`
  envelope to the agents watching that workspace/harness. Opt-in subscription per agent/team.
- **Proactive trigger.** When an event lands in an idle agent's mailbox, the host **wakes a turn** (a
  triggered run, like a schedule fire) so the agent reacts without a human prompt. Reuses the scheduling
  path; the turn drains the event as its first message.
- **Agent drives eval.** The agent's tool surface gains the **write** control-plane tools (run/pin/schedule)
  behind the permission modes/rules; a harness-authoring or file-mutating task runs the eval through the
  existing dispatch → isolated job path (no new sandbox — the orchestrator already isolates).

## Roadmap (staged; each stage is shippable + testable on its own)

- **S1 — message substrate (attribution-aware mailbox).** Generalize `InputQueue` → `AgentMailbox` with typed
  envelopes + attribution rendering; add `POST /sessions/:id/event` (an `event`-attributed message). User
  `/input` becomes `from:user`. *No kernel change — attribution is rendered host-side into the drained
  content.* **← the first code slice, landing with this doc.**
- **S2 — `send_message` (agent→agent over the substrate).** Kernel `send_message` tool + host routing to a
  recipient mailbox; bounded. Enables two agents in one workspace to exchange messages.
  **First increment LANDED — bidirectional background sub-agents:** each running background sub-agent gets an
  in-kernel inbox; the parent's `send_message(to: 'bg-N', message)` routes into it and the sub-agent drains it
  at its next step (attributed `[Message from the delegating agent]`), turning fire-and-forget delegates into
  two-way collaborators. Deliveries to a finished/unknown id are a soft error. Reverse (sub→parent) is the
  existing result fold-in. Generalizing `send_message` to arbitrary session/teammate recipients is S3.
- **S3 — teammates + teams.** Named, longer-lived agent sessions in a team; `spawn_agent` gains a
  persistent-teammate variant; team roster storage. Collaboration beyond fan-out-and-summarize.
  **Execution-control core LANDED — `TeammateSupervisor`:** a teammate is a session the supervisor watches; when a
  message lands in its mailbox the supervisor **wakes a turn**, and turns are **serialized per teammate**
  (one at a time; mid-turn wakes coalesce into a single follow-up — no pile-up, no lost wake). This is the same
  "a message/event wakes an agent" primitive S5 (proactive) reuses. `runTurn(sessionId)` is injected (drain
  mailbox → run one agent turn); the supervisor owns only WHEN a turn runs, so it stays pure + unit-tested.
  **S3 is now LIVE end-to-end** (docs/architecture/agent-execution-auth.md landed the auth): `POST
  /agent/teammates {name, task}` mints the teammate's `agt_` token (`issueAgentToken`, acts AS the creator),
  creates its session, registers it with the supervisor, seeds the task, and wakes it — it runs a
  `runTeammateTurn` (authenticated request-less) that processes the task. A peer's `send_message` or a platform
  `/event` to a teammate's session `deliver()`s into its mailbox AND wakes it, so it reacts autonomously.
  The `spawn_teammate` agent TOOL is in too — an agent (not just the web) spawns a teammate (host `spawnTeammate`
  seam → the same `spawnTeammateFor`), so agents autonomously grow their own team and coordinate over
  `send_message`. The roster is in too: `GET /agent/teammates` (the caller's live teammates) + `DELETE
  /agent/teammates/:id` (stop — unregister + revoke its execution token; keeps the transcript). The **web
  surface is in too:** a Team menu in the chat header (`apps/web` `features/agent-chat/ui/team-menu.tsx` over
  two same-origin BFF proxy routes) lists the caller's teammates (name + watched kinds), spawns one (name +
  standing task + watched completion kinds), and stops one — with a roster badge that refreshes after each turn
  so a self-spawned teammate appears. **Remaining polish:** a named `team` grouping. The agent can also DISCOVER
  its team (a `list_teammates` tool over the roster) to coordinate over send_message. The core — persistent,
  addressable, autonomous, self-spawning, discoverable, collaborating, stoppable, human-visible agents — is in.
- **S4 — event bridge (monitoring → agent inbox). Agent-side LANDED.** A teammate subscribes to event kinds
  (spawn_teammate / POST /agent/teammates `watch: [...]`), and `POST /agent/events {kind, source, message}` fans
  the event out to the caller's teammates that watch that kind — delivering it (attributed) into each mailbox and
  waking it, so it reacts proactively (S5 too). Nothing watches the kind → notified:0. `/agent/events` also takes an INTERNAL
  path (`x-internal-token`, `AGENT_INTERNAL_TOKEN`): the control plane presents the shared secret + a
  `{workspace, recipient}` and the event fans to THAT recipient's watching teammates — so the emitter can drive
  events for any user without impersonating them. **S4 is now COMPLETE end-to-end:** the
  control plane's `NotificationService` (its third channel beside the feed + Mattermost) pushes a
  `run.completed`/`run.failed`/`scorecard.completed`/`scorecard.failed` event via an `AgentEventSink` (an HTTP
  client to `/agent/events`, wired when `AGENT_SERVICE_URL` + `AGENT_INTERNAL_TOKEN` are set) — best-effort, so
  an unreachable agent never affects the result. Everything Everdict monitors now auto-drives the proactive
  team: a run/scorecard completes → its creator's watching teammates wake and react. The **web surface for
  spawning/watching teammates is in** (S3 note). **Remaining:** only richer event kinds — and note that
  regression detection (`scorecard.regressed`) belongs in the AGENT (a watcher diffs via MCP `diff_scorecards`),
  not the control plane, which emits only facts (completed/failed). So the event model is already complete.
- **S5 — proactive triggers.** An event in an idle subscribed agent's mailbox wakes a turn (reuse the
  schedule-fire path). The proactive agent team is live.
- **S6 — agent drives eval (write capability).** Expose the write control-plane tools to the agent behind
  permission modes/rules; wire file-mutating eval work through the dispatch/isolation path (+ worktree
  isolation for local file work). The agent runs, not just discusses, evals.

  **Design (ready to drop in).** `apps/agent/mcp-tools.ts` already gates the base surface with an allowlist:
  read verbs (skip the HITL gate) + a curated `INTEGRATION_ACTIONS` set (Mattermost/CI/registry actions,
  bridged `isReadOnly:false` so the HITL gate approves each). S6 adds a sibling **`EVAL_ACTIONS`** curated
  allowlist — the eval-driving verbs — exposed **opt-in** (`AGENT_ALLOW_EVAL_DRIVE`, default off; the default
  agent stays read-only). When on, `isDefaultBaseTool` also admits `EVAL_ACTIONS` and `isBaseToolReadOnly`
  excludes them (→ every call is HITL/plan/rule-gated). Concrete `EVAL_ACTIONS`:
  - runs/scorecards: `run_scorecard` · `retry_scorecard` · `rerun_scorecard` · `cancel_scorecard` ·
    `ingest_scorecard` · `pull_scorecard` · `submit_run` · `backfill_scorecard_models`
  - harness/dataset/judge/model/runtime authoring: `register_harness` · `register_harness_template` ·
    `pin_harness_images` · `create_dataset` · `create_judge` · `create_model` · `create_runtime` ·
    `set_{harness,dataset,judge,model,runtime}_version_tags` · `assign_harness_trace_{source,sink}` ·
    `set_harness_span_attr_mapping`
  - scheduling/ops/import/view: `create_schedule` · `update_schedule` · `control_runtime` ·
    `import_benchmark` · `import_harbor` · `import_terminal_bench` · `apply_bundle` · `create_view` ·
    `create_comment`

  **Excluded even with eval-drive on** (destructive/governance/secret — never the agent's job): `delete_*` ·
  `remove_*` · `revoke_*` · `unlink_*` · `set_secret` · `set_workspace_*` · `create_workspace` ·
  `delete_workspace` · `set_member_role` · `create_api_key` · `create_invite` · `pair_*` · `github_*` ·
  `link_ci_repository` · `set_budget_limit`. Backstop: the agent acts as its authenticated **principal**, so
  the control-plane RBAC blocks anything its role can't do regardless of the allowlist — the allowlist is
  defense-in-depth + intentional scoping, not the only guard.

  > **Status: S6 LANDED.** The `mcp-tools.ts` allowlist model (`INTEGRATION_ACTIONS`/`isDefaultBaseTool`/
  > `isBaseToolReadOnly`) is now committed; S6 extended it: `isDefaultBaseTool(name, allowEvalDrive)` also admits
  > `EVAL_ACTIONS` when `AGENT_ALLOW_EVAL_DRIVE=true` (default off → the agent stays read-only). Eval actions are
  > never read verbs, so they're always bridged `isReadOnly:false` → HITL/plan/rule-gated, RBAC-bounded. The
  > policy lives in `eval-actions.ts` (curated allowlist + disjoint-from-forbidden invariant). Remaining for a
  > fuller S6: file-mutating eval work under worktree isolation (the write control-plane actions above already
  > dispatch through the orchestrator's own isolation).

## Non-goals / guardrails

- Not a new execution engine — teammates and proactive runs reuse the loop + the scheduler/dispatch paths.
- Not ungoverned autonomy — write/eval-driving capability is always behind the permission layer (`3e48d9f3`)
  and the control-plane RBAC; a proactive agent can never exceed its principal's role.
- Not a broadcast free-for-all — `send_message` / event fan-out is capped like sub-agent concurrency.
