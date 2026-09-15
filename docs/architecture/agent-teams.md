---
kind: wiki
title: "Agent teams — message-based collaboration + proactive agents over the eval control plane"
status: current
updated: 2026-09-15
anchors: [apps/agent/src/agent-mailbox.ts, apps/agent/src/teammate-supervisor.ts, packages/agent-runtime/src/tools/send-message-tool.ts, packages/contracts/src/records/agent-task.ts, apps/agent/src/action-policy.ts]
---
# Agent teams — message-based collaboration + proactive agents over the eval control plane

> Everdict's *own* agent beyond the single conversational assistant. Extends
> [agent-conversations.md](./agent-conversations.md) (the single-agent runtime — kernel, tools, sub-agents)
> and generalizes [notifications.md](./notifications.md) (the per-user event feed) into messages. Registry-crafted,
> trigger-activated agents are the successor surface, described in [agent-automation.md](./agent-automation.md).
>
> **Intent (maintainer):** (1) the agent **drives eval directly** — it runs harnesses/scorecards, not just talks
> about them; (2) **collaboration between autonomous agents is central** — teammate messaging; (3) **everything
> Everdict monitors becomes message-based**, so a **proactive agent team** can watch the platform and act.

## Principles

1. **One envelope, many sources.** A user steering note, a teammate's message, and a platform event are the same
   kind of thing — an addressed message with a sender. They flow through one substrate and the loop's one
   `drainInput` seam, rendered with attribution so the model knows who is speaking.
2. **Addresses, not call stacks.** Collaboration is routing to a recipient (a session / a teammate), not a nested
   function call. `spawn_agent` (call-stack delegation) stays for scoped fan-out; teammates are longer-lived
   addressable participants.
3. **Proactive = an event wakes an agent.** Monitoring is message production; a subscribed agent is woken to react.
4. **Autonomy is gated.** An agent driving eval calls the same MCP tools a human would, as its own authenticated
   principal, behind the session's permission mode and the control-plane RBAC.

## Architecture

```
              ┌──────────── AgentMailbox (per workspace × session, in-process) ────────────┐
  user ──────▶│  envelope { from: user|agent|event, sender?, content }                     │
  teammate ──▶│  addressed by (workspace, sessionId)                                       │──▶ drainInput ─▶ loop turn
  platform ──▶│  attribution-rendered on drain                                             │
              └────────────────────────────────────────────────────────────────────────────┘
                     ▲                                   ▲
        send_message tool (agent→agent)      POST /agent/events (control plane → watching teammates)
```

### The message substrate
`AgentMailbox` (`apps/agent/src/agent-mailbox.ts`): `enqueue(workspace, sessionId, envelope)` /
`drain(workspace, sessionId) → ChatMessage[]`. The envelope carries `from` (`user` | `agent` | `event`), an optional
`sender`, and `content`. Drain renders attribution: user → verbatim; agent → `[Message from teammate <sender>]`;
event → `[Everdict event — <sender>]`. `POST /agent/sessions/:id/input` enqueues a `from: user` message;
`POST /agent/sessions/:id/event` an `event`-attributed one. The mailbox is in-memory — a message not yet drained
does not survive an agent-service restart.

### Agent-to-agent: `send_message`
A kernel tool (`packages/agent-runtime/src/tools/send-message-tool.ts`) with two reaches:
- **Background sub-agents** — each running `spawn_agent run_in_background` delegate has an in-kernel inbox; the
  parent's `send_message(to: 'bg-N', message)` routes into it and the sub-agent drains it at its next step
  (attributed `[Message from the delegating agent]`). Delivery to a finished/unknown id is a soft error. The reverse
  direction is the existing result fold-in.
- **Other conversations** — with the host's `sendMessage` seam wired, `to` may be another session the caller owns
  (teammates included); it is delivered `from: agent` and wakes the recipient if it is a teammate. This reach is an
  effect outside the task, so the tool is then `isReadOnly: false` and goes through the permission gate.

### Teammates
A teammate is a named, long-lived session that runs autonomously. `TeammateSupervisor`
(`apps/agent/src/teammate-supervisor.ts`) owns only WHEN a turn runs: a message landing in a teammate's mailbox
wakes a turn, turns are serialized per teammate, and mid-turn wakes coalesce into one follow-up. The turn itself is
`runTeammateTurn` (`apps/agent/src/teammate-turn.ts`) — request-less, authenticated by the teammate's own `agt_`
token ([agent-execution-auth.md](./agent-execution-auth.md)), which acts AS the creator with `write` scope.

- `POST /agent/teammates {name, task, watch?}` and the `spawn_teammate` agent tool share one path: mint the token
  (`issueAgentToken`), create the session (`origin: {type: "teammate"}`), persist the teammate config on the session
  row, register with the supervisor, seed the standing task, and wake it. `spawn_teammate` is a guarded action — it
  asks even in `auto` mode.
- `GET /agent/teammates` lists the caller's teammates; `DELETE /agent/teammates/:id` stops one (unregister + revoke
  its token; the transcript is kept). The `list_teammates` tool gives an agent the same roster.
- **Restart survival.** The roster's durable half is `AgentSessionRecord.teammate`; on boot the agent service
  re-registers every standing teammate, re-mints its token, and revokes the stale key — without waking it.
- **Web.** The Team menu in the chat header (`apps/web/src/features/agent-chat/ui/team-menu.tsx`, over the BFF routes
  under `apps/web/src/app/api/agent/teammates/`) lists, spawns (name + standing task + watched kinds), and stops
  teammates.
- Teammates are not grouped into a named team; a teammate belongs to its creator within one workspace.

### Event bridge (monitoring → agent inbox)
A teammate subscribes to event kinds (`watch`). `POST /agent/events {kind, source, message, payload?}` fans an
event out to the caller's teammates that watch that kind — delivering it into each mailbox and waking it
(`notified` counts them). The same route has an internal branch (`x-internal-token` = `AGENT_INTERNAL_TOKEN`) where
the control plane presents `{workspace, recipient?}`: a `recipient` fans the event to that member's watching
teammates, and every internal event is also offered to registry-driven activation and to conversations parked on a
wake intent (the response reports `notified`, `activated`, `resumed`).

On the control plane, `PlatformEventService`
(`packages/application-control/src/platform-event/platform-event-service.ts`) appends each fact to the event log and
pushes it through an `AgentEventSink` (`apps/api/src/infrastructure/agent/agent-event-sink.ts`, an HTTP client to
`/agent/events`, wired when `AGENT_SERVICE_URL` + `AGENT_INTERNAL_TOKEN` are set) — best-effort, so an unreachable
agent never affects the result. The control plane emits facts only; a regression judgment belongs in the agent (a
watcher diffs via MCP `diff_scorecards`).

### Task ledger — the durable half of coordination
The mailbox coordinates the *conversation*; the **workspace task ledger** coordinates the *work*.
`AgentTaskRecord` (`packages/contracts/src/records/agent-task.ts`: subject · description · status
`pending → in_progress → completed | cancelled` · owner · informational `blockedBy` chains · `output` · agent-attributed
`origin`; migs 0102 + 0130, workspace-shared — no private tier) behind `TaskService`, exposed on both transports:
`/tasks` routes and the `create_task` / `list_tasks` / `get_task` / `update_task` / `delete_task` MCP family (authz
`agents:read` / `agents:write`; delete = creator or admin). Lifecycle facts are emitted at the service choke point —
`task.created` / `task.claimed` / `task.completed` / `task.cancelled` — and **created/completed are
trigger-matchable**, the "new work appeared" / "a dependency cleared" wake-up pair. A `task.*` event fanned to a
teammate carries the task id, and `task.created` adds the claim → do → complete-with-`output` recipe. Loop safety: an
agent-created task stamps `causedBy agent:<id>:<conv>` (the creator never wakes on its own task); claiming without
naming an owner records the claimer. The web board is `/[workspace]/agents/tasks` — the fleet page shows the RUNS,
the board shows the WORK.

### The agent drives eval — bridge-all + permission modes
The agent's base tool surface is the WHOLE control-plane MCP catalog, mutations included; only the runner
wire-protocol tools are excluded (`isProtocolTool` in `apps/agent/src/action-policy.ts`). Every mutation is decided
by the session's **permission mode** — `default` (ask every time) · `auto` (ask only guarded destructive /
governance / credential actions, `isGuardedAction`) · `bypass` (never ask) · `plan` (read-only until the plan is
approved) — on top of the control-plane RBAC. The mode lives on the session (`AgentSessionRecord.permissionMode`,
chat-header picker) with a per-turn `body.mode` override. This replaced an earlier curated opt-in allowlist
(`AGENT_ALLOW_EVAL_DRIVE`): safety moved from "the agent never sees the verb" to "the member's mode decides per call".
Write actions dispatch through the orchestrator's own isolation; there is no separate worktree isolation for local
file work.

## Non-goals / guardrails

- Not a new execution engine — teammates and proactive runs reuse the loop and the dispatch paths.
- Not ungoverned autonomy — write capability is always behind the permission modes and the control-plane RBAC; an
  agent can never exceed its principal's role.
- Not a broadcast free-for-all — `send_message` reaches only the caller's own sessions, and event fan-out reaches
  only the recipient's teammates that watch that kind.
