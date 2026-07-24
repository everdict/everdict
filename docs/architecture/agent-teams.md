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
- **S3 — teammates + teams.** Named, longer-lived agent sessions in a team; `spawn_agent` gains a
  persistent-teammate variant; team roster storage. Collaboration beyond fan-out-and-summarize.
- **S4 — event bridge (monitoring → agent inbox).** The notification emitter also routes to subscribed agent
  inboxes; subscription model per agent/team. Everything monitored is now an agent-consumable message.
- **S5 — proactive triggers.** An event in an idle subscribed agent's mailbox wakes a turn (reuse the
  schedule-fire path). The proactive agent team is live.
- **S6 — agent drives eval (write capability).** Expose the write control-plane tools to the agent behind
  permission modes/rules; wire file-mutating eval work through the dispatch/isolation path (+ worktree
  isolation for local file work). The agent runs, not just discusses, evals.

## Non-goals / guardrails

- Not a new execution engine — teammates and proactive runs reuse the loop + the scheduler/dispatch paths.
- Not ungoverned autonomy — write/eval-driving capability is always behind the permission layer (`3e48d9f3`)
  and the control-plane RBAC; a proactive agent can never exceed its principal's role.
- Not a broadcast free-for-all — `send_message` / event fan-out is capped like sub-agent concurrency.
